import path from 'node:path';

/**
 * All settings come from environment variables so the same build runs locally and in production.
 *
 *   APP_HOST       host serving the builder + account pages        e.g. app.clickmyapp.com
 *   SITES_DOMAIN   parent domain for free subdomains               e.g. clickmyapp.com  -> myapp-x7k2.clickmyapp.com
 *   PUBLIC_SCHEME  scheme used when printing URLs                  https (use http for local testing)
 *   PORT           port the platform listens on                    8787
 *   DATA_DIR       where the database and published files live     ./data
 *   CNAME_TARGET   hostname customers point their CNAME at         sites.clickmyapp.com
 *   SERVER_IPV4    public IP customers use for apex A records      (your VPS IP)
 *   SECURE_COOKIES "false" only for local http testing
 *   CORS_ORIGINS   comma list of extra origins allowed to call the JSON API with a bearer token (desktop app)
 */
export function loadConfig(env = process.env) {
  const sitesDomain = (env.SITES_DOMAIN || 'clickmyapp.com').toLowerCase();
  const appHost = (env.APP_HOST || `app.${sitesDomain}`).toLowerCase();

  return {
    appHost,
    sitesDomain,
    scheme: env.PUBLIC_SCHEME || 'https',
    port: Number(env.PORT || 8787),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    cnameTarget: (env.CNAME_TARGET || `sites.${sitesDomain}`).toLowerCase(),
    serverIpv4: env.SERVER_IPV4 || '',
    secureCookies: env.SECURE_COOKIES !== 'false',
    corsOrigins: (env.CORS_ORIGINS || 'app://-,http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionDays: Number(env.SESSION_DAYS || 30),
    maxDeployBytes: Number(env.MAX_DEPLOY_MB || 50) * 1024 * 1024,
    maxDeployFiles: Number(env.MAX_DEPLOY_FILES || 3000),
    maxSitesPerUser: Number(env.MAX_SITES_PER_USER || 20),
    keepDeploys: Number(env.KEEP_DEPLOYS || 5),
  };
}

/** Subdomains nobody can claim. */
export const RESERVED_SLUGS = new Set([
  'app', 'www', 'api', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'docs', 'help', 'support', 'status',
  'blog', 'downloads', 'download', 'cdn', 'static', 'assets', 'sites', 'dashboard', 'account', 'login',
  'signup', 'billing', 'ns1', 'ns2', 'dev', 'staging', 'test', 'clickmyapp',
]);
