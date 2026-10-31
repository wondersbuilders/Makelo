import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import { adminProviderKeys } from '~/lib/.server/makelo-platform';

declare global {
  interface CloudflareEnvironment extends Env {}
}

const requestHandler = createRequestHandler(
  // The virtual module resolves to the generated server build; the cast bridges the
  // ambient declaration in `types/` to the `ServerBuild` shape the handler expects.
  () => import('virtual:react-router/server-build') as unknown as Promise<ServerBuild>,
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider() as RouterContextProvider & {
      cloudflare: { env: Env; ctx: ExecutionContext };
    };

    // Makelo: provider keys entered in the admin dashboard override the server environment.
    const adminKeys = await adminProviderKeys();
    context.cloudflare = { env: Object.keys(adminKeys).length ? ({ ...env, ...adminKeys } as Env) : env, ctx };

    return requestHandler(request, context);
  },
} satisfies ExportedHandler<CloudflareEnvironment>;