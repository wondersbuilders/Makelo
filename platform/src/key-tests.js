/**
 * "Test connection" for keys in Admin → API keys. Each test makes one cheap, read-only request
 * (usually listing models) and reports whether the provider accepted the key. Nothing is billed.
 */
const bearer = (value) => ({ authorization: `Bearer ${value}` });

const openAiStyle = (base) => ({ url: () => `${base}/models`, headers: bearer });

const TESTS = {
  ANTHROPIC_API_KEY: {
    url: () => 'https://api.anthropic.com/v1/models?limit=1',
    headers: (v) => ({ 'x-api-key': v, 'anthropic-version': '2023-06-01' }),
  },
  OPENAI_API_KEY: openAiStyle('https://api.openai.com/v1'),
  GOOGLE_GENERATIVE_AI_API_KEY: {
    url: (v) => `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(v)}`,
    headers: () => ({}),
  },
  OPEN_ROUTER_API_KEY: { url: () => 'https://openrouter.ai/api/v1/key', headers: bearer },
  DEEPSEEK_API_KEY: openAiStyle('https://api.deepseek.com'),
  XAI_API_KEY: openAiStyle('https://api.x.ai/v1'),
  MISTRAL_API_KEY: openAiStyle('https://api.mistral.ai/v1'),
  GROQ_API_KEY: openAiStyle('https://api.groq.com/openai/v1'),
  TOGETHER_API_KEY: openAiStyle('https://api.together.xyz/v1'),
  COHERE_API_KEY: { url: () => 'https://api.cohere.com/v1/models?page_size=1', headers: bearer },
  FIREWORKS_API_KEY: openAiStyle('https://api.fireworks.ai/inference/v1'),
  CEREBRAS_API_KEY: openAiStyle('https://api.cerebras.ai/v1'),
  MOONSHOT_API_KEY: openAiStyle('https://api.moonshot.ai/v1'),
  HYPERBOLIC_API_KEY: openAiStyle('https://api.hyperbolic.xyz/v1'),
  HuggingFace_API_KEY: { url: () => 'https://huggingface.co/api/whoami-v2', headers: bearer },
  GITHUB_API_KEY: { url: () => 'https://api.github.com/user', headers: bearer },
  GITHUB_TOKEN: { url: () => 'https://api.github.com/rate_limit', headers: bearer },
  E2B_API_KEY: { url: () => 'https://api.e2b.app/sandboxes', headers: (v) => ({ 'x-api-key': v }) },
  OPENAI_LIKE_API_BASE_URL: {
    url: (v) => `${v.replace(/\/+$/, '')}/models`,
    headers: (_v, get) => (get('OPENAI_LIKE_API_KEY') ? bearer(get('OPENAI_LIKE_API_KEY')) : {}),
  },
  OPENAI_LIKE_API_KEY: {
    url: (_v, get) => (get('OPENAI_LIKE_API_BASE_URL') ? `${get('OPENAI_LIKE_API_BASE_URL').replace(/\/+$/, '')}/models` : ''),
    headers: bearer,
    needs: 'Save the OpenAI-compatible URL first.',
  },
  OLLAMA_API_BASE_URL: { url: (v) => `${v.replace(/\/+$/, '')}/api/tags`, headers: () => ({}) },
  LMSTUDIO_API_BASE_URL: { url: (v) => `${v.replace(/\/+$/, '')}/v1/models`, headers: () => ({}) },
  WHOP_API_KEY: {
    url: (_v, get) =>
      get('WHOP_COMPANY_ID')
        ? `${get('__WHOP_BASE')}/payments?company_id=${encodeURIComponent(get('WHOP_COMPANY_ID'))}&first=1`
        : '',
    headers: bearer,
    needs: 'Save the Whop company ID first.',
  },
  NAMECOM_API_TOKEN: {
    url: (_v, get) => (get('NAMECOM_USERNAME') ? 'https://api.name.com/v4/hello' : ''),
    headers: (v, get) => ({ authorization: `Basic ${Buffer.from(`${get('NAMECOM_USERNAME')}:${v}`).toString('base64')}` }),
    needs: 'Save the Name.com username first.',
  },
};

/** Which keys have a connection test (others are just stored). */
export const TESTABLE = new Set(Object.keys(TESTS));

/**
 * @param {string} env      catalog env name
 * @param {(name: string) => string} get  reads any saved key/setting (vault, then environment)
 * @returns {Promise<{ ok: boolean, message: string, at: number }>}
 */
export async function testKey(env, get, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const at = Date.now();
  const test = TESTS[env];
  const value = get(env);

  if (!test) {
    return { ok: false, message: 'No automatic test for this one.', at };
  }

  if (!value) {
    return { ok: false, message: 'Not set.', at };
  }

  const url = test.url(value, get);

  if (!url) {
    return { ok: false, message: test.needs || 'Missing settings.', at };
  }

  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', ...test.headers(value, get) },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      return { ok: true, message: 'Connected', at };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Key was rejected — check it and paste it again.', at };
    }

    if (res.status === 404 && env === 'WHOP_API_KEY') {
      return { ok: false, message: 'Whop could not find that company ID.', at };
    }

    return { ok: false, message: `Provider answered HTTP ${res.status}.`, at };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    return { ok: false, message: `The server ${reason}.`, at };
  }
}
