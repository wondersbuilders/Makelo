import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';

/**
 * Encrypted settings vault (AES-256-GCM).
 *
 * The master key comes from SECRET_KEY (any long random string). If it is not set, a random
 * key is generated once and kept in DATA_DIR/secret.key — back that file up with the database,
 * or set SECRET_KEY explicitly in production.
 */
export function loadMasterKey(config, env = process.env) {
  if (env.SECRET_KEY) {
    return crypto.createHash('sha256').update(env.SECRET_KEY).digest();
  }

  const file = path.join(config.dataDir, 'secret.key');

  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }

  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

export function decrypt(key, payload) {
  const [v, iv, tag, body] = String(payload).split(':');

  if (v !== 'v1') {
    throw new Error('Unknown secret format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

export const mask = (value) => {
  const v = String(value || '');
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`;
};

/**
 * Third-party keys the admin can manage. `env` is the variable name the builder / platform reads.
 * Values entered in the admin dashboard override the server's environment variables.
 */
export const KEY_CATALOG = [
  { group: 'AI models', env: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', help: 'console.anthropic.com → API keys' },
  { group: 'AI models', env: 'OPENAI_API_KEY', label: 'OpenAI', help: 'platform.openai.com → API keys' },
  { group: 'AI models', env: 'GOOGLE_GENERATIVE_AI_API_KEY', label: 'Google Gemini', help: 'aistudio.google.com → API key' },
  { group: 'AI models', env: 'OPEN_ROUTER_API_KEY', label: 'OpenRouter', help: 'openrouter.ai → Keys (one key, hundreds of models)' },
  { group: 'AI models', env: 'DEEPSEEK_API_KEY', label: 'DeepSeek', help: 'platform.deepseek.com → API keys' },
  { group: 'AI models', env: 'XAI_API_KEY', label: 'xAI (Grok)', help: 'console.x.ai' },
  { group: 'AI models', env: 'MISTRAL_API_KEY', label: 'Mistral', help: 'console.mistral.ai' },
  { group: 'AI models', env: 'GROQ_API_KEY', label: 'Groq', help: 'console.groq.com' },
  { group: 'AI models', env: 'TOGETHER_API_KEY', label: 'Together AI', help: 'api.together.ai' },
  { group: 'AI models', env: 'PERPLEXITY_API_KEY', label: 'Perplexity', help: 'perplexity.ai → API' },
  { group: 'AI models', env: 'COHERE_API_KEY', label: 'Cohere', help: 'dashboard.cohere.com' },
  { group: 'AI models', env: 'FIREWORKS_API_KEY', label: 'Fireworks', help: 'fireworks.ai → API keys' },
  { group: 'AI models', env: 'CEREBRAS_API_KEY', label: 'Cerebras', help: 'cloud.cerebras.ai' },
  { group: 'AI models', env: 'MOONSHOT_API_KEY', label: 'Moonshot (Kimi)', help: 'platform.moonshot.ai' },
  { group: 'AI models', env: 'HYPERBOLIC_API_KEY', label: 'Hyperbolic', help: 'app.hyperbolic.xyz' },
  { group: 'AI models', env: 'ZAI_API_KEY', label: 'Z.ai (GLM)', help: 'z.ai → API keys' },
  { group: 'AI models', env: 'HuggingFace_API_KEY', label: 'Hugging Face', help: 'huggingface.co → Settings → Tokens' },
  { group: 'AI models', env: 'GITHUB_API_KEY', label: 'GitHub Models', help: 'GitHub token with models:read' },
  {
    group: 'AI models',
    env: 'AWS_BEDROCK_CONFIG',
    label: 'Amazon Bedrock',
    help: 'JSON: {"region":"us-east-1","accessKeyId":"…","secretAccessKey":"…"}',
    format: 'json',
  },
  {
    group: 'Custom & self-hosted AI',
    env: 'OPENAI_LIKE_API_BASE_URL',
    label: 'OpenAI-compatible URL',
    help: 'Any OpenAI-compatible API, e.g. https://api.example.com/v1',
    format: 'url',
  },
  { group: 'Custom & self-hosted AI', env: 'OPENAI_LIKE_API_KEY', label: 'OpenAI-compatible key', help: 'Key for the URL above' },
  {
    group: 'Custom & self-hosted AI',
    env: 'OLLAMA_API_BASE_URL',
    label: 'Ollama server URL',
    help: 'Your own Ollama server, e.g. http://10.0.0.5:11434',
    format: 'url',
  },
  {
    group: 'Custom & self-hosted AI',
    env: 'LMSTUDIO_API_BASE_URL',
    label: 'LM Studio server URL',
    help: 'e.g. http://10.0.0.5:1234',
    format: 'url',
  },
  { group: 'Sandboxes', env: 'E2B_API_KEY', label: 'e2b.dev', help: 'e2b.dev/dashboard → API key' },
  { group: 'Payments (Whop)', env: 'WHOP_API_KEY', label: 'Whop API key', help: 'Whop dashboard → Developer → Company API key' },
  { group: 'Payments (Whop)', env: 'WHOP_COMPANY_ID', label: 'Whop company ID', help: 'biz_… (Dashboard → Settings)' },
  { group: 'Payments (Whop)', env: 'WHOP_WEBHOOK_SECRET', label: 'Whop webhook secret', help: 'ws_… — from the webhook you create for /webhooks/whop' },
  { group: 'Domains', env: 'NAMECOM_USERNAME', label: 'Name.com username' },
  { group: 'Domains', env: 'NAMECOM_API_TOKEN', label: 'Name.com API token', help: 'name.com → Account → API settings' },
  { group: 'Code hosting', env: 'GITHUB_TOKEN', label: 'GitHub token', help: 'Used for template downloads (higher rate limits)' },
  { group: 'Email', env: 'SMTP_URL', label: 'SMTP URL', help: 'smtp://user:pass@host:587 — for system emails' },
];

/** Keys handed to the builder: every AI provider key/URL plus the GitHub token for templates. */
export const BUILDER_KEYS = new Set(
  KEY_CATALOG.filter((k) => k.group === 'AI models' || k.group === 'Custom & self-hosted AI' || k.env === 'GITHUB_TOKEN').map(
    (k) => k.env,
  ),
);

/** Validate a value the admin pasted; returns an error message or null. */
export function validateKeyValue(entry, value) {
  if (value.length > 8000) {
    return 'That value is too long.';
  }

  if (entry.format === 'json') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? null : 'Paste a JSON object.';
    } catch {
      return 'That is not valid JSON.';
    }
  }

  if (entry.format === 'url') {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Use an http:// or https:// URL.';
    } catch {
      return 'That is not a valid URL.';
    }
  }

  return /\s/.test(value) ? 'That does not look like a valid key (no spaces allowed).' : null;
}

export function createSettings(db, masterKey) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    secret     INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);

  const q = {
    get: db.prepare('SELECT * FROM settings WHERE key = ?'),
    set: db.prepare(
      'INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at',
    ),
    del: db.prepare('DELETE FROM settings WHERE key = ?'),
    all: db.prepare('SELECT * FROM settings'),
  };

  const read = (row) => (row ? (row.secret ? decrypt(masterKey, row.value) : row.value) : undefined);

  return {
    get: (key, fallback) => read(q.get.get(key)) ?? fallback,
    getNumber(key, fallback) {
      const v = Number(read(q.get.get(key)));
      return Number.isFinite(v) ? v : fallback;
    },
    set(key, value, { secret = false } = {}) {
      if (value === null || value === undefined || value === '') {
        q.del.run(key);
        return;
      }

      q.set.run(key, secret ? encrypt(masterKey, value) : String(value), secret ? 1 : 0, now());
    },
    remove: (key) => q.del.run(key),

    /** Secret value from the vault, else the server environment. */
    secret(envName, env = process.env) {
      return read(q.get.get(`key:${envName}`)) || env[envName] || '';
    },

    /** Catalog with masked values and where each value comes from. */
    keyStatus(env = process.env) {
      return KEY_CATALOG.map((k) => {
        const row = q.get.get(`key:${k.env}`);
        const stored = row ? read(row) : '';
        return {
          ...k,
          source: stored ? 'dashboard' : env[k.env] ? 'environment' : 'missing',
          masked: k.format === 'url' ? stored || env[k.env] || '' : stored ? mask(stored) : env[k.env] ? mask(env[k.env]) : '',
          updatedAt: row?.updated_at,
          test: (() => {
            try {
              return JSON.parse(read(q.get.get(`keytest:${k.env}`)) || 'null');
            } catch {
              return null;
            }
          })(),
        };
      });
    },

    /** Keys the builder needs (dashboard values only; the builder already has its own environment). */
    builderKeys() {
      const out = {};

      for (const row of q.all.all()) {
        if (row.key.startsWith('key:') && BUILDER_KEYS.has(row.key.slice(4))) {
          out[row.key.slice(4)] = read(row);
        }
      }

      return out;
    },
  };
}
