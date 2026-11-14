
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

const COOKIE = "gama_session";
const SESSION_TTL = 60 * 60 * 24 * 7;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sign(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET)
    .update(value).digest("hex");
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    exp: Date.now() + SESSION_TTL * 1000
  })).toString("base64url");

  return payload + "." + sign(payload);
}

function validSession(req) {
  try {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map(x => x.trim())
      .find(x => x.startsWith(COOKIE + "="));

    if (!raw) return false;

    const token = decodeURIComponent(raw.slice(COOKIE.length + 1));
    const parts = token.split(".");

    if (parts.length !== 2 || !safeEqual(sign(parts[0]), parts[1])) {
      return false;
    }

    const data = JSON.parse(
      Buffer.from(parts[0], "base64url").toString()
    );

    return data.role === "owner" && data.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";

  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2000000) {
      throw new Error("Payload muito grande.");
    }
  }

  return raw ? JSON.parse(raw) : {};
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gama_fitness_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
      return send(res, 500, { error: "Banco não configurado." });
    }

    if (!process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET.length < 32) {
      return send(res, 500, { error: "SESSION_SECRET não configurada corretamente." });
    }

    if (!process.env.GAMA_ADMIN_PASSWORD ||
        process.env.GAMA_ADMIN_PASSWORD.length < 10) {
      return send(res, 500, { error: "Senha administrativa não configurada corretamente." });
    }

    await ensureTable();

    const action = String(req.query.action || "");

    if (req.method === "POST" && action === "login") {
      const body = await readBody(req);

      if (!safeEqual(body.password || "", process.env.GAMA_ADMIN_PASSWORD)) {
        return send(res, 401, { error: "Senha incorreta." });
      }

      res.setHeader("Set-Cookie", cookie(makeSession(), SESSION_TTL));
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "logout") {
      res.setHeader("Set-Cookie", cookie("", 0));
      return send(res, 200, { ok: true });
    }

    if (!validSession(req)) {
      return send(res, 401, { error: "Faça login para continuar." });
    }

    // BACKUP: exporta o estado completo do banco após autenticação.
    if (req.method === "GET" && action === "backup") {
      const result = await pool.query(
        "SELECT payload, updated_at FROM gama_fitness_state WHERE id = $1",
        ["main"]
      );

      if (!result.rowCount) {
        return send(res, 404, { error: "Ainda não existem dados para exportar." });
      }

      const backup = {
        format: "gama-fitness-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        databaseUpdatedAt: result.rows[0].updated_at,
        state: result.rows[0].payload
      };

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, private");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="gama-fitness-backup.json"'
      );

      return res.end(JSON.stringify(backup, null, 2));
    }

    if (req.method === "GET" && action === "state") {
      const result = await pool.query(
        "SELECT payload, updated_at FROM gama_fitness_state WHERE id = $1",
        ["main"]
      );

      if (!result.rowCount) {
        return send(res, 200, { initialized: false, state: null });
      }

      return send(res, 200, {
        initialized: true,
        state: result.rows[0].payload,
        updatedAt: result.rows[0].updated_at
      });
    }

    if (req.method === "PUT" && action === "state") {
      const body = await readBody(req);
      const state = body.state;

      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return send(res, 400, { error: "Dados inválidos." });
      }

      const serialized = JSON.stringify(state);

      if (serialized.length > 1500000) {
        return send(res, 413, { error: "Dados excedem o limite permitido." });
      }

      await pool.query(
        `INSERT INTO gama_fitness_state (id, payload, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
         SET payload = EXCLUDED.payload, updated_at = NOW()`,
        ["main", serialized]
      );

      return send(res, 200, {
        ok: true,
        updatedAt: new Date().toISOString()
      });
    }

    return send(res, 404, { error: "Rota não encontrada." });

  } catch (err) {
    console.error("GAMA API:", err);
    return send(res, 500, {
      error: "Falha interna na API. Confira os logs da Vercel."
    });
  }
};
