import { MANAGED_KEYS } from '~/lib/makelo/managed';

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseCookies(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};

  if (!cookieHeader) {
    return cookies;
  }

  // Split the cookie string by semicolons and spaces
  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest.length > 0) {
      try {
        // Decode the name and value, and join value parts in case it contains '='
        const decodedName = decodeURIComponent(name.trim());
        const decodedValue = decodeURIComponent(rest.join('=').trim());
        cookies[decodedName] = decodedValue;
      } catch {
        cookies[name.trim()] = rest.join('=').trim();
      }
    }
  });

  return cookies;
}

export function getApiKeysFromCookie(cookieHeader: string | null): Record<string, string> {
  const cookies = parseCookies(cookieHeader);
  return safeJsonParse<Record<string, string>>(cookies.apiKeys, {});
}

/**
 * Keys and provider settings to use for this request. In managed mode the user's own keys are
 * ignored and base URL overrides are dropped, so the admin's keys are used and never redirected.
 */
export function getRequestCredentials(cookieHeader: string | null): {
  apiKeys: Record<string, string>;
  providerSettings: Record<string, any>;
} {
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  if (!MANAGED_KEYS) {
    return { apiKeys: getApiKeysFromCookie(cookieHeader), providerSettings };
  }

  const safe: Record<string, any> = {};

  for (const [name, setting] of Object.entries(providerSettings)) {
    if (setting && typeof setting === 'object') {
      const { baseUrl: _ignored, ...rest } = setting as Record<string, any>;
      safe[name] = rest;
    }
  }

  return { apiKeys: {}, providerSettings: safe };
}

export function getProviderSettingsFromCookie(cookieHeader: string | null): Record<string, any> {
  const cookies = parseCookies(cookieHeader);
  return safeJsonParse<Record<string, any>>(cookies.providers, {});
}
