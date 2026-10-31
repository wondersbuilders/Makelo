import { getRequestCredentials } from '~/lib/api/cookies';
import { MANAGED_KEYS, PREFERRED_PROVIDERS } from '~/lib/makelo/managed';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { ProviderInfo } from '~/types/model';

function rank(name: string) {
  const i = PREFERRED_PROVIDERS.indexOf(name);
  return i === -1 ? PREFERRED_PROVIDERS.length : i;
}

let cachedProviders: ProviderInfo[] | null = null;
let cachedDefaultProvider: ProviderInfo | null = null;

function getProviderInfo(llmManager: LLMManager) {
  if (!cachedProviders) {
    cachedProviders = llmManager.getAllProviders().map((provider) => ({
      name: provider.name,
      staticModels: provider.staticModels,
      getApiKeyLink: provider.getApiKeyLink,
      labelForGetApiKey: provider.labelForGetApiKey,
      icon: provider.icon,
    }));
  }

  if (!cachedDefaultProvider) {
    const defaultProvider = llmManager.getDefaultProvider();
    cachedDefaultProvider = {
      name: defaultProvider.name,
      staticModels: defaultProvider.staticModels,
      getApiKeyLink: defaultProvider.getApiKeyLink,
      labelForGetApiKey: defaultProvider.labelForGetApiKey,
      icon: defaultProvider.icon,
    };
  }

  return { providers: cachedProviders, defaultProvider: cachedDefaultProvider };
}

export async function loader({
  request,
  params,
  context,
}: {
  request: Request;
  params: { provider?: string };
  context: {
    cloudflare?: {
      env: Record<string, string>;
    };
  };
}): Promise<Response> {
  const llmManager = LLMManager.getInstance(context.cloudflare?.env);

  // Get client side maintained API keys and provider settings from cookies
  const cookieHeader = request.headers.get('Cookie');
  const { apiKeys, providerSettings: requestProviderSettings } = getRequestCredentials(cookieHeader);
  const providerSettings = requestProviderSettings;

  let enabledProviderNames = new URL(request.url).searchParams.get('providers')?.split(',').filter(Boolean);

  let { providers, defaultProvider } = getProviderInfo(llmManager);

  /*
   * Makelo managed keys: offer only providers the admin has entered a key for, whatever the
   * browser asks for, and make the preferred one (Anthropic first) the default.
   */
  let managedProviders: string[] | undefined;

  if (MANAGED_KEYS) {
    const env = (context.cloudflare?.env || {}) as Record<string, string>;
    managedProviders = llmManager
      .getAllProviders()
      .filter((p) => p.config.apiTokenKey && (env[p.config.apiTokenKey] || process.env[p.config.apiTokenKey]))
      .map((p) => p.name)
      .sort((a, b) => rank(a) - rank(b));

    const allowed = new Set(managedProviders);
    providers = providers.filter((p) => allowed.has(p.name));
    defaultProvider = providers[0] || defaultProvider;
    enabledProviderNames = (enabledProviderNames?.length ? enabledProviderNames : managedProviders).filter((n) =>
      allowed.has(n),
    );

    if (params.provider && !allowed.has(params.provider)) {
      return Response.json({ modelList: [], providers, defaultProvider, managedProviders });
    }
  }

  let modelList: ModelInfo[] = [];

  if (params.provider) {
    // Only update models for the specific provider
    const provider = llmManager.getProvider(params.provider);

    if (provider) {
      modelList = await llmManager.getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: context.cloudflare?.env,
      });
    }
  } else {
    // Update all models
    modelList = await llmManager.updateModelList({
      apiKeys,
      providerSettings,
      serverEnv: context.cloudflare?.env,
      enabledProviderNames,
    });
  }

  if (managedProviders) {
    const allowed = new Set(managedProviders);
    modelList = modelList.filter((m) => allowed.has(m.provider));
  }

  return Response.json({
    modelList,
    providers,
    defaultProvider,
    managedProviders,
  });
}
