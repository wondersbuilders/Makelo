import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export const SESSION_COOKIE = 'cma_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');

  if (alg !== 'scrypt') {
    return false;
  }

  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });

  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateCredentials(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return 'Enter a valid email address.';
  }

  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }

  if (password.length > 200) {
    return 'Password is too long.';
  }

  return null;
}

export function createAuth(db, config) {
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, role, suspended_at, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.id, u.email, u.role, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended_at IS NULL',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    insertApiToken: db.prepare('INSERT INTO api_tokens (token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?)'),
    apiTokenUser: db.prepare(
      'SELECT u.id, u.email, u.role, u.created_at FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.suspended_at IS NULL',
    ),
    listApiTokens: db.prepare(
      'SELECT substr(token_hash, 1, 8) AS id, name, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
    ),
    deleteApiToken: db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND substr(token_hash, 1, 8) = ?'),
  };

  // Dummy hash so failed logins for unknown emails take the same time as real ones.
  const dummyHash = hashPassword(randomToken());

  return {
    async signup(rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      const problem = validateCredentials(email, password);

      if (problem) {
        return { error: problem };
      }

      if (q.userByEmail.get(email)) {
        return { error: 'An account with that email already exists. Log in instead.' };
      }

      const info = q.insertUser.run(email, await hashPassword(password), now());

      return { user: q.userById.get(info.lastInsertRowid) };
    },

    async login(rawEmail, password) {
      const email = normalizeEmail(rawEmail);
      const row = q.userByEmail.get(email);
      const ok = await verifyPassword(String(password || ''), row ? row.password_hash : await dummyHash);

      if (!row || !ok) {
        return { error: 'Wrong email or password.' };
      }

      if (row.suspended_at) {
        return { error: 'This account is suspended. Contact support.' };
      }

      return { user: q.userById.get(row.id) };
    },

    startSession(userId) {
      const token = randomToken();
      q.insertSession.run(sha256(token), userId, now() + config.sessionDays * 86400_000);
      q.purgeSessions.run(now());

      return token;
    },

    endSession(token) {
      if (token) {
        q.deleteSession.run(sha256(token));
      }
    },

    userFromSession(token) {
      return token ? q.sessionUser.get(sha256(token), now()) || null : null;
    },

    userFromApiToken(token) {
      return token ? q.apiTokenUser.get(sha256(token)) || null : null;
    },

    createApiToken(userId, name) {
      const token = `cma_${randomToken()}`;
      q.insertApiToken.run(sha256(token), userId, String(name || 'Desktop app').slice(0, 60), now());

      return token;
    },

    setRole: (userId, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'user', userId),
    setSuspended(userId, suspended) {
      db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(suspended ? Date.now() : null, userId);

      if (suspended) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      }
    },
    userByEmail: (email) => q.userByEmail.get(normalizeEmail(email)) || null,
    userById: (id) => q.userById.get(id) || null,
    listApiTokens: (userId) => q.listApiTokens.all(userId),
    deleteApiToken: (userId, id) => q.deleteApiToken.run(userId, id).changes > 0,
  };
}

/** Very small fixed-window limiter for login/signup attempts. */
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();

  return (key) => {
    const t = Date.now();
    const entry = hits.get(key);

    if (!entry || t - entry.start > windowMs) {
      hits.set(key, { start: t, count: 1 });

      if (hits.size > 10_000) {
        for (const [k, v] of hits) {
          if (t - v.start > windowMs) {
            hits.delete(k);
          }
        }
      }

      return true;
    }

    entry.count++;

    return entry.count <= max;
  };
}
