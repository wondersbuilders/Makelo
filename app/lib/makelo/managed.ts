/**
 * Makelo managed AI keys.
 *
 * With VITE_MANAGED_KEYS=true (the hosted SaaS build), every AI request uses the provider keys the
 * admin entered in Admin → API keys. Users cannot enter their own keys or change provider base URLs
 * (a custom base URL would send the admin's key to someone else's server), and only providers the
 * admin has a key for are offered.
 */
export const MANAGED_KEYS: boolean = import.meta.env.VITE_MANAGED_KEYS === 'true';

/** Provider offered first when the admin has a key for it. */
export const PREFERRED_PROVIDERS = ['Anthropic', 'OpenAI', 'Google', 'OpenRouter'];
