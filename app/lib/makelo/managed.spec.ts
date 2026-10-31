import { afterEach, describe, expect, it, vi } from 'vitest';

const cookie = (apiKeys: object, providers: object) =>
  `apiKeys=${encodeURIComponent(JSON.stringify(apiKeys))}; providers=${encodeURIComponent(JSON.stringify(providers))}`;

async function load(managed: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_MANAGED_KEYS', managed ? 'true' : 'false');

  return {
    cookies: await import('~/lib/api/cookies'),
    models: await import('~/routes/api.models'),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('managed AI keys', () => {
  const header = cookie(
    { Anthropic: 'sk-user-own' },
    { Anthropic: { enabled: true, baseUrl: 'https://evil.example/v1' } },
  );

  it('ignores user keys and base URL overrides when managed', async () => {
    const { cookies } = await load(true);
    const { apiKeys, providerSettings } = cookies.getRequestCredentials(header);

    expect(apiKeys).toEqual({});
    expect(providerSettings.Anthropic).toEqual({ enabled: true });
  });

  it('keeps user keys when not managed (self-hosted builder)', async () => {
    const { cookies } = await load(false);
    const { apiKeys, providerSettings } = cookies.getRequestCredentials(header);

    expect(apiKeys).toEqual({ Anthropic: 'sk-user-own' });
    expect(providerSettings.Anthropic.baseUrl).toBe('https://evil.example/v1');
  });

  it('resolves the admin key, never the user key or URL, inside the provider', async () => {
    await load(true);

    const manager = (await import('~/lib/modules/llm/manager')).LLMManager;
    const anthropic = manager.getInstance({}).getProvider('Anthropic')!;

    const { apiKey, baseUrl } = anthropic.getProviderBaseUrlAndKey({
      apiKeys: { Anthropic: 'sk-user-own' },
      providerSettings: { baseUrl: 'https://evil.example/v1' },
      serverEnv: { ANTHROPIC_API_KEY: 'sk-admin' },
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'ANTHROPIC_API_KEY',
    });

    expect(apiKey).toBe('sk-admin');
    expect(String(baseUrl ?? '')).not.toContain('evil.example');
  });

  it('lists only providers the admin has keys for, Anthropic first', async () => {
    const { models } = await load(true);

    const res = await models.loader({
      request: new Request('http://x/api/models?providers=OpenAI,Groq', { headers: { Cookie: header } }),
      params: {},
      context: { cloudflare: { env: { ANTHROPIC_API_KEY: 'sk-admin', OPENAI_API_KEY: 'sk-admin-2' } } },
    });

    const data = (await res.json()) as any;

    expect(data.managedProviders.slice(0, 2)).toEqual(['Anthropic', 'OpenAI']);
    expect(data.providers.map((p: any) => p.name)).not.toContain('Groq');
    expect(data.defaultProvider.name).toBe('Anthropic');
    expect(new Set(data.modelList.map((m: any) => m.provider))).not.toContain('Groq');
  });
});
