
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

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function verifyPassword(password, credential) {
  if (!credential || !credential.salt || !credential.password_hash) return false;
  return safeEqual(hashPassword(password, credential.salt), credential.password_hash);
}

function sign(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET)
    .update(value).digest("hex");
}

function makeSession(sessionVersion) {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    sessionVersion: Number(sessionVersion),
    exp: Date.now() + SESSION_TTL * 1000
  })).toString("base64url");

  return payload + "." + sign(payload);
}

async function validSession(req) {
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

    if (data.role !== "owner" || data.exp <= Date.now() ||
        !Number.isSafeInteger(data.sessionVersion)) return false;

    const credential = await pool.query(
      "SELECT session_version FROM gama_owner_credentials WHERE id = $1",
      ["owner"]
    );

    return credential.rowCount === 1 &&
      Number(credential.rows[0].session_version) === data.sessionVersion;
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
    CREATE TABLE IF NOT EXISTS gama_fitness_payments (
      payment_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      paid_at DATE NOT NULL,
      period_end DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migra os recebimentos que já existem no estado JSON para o livro financeiro,
  // sem duplicar lançamentos e sem alterar os dados originais.
  await pool.query(`
    INSERT INTO gama_fitness_payments
      (payment_id, student_id, amount, paid_at, period_end)
    SELECT
      p->>'id',
      p->>'aluno',
      COALESCE(NULLIF(p->>'valor', '')::numeric, 0),
      NULLIF(p->>'data', '')::date,
      NULLIF(p->>'periodoAte', '')::date
    FROM gama_fitness_state s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.payload->'pagamentos') = 'array'
        THEN s.payload->'pagamentos' ELSE '[]'::jsonb END
    ) p
    WHERE p->>'id' IS NOT NULL
      AND p->>'aluno' IS NOT NULL
      AND COALESCE(NULLIF(p->>'valor', '')::numeric, 0) > 0
      AND NULLIF(p->>'data', '') IS NOT NULL
    ON CONFLICT (payment_id) DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gama_login_limits (
      ip_hash TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      blocked_until TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gama_owner_credentials (
      id TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

      let credentialResult = await pool.query(
        "SELECT salt, password_hash, session_version FROM gama_owner_credentials WHERE id = $1",
        ["owner"]
      );
      let credential = credentialResult.rows[0] || null;
      let passwordOk = false;

      if (credential) {
        passwordOk = verifyPassword(body.password || "", credential);
      } else {
        if (!process.env.GAMA_ADMIN_PASSWORD || process.env.GAMA_ADMIN_PASSWORD.length < 10) {
          return send(res, 500, { error: "A senha inicial do administrador não está configurada corretamente." });
        }
        passwordOk = safeEqual(body.password || "", process.env.GAMA_ADMIN_PASSWORD);
        if (passwordOk) {
          const salt = crypto.randomBytes(16).toString("hex");
          await pool.query(
            "INSERT INTO gama_owner_credentials (id, salt, password_hash, session_version) VALUES ($1, $2, $3, 1) ON CONFLICT (id) DO NOTHING",
            ["owner", salt, hashPassword(body.password, salt)]
          );
          credentialResult = await pool.query(
            "SELECT salt, password_hash, session_version FROM gama_owner_credentials WHERE id = $1",
            ["owner"]
          );
          credential = credentialResult.rows[0] || null;
          passwordOk = verifyPassword(body.password || "", credential);
        }
      }

      if (!passwordOk || !credential) {
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
      res.setHeader("Set-Cookie", cookie(makeSession(Number(credential.session_version)), SESSION_TTL));
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "logout") {
      res.setHeader("Set-Cookie", cookie("", 0));
      return send(res, 200, { ok: true });
    }

    if (!await validSession(req)) {
      return send(res, 401, { error: "Faça login para continuar." });
    }

    // ALTERAÇÃO DE SENHA: armazena somente hash com salt e invalida as sessões anteriores.
    if (req.method === "POST" && action === "password") {
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");

      if (newPassword.length < 10 || newPassword.length > 128) {
        return send(res, 400, { error: "A nova senha deve ter entre 10 e 128 caracteres." });
      }
      if (newPassword === currentPassword) {
        return send(res, 400, { error: "A nova senha precisa ser diferente da senha atual." });
      }

      const current = await pool.query(
        "SELECT salt, password_hash, session_version FROM gama_owner_credentials WHERE id = $1",
        ["owner"]
      );
      if (!current.rowCount || !verifyPassword(currentPassword, current.rows[0])) {
        return send(res, 401, { error: "A senha atual está incorreta." });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      await pool.query(
        "UPDATE gama_owner_credentials SET salt = $1, password_hash = $2, session_version = session_version + 1, updated_at = NOW() WHERE id = $3",
        [salt, hashPassword(newPassword, salt), "owner"]
      );

      res.setHeader("Set-Cookie", cookie("", 0));
      return send(res, 200, { ok: true, message: "Senha alterada. Entre novamente com a nova senha." });
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


    // RESTAURAÇÃO: importa somente backups GAMA válidos e usa controle otimista de versão.
    if (req.method === "POST" && action === "restore") {
      const body = await readBody(req);
      const backup = body.backup;
      const state = backup && backup.state;
      const expected = body.expectedVersion;

      if (!backup || backup.format !== "gama-fitness-backup" ||
          !state || typeof state !== "object" || Array.isArray(state) ||
          !Array.isArray(state.planos) || !Array.isArray(state.alunos) ||
          !Array.isArray(state.checkins) || !Array.isArray(state.aulas) ||
          !Array.isArray(state.pagamentos) ||
          !state.cfg || typeof state.cfg !== "object" || Array.isArray(state.cfg)) {
        return send(res, 400, { error: "Arquivo inválido ou incompatível com o GAMA FITNESS." });
      }

      if (!Number.isSafeInteger(expected) || expected < 1) {
        return send(res, 400, { error: "Versão atual inválida. Atualize a página e tente novamente." });
      }

      const serialized = JSON.stringify(state);
      if (serialized.length > 1_500_000) {
        return send(res, 413, { error: "O backup excede o limite permitido." });
      }

      for (const p of state.pagamentos) {
        const amount = Number(p && p.valor);
        if (!p || !/^[a-zA-Z0-9_-]{6,100}$/.test(String(p.id || "")) ||
            !String(p.aluno || "") || String(p.aluno).length > 100 ||
            !Number.isFinite(amount) || amount <= 0 || amount > 1000000 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(String(p.data || "")) ||
            (p.periodoAte && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.periodoAte)))) {
          return send(res, 400, { error: "O backup contém um pagamento inválido. Nenhum dado foi alterado." });
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT version FROM gama_fitness_state WHERE id = $1 FOR UPDATE",
          ["main"]
        );
        if (!current.rowCount || Number(current.rows[0].version) !== expected) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Os dados online mudaram desde a última atualização. Atualize a página, gere um novo backup e tente novamente." });
        }

        const updated = await client.query(
          `UPDATE gama_fitness_state
           SET payload = $2::jsonb, updated_at = NOW(), version = version + 1
           WHERE id = $1 AND version = $3
           RETURNING version, updated_at`,
          ["main", serialized, expected]
        );
        if (!updated.rowCount) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Não foi possível confirmar a versão dos dados. Atualize a página e tente novamente." });
        }

        // Mantém o livro financeiro dedicado coerente com o histórico restaurado.
        await client.query("DELETE FROM gama_fitness_payments");
        for (const p of state.pagamentos) {
          await client.query(
            `INSERT INTO gama_fitness_payments
              (payment_id, student_id, amount, paid_at, period_end)
             VALUES ($1, $2, $3, $4::date, $5::date)`,
            [String(p.id), String(p.aluno), Number(Number(p.valor).toFixed(2)), String(p.data), p.periodoAte || null]
          );
        }

        await client.query("COMMIT");
        return send(res, 200, {
          ok: true,
          state,
          version: Number(updated.rows[0].version),
          updatedAt: updated.rows[0].updated_at
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    // RECEBIMENTO: registra o pagamento e atualiza o estado na mesma transação.
    if (req.method === "POST" && action === "payment") {
      const body = await readBody(req);
      const state = body.state;
      const payment = body.payment || {};
      const expected = body.expectedVersion;
      const paymentId = String(payment.id || "");
      const studentId = String(payment.aluno || "");
      const amount = Number(payment.valor);
      const paidAt = String(payment.data || "");
      const periodEnd = payment.periodoAte ? String(payment.periodoAte) : null;

      if (!state || typeof state !== "object" || Array.isArray(state) ||
          !Array.isArray(state.alunos) || !Array.isArray(state.pagamentos)) {
        return send(res, 400, { error: "Estado financeiro inválido." });
      }
      if (!/^[a-zA-Z0-9_-]{6,100}$/.test(paymentId) ||
          !studentId || studentId.length > 100 ||
          !Number.isFinite(amount) || amount <= 0 || amount > 1000000 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(paidAt) ||
          (periodEnd && !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd))) {
        return send(res, 400, { error: "Dados do recebimento inválidos." });
      }
      if (!Number.isSafeInteger(expected) || expected < 1) {
        return send(res, 400, { error: "Versão dos dados inválida." });
      }

      const student = state.alunos.find(a => String(a.id) === studentId);
      if (!student) return send(res, 404, { error: "Aluno não encontrado." });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT payload, version FROM gama_fitness_state WHERE id = $1 FOR UPDATE",
          ["main"]
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "O banco ainda não foi inicializado. Atualize a página." });
        }
        if (Number(current.rows[0].version) !== expected) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Os dados foram alterados em outro aparelho. Atualize antes de registrar o pagamento." });
        }

        const duplicate = await client.query(
          "SELECT payment_id FROM gama_fitness_payments WHERE payment_id = $1",
          [paymentId]
        );
        if (duplicate.rowCount) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Este recebimento já foi registrado. Atualize a página para conferir." });
        }

        const existsInState = state.pagamentos.some(p => String(p.id) === paymentId);
        if (existsInState) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Este recebimento já consta no histórico. Atualize a página." });
        }

        state.pagamentos.push({
          id: paymentId,
          aluno: studentId,
          valor: Number(amount.toFixed(2)),
          data: paidAt,
          periodoAte: periodEnd
        });
        student.venc = periodEnd || student.venc;
        if (periodEnd) student.pagoAte = periodEnd;

        const updated = await client.query(
          `UPDATE gama_fitness_state
           SET payload = $2::jsonb, updated_at = NOW(), version = version + 1
           WHERE id = $1 AND version = $3
           RETURNING version, updated_at`,
          ["main", JSON.stringify(state), expected]
        );
        if (!updated.rowCount) {
          await client.query("ROLLBACK");
          return send(res, 409, { error: "Os dados foram alterados em outro aparelho. Atualize antes de registrar o pagamento." });
        }

        await client.query(
          `INSERT INTO gama_fitness_payments
            (payment_id, student_id, amount, paid_at, period_end)
           VALUES ($1, $2, $3, $4::date, $5::date)`,
          [paymentId, studentId, amount, paidAt, periodEnd]
        );
        await client.query("COMMIT");
        return send(res, 200, {
          ok: true,
          state,
          version: Number(updated.rows[0].version),
          payment: { id: paymentId, aluno: studentId, valor: Number(amount.toFixed(2)), data: paidAt, periodoAte: periodEnd }
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
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
