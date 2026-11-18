
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
    if (raw.length > 2_000_000) {
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version BIGINT NOT NULL DEFAULT 1
    )
  `);
  await pool.query(`ALTER TABLE gama_fitness_state ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gama_login_limits (
      ip_hash TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      blocked_until TIMESTAMPTZ
    )
  `);
}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
      return send(res, 500, {
        error: "Banco não configurado. Confira POSTGRES_URL ou DATABASE_URL na Vercel."
      });
    }

    if (!process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET.length < 32) {
      return send(res, 500, {
        error: "Configure SESSION_SECRET com pelo menos 32 caracteres."
      });
    }

    if (!process.env.GAMA_ADMIN_PASSWORD ||
        process.env.GAMA_ADMIN_PASSWORD.length < 10) {
      return send(res, 500, {
        error: "Configure GAMA_ADMIN_PASSWORD com pelo menos 10 caracteres."
      });
    }

    await ensureTable();

    const action = String(req.query.action || "");

    if (req.method === "POST" && action === "login") {
      const body = await readBody(req);
      const forwardedFor = req.headers["x-forwarded-for"];
      const clientIp = String(
        (forwardedFor || req.socket?.remoteAddress || "unknown")
      ).split(",")[0].trim().slice(0, 100);
      const ipHash = crypto.createHmac("sha256", process.env.SESSION_SECRET)
        .update("gama-login:" + clientIp).digest("hex");

      const lock = await pool.query(
        "SELECT blocked_until FROM gama_login_limits WHERE ip_hash = $1 AND blocked_until > NOW()",
        [ipHash]
      );

      if (lock.rowCount) {
        return send(res, 429, {
          error: "Muitas tentativas de acesso. Aguarde 15 minutos antes de tentar novamente."
        });
      }

      if (!safeEqual(body.password || "", process.env.GAMA_ADMIN_PASSWORD)) {
        const attempt = await pool.query(
          `INSERT INTO gama_login_limits
             (ip_hash, window_started_at, failed_attempts, blocked_until)
           VALUES ($1, NOW(), 1, NULL)
           ON CONFLICT (ip_hash) DO UPDATE SET
             failed_attempts = CASE
               WHEN gama_login_limits.window_started_at <= NOW() - INTERVAL '15 minutes'
               THEN 1
               ELSE gama_login_limits.failed_attempts + 1
             END,
             window_started_at = CASE
               WHEN gama_login_limits.window_started_at <= NOW() - INTERVAL '15 minutes'
               THEN NOW()
               ELSE gama_login_limits.window_started_at
             END,
             blocked_until = CASE
               WHEN CASE
                 WHEN gama_login_limits.window_started_at <= NOW() - INTERVAL '15 minutes'
                 THEN 1
                 ELSE gama_login_limits.failed_attempts + 1
               END >= 5
               THEN NOW() + INTERVAL '15 minutes'
               ELSE NULL
             END
           RETURNING blocked_until`,
          [ipHash]
        );

        if (attempt.rows[0]?.blocked_until) {
          return send(res, 429, {
            error: "Limite de tentativas atingido. Aguarde 15 minutos antes de tentar novamente."
          });
        }

        return send(res, 401, { error: "Senha incorreta." });
      }

      await pool.query("DELETE FROM gama_login_limits WHERE ip_hash = $1", [ipHash]);
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

    // BACKUP: exportação protegida pela sessão administrativa.
    if (req.method === "GET" && action === "backup") {
      const result = await pool.query(
        "SELECT payload, updated_at, version FROM gama_fitness_state WHERE id = $1",
        ["main"]
      );

      if (!result.rowCount) {
        return send(res, 404, {
          error: "Nenhum dado encontrado para backup."
        });
      }

      const backup = {
        format: "gama-fitness-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        databaseUpdatedAt: result.rows[0].updated_at,
        version: Number(result.rows[0].version),
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
        "SELECT payload, updated_at, version FROM gama_fitness_state WHERE id = $1",
        ["main"]
      );

      if (!result.rowCount) {
        return send(res, 200, { initialized: false, state: null });
      }

      return send(res, 200, {
        initialized: true,
        state: result.rows[0].payload,
        updatedAt: result.rows[0].updated_at,
        version: Number(result.rows[0].version)
      });
    }

    if (req.method === "PUT" && action === "state") {
      const body = await readBody(req);
      const state = body.state;

      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return send(res, 400, { error: "Dados inválidos." });
      }

      const serialized = JSON.stringify(state);

      if (serialized.length > 1_500_000) {
        return send(res, 413, {
          error: "Dados excedem o limite permitido."
        });
      }

      const expected = body.expectedVersion;

      let saved;
      if (expected === null || expected === undefined) {
        saved = await pool.query(
          `INSERT INTO gama_fitness_state (id, payload, updated_at, version)
           VALUES ($1, $2::jsonb, NOW(), 1)
           ON CONFLICT (id) DO NOTHING
           RETURNING updated_at, version`,
          ["main", serialized]
        );
      } else if (Number.isSafeInteger(expected) && expected > 0) {
        saved = await pool.query(
          `UPDATE gama_fitness_state
           SET payload = $2::jsonb, updated_at = NOW(), version = version + 1
           WHERE id = $1 AND version = $3
           RETURNING updated_at, version`,
          ["main", serialized, expected]
        );
      } else {
        return send(res, 400, { error: "Versão dos dados inválida." });
      }

      if (!saved.rowCount) {
        return send(res, 409, {
          error: "Os dados foram alterados em outro aparelho. Atualize os dados antes de continuar."
        });
      }

      return send(res, 200, {
        ok: true,
        updatedAt: saved.rows[0].updated_at,
        version: Number(saved.rows[0].version)
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
