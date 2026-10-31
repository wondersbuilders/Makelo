import { atom } from 'nanostores';

/**
 * Talks to the Makelo platform service (accounts, publishing, domains).
 *
 * Web: the builder and platform share one origin (Caddy routes /account and /api/platform),
 *      so requests use the login cookie.
 * Desktop: set VITE_PLATFORM_URL (e.g. https://app.makelo.com) at build time; requests
 *      use an access token the user creates on their dashboard.
 */
export const PLATFORM_URL: string = (import.meta.env.VITE_PLATFORM_URL || '').replace(/\/+$/, '');

const TOKEN_KEY = 'makelo-access-token';

export interface PlatformUser {
  id: number;
  email: string;
}

export interface PlatformSite {
  id: number;
  name: string;
  slug: string;
  url: string;
  chatId: string | null;
  published: boolean;
  domains: { hostname: string; verified: boolean }[];
  settingsUrl: string;
}

export const platformUser = atom<PlatformUser | null | undefined>(undefined);

/** Last published site per chat, so the menu can show "View live app". */
export const publishedSites = atom<Record<string, PlatformSite>>({});

export const accountUrl = (path = '/account') => `${PLATFORM_URL}${path}`;

function storedToken(): string | null {
  try {
    return PLATFORM_URL ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function setAccessToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function platformFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = storedToken();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${PLATFORM_URL}${path}`, {
    ...init,
    headers,
    credentials: PLATFORM_URL ? 'omit' : 'same-origin',
  });

  let data: any = null;

  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    throw new PlatformError(data?.error || `Makelo request failed (${res.status})`, res.status);
  }

  return data as T;
}

export async function loadPlatformUser(): Promise<PlatformUser | null> {
  try {
    const { user } = await platformFetch<{ user: PlatformUser }>('/api/platform/me');
    platformUser.set(user);

    return user;
  } catch {
    platformUser.set(null);
    return null;
  }
}

export async function loadPublishedSites() {
  try {
    const { sites } = await platformFetch<{ sites: PlatformSite[] }>('/api/platform/sites');
    publishedSites.set(Object.fromEntries(sites.filter((s) => s.chatId && s.published).map((s) => [s.chatId!, s])));
  } catch {
    /* not logged in */
  }
}

export async function publishFiles(input: {
  name: string;
  chatId: string;
  files: Record<string, string>;
}): Promise<PlatformSite> {
  const { site } = await platformFetch<{ site: PlatformSite }>('/api/platform/publish', {
    method: 'POST',
    body: JSON.stringify(input),
  });

  publishedSites.set({ ...publishedSites.get(), [input.chatId]: site });

  return site;
}

/** Base64-encode bytes without blowing the call stack on large files. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}
