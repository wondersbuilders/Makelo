/**
 * Server-side link between the AI builder and the Makelo platform service.
 *
 * - Provider API keys entered in Admin → API keys are fetched from the platform and merged
 *   into the request environment (cached for a minute), so new keys work without a restart.
 * - Token usage of each AI reply is reported so the platform can charge the user's credits.
 *
 * The platform's /internal API is only reachable on the private Docker network.
 */
const INTERNAL_URL: string = (import.meta.env.VITE_PLATFORM_INTERNAL_URL || 'http://platform:8787').replace(/\/+$/, '');
const CACHE_MS = 60_000;

let keyCache: { at: number; keys: Record<string, string> } | null = null;
let inflight: Promise<Record<string, string>> | null = null;

export function platformEnabled() {
  return INTERNAL_URL !== 'off';
}

async function fetchKeys(): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${INTERNAL_URL}/internal/provider-keys`, { signal: AbortSignal.timeout(1500) });

    if (res.ok) {
      const data = (await res.json()) as { keys?: Record<string, string> };
      return data.keys || {};
    }
  } catch {
    /* platform not reachable (e.g. running the builder on its own) */
  }

  return {};
}

/** Admin-managed provider keys (empty when the platform is unreachable). */
export async function adminProviderKeys(): Promise<Record<string, string>> {
  if (!platformEnabled()) {
    return {};
  }

  if (keyCache && Date.now() - keyCache.at < CACHE_MS) {
    return keyCache.keys;
  }

  inflight ??= fetchKeys().then((keys) => {
    keyCache = { at: Date.now(), keys };
    inflight = null;

    return keys;
  });

  return inflight;
}

/** Report one AI reply's token usage for the signed-in user (set by the proxy as X-Makelo-User). */
export async function reportAiUsage(
  request: Request,
  usage: { provider?: string; model?: string; inputTokens: number; outputTokens: number },
) {
  const userId = request.headers.get('x-makelo-user');

  if (!platformEnabled() || !userId || usage.inputTokens + usage.outputTokens <= 0) {
    return;
  }

  try {
    await fetch(`${INTERNAL_URL}/internal/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(userId), ...usage }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* usage reporting must never break the chat */
  }
}
