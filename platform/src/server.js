import fs from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { createAuth, createRateLimiter, SESSION_COOKIE } from './auth.js';
import { openDb } from './db.js';
import { createAdminApp } from './admin.js';
import { createBilling } from './billing.js';
import { createDomains, normalizeHostname } from './domains.js';
import { createSettings, loadMasterKey } from './secrets.js';
import { createE2bProvider } from './sandbox/e2b.js';
import { createLocalProvider } from './sandbox/local.js';
import { createSandboxManager } from './sandbox/manager.js';
import { createSites, contentType } from './sites.js';
import { createPayments, verifyWhopSignature } from './payments.js';
import { appPage, authPage, billingPage, dashboardPage, placeholderPage } from './views.js';

const PH = (config) => `${config.scheme}://${config.appHost}/account/signup`;
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

function pickProvider(config, settings) {
  if (config.sandboxProvider === 'local') {
    console.warn('[makelo] SANDBOX_PROVIDER=local runs user code on this machine without isolation. Development only!');
    return createLocalProvider(config);
  }

  if (config.sandboxProvider === 'off') {
    return null;
  }

  // e2b: the key can be added later in Admin → API keys; it is read on every sandbox start.
  return createE2bProvider(config, () => settings.secret('E2B_API_KEY') || config.e2bApiKey);
}

export function createApp(config, { resolver, db: givenDb, sandboxProvider, fetchImpl } = {}) {
  const db = givenDb || openDb(config.dataDir);
  const auth = createAuth(db, config);
  const sites = createSites(db, config);
  const domains = createDomains(db, config, resolver);
  const settings = createSettings(db, loadMasterKey(config));
  const billing = createBilling(db, settings);
  const payments = createPayments({ db, config, settings, billing, auth, fetchImpl });
  const provider = sandboxProvider ?? pickProvider(config, settings);
  const sandboxes = provider
    ? createSandboxManager(db, config, provider, { onUsage: (userId, seconds) => billing.chargeSandbox(userId, seconds) })
    : null;
  const adminEmails = new Set(
    String(config.adminEmails || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const limitAuth = createRateLimiter({ max: 10, windowMs: 10 * 60_000 });
  const cookieName = config.secureCookies ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;

  const app = new Hono();

  const hostOf = (c) => normalizeHostname(c.req.header('host') || '');
  const isAppHost = (c) => {
    const h = hostOf(c);
    return h === config.appHost || h === 'localhost' || h === '127.0.0.1';
  };

  // ---------- identity ----------
  function currentUser(c) {
    const bearer = (c.req.header('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];

    if (bearer) {
      c.set('viaToken', true);
      return auth.userFromApiToken(bearer);
    }

    return auth.userFromSession(getCookie(c, cookieName));
  }

  function setSession(c, userId) {
    setCookie(c, cookieName, auth.startSession(userId), {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: config.sessionDays * 86400,
    });
  }

  /** Cookie-authenticated writes must come from our own pages. */
  function sameOrigin(c) {
    if (c.get('viaToken')) {
      return true;
    }

    const origin = c.req.header('origin') || c.req.header('referer');

    if (!origin) {
      return false;
    }

    try {
      return normalizeHostname(new URL(origin).host) === hostOf(c);
    } catch {
      return false;
    }
  }

  const billingSummary = (userId) => {
    const sub = billing.subscription(userId);
    return { plan: sub?.plan, periodEnd: sub?.period_end, balance: billing.balance(userId), plans: billing.plans().filter((p) => p.visible && !p.archived) };
  };

  const flashFrom = (c) => {
    const ok = c.req.query('ok');
    const err = c.req.query('error');
    const warn = c.req.query('warn');

    return err ? { type: 'error', message: err } : warn ? { type: 'warn', message: warn } : ok ? { type: 'ok', message: ok } : null;
  };

  const back = (c, path, kind, message) => c.redirect(`${path}?${kind}=${encodeURIComponent(message)}`, 303);

  // ---------- internal (Caddy only; blocked at the proxy for public traffic) ----------
  app.get('/internal/tls-ask', (c) => {
    const domain = c.req.query('domain') || '';
    return domains.allowCertificate(domain, sites) ? c.text('ok') : c.text('no', 404);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // ---------- internal API for the builder (Docker network only; blocked at the proxy) ----------
  const internalOk = (c) => !config.internalSecret || c.req.header('x-internal-secret') === config.internalSecret;

  app.get('/internal/provider-keys', (c) => (internalOk(c) ? c.json({ keys: settings.builderKeys() }) : c.json({ error: 'forbidden' }, 403)));

  app.post('/internal/usage', async (c) => {
    if (!internalOk(c)) return c.json({ error: 'forbidden' }, 403);

    const body = await c.req.json().catch(() => ({}));
    const userId = Number(body.userId);

    if (!userId || !auth.userById(userId)) {
      return c.json({ error: 'unknown user' }, 400);
    }

    const credits = billing.chargeAi(userId, {
      provider: String(body.provider || '').slice(0, 40),
      model: String(body.model || '').slice(0, 80),
      inputTokens: Math.max(0, Number(body.inputTokens) || 0),
      outputTokens: Math.max(0, Number(body.outputTokens) || 0),
    });

    return c.json({ charged: credits, balance: billing.balance(userId) });
  });

  // ---------- Whop webhook (public; authenticated by its signature) ----------
  app.post('/webhooks/whop', async (c) => {
    const body = await c.req.text();
    const ok = verifyWhopSignature({
      secret: settings.secret('WHOP_WEBHOOK_SECRET'),
      id: c.req.header('webhook-id'),
      timestamp: c.req.header('webhook-timestamp'),
      signature: c.req.header('webhook-signature'),
      body,
    });

    if (!ok) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    let event;

    try {
      event = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    try {
      const result = await payments.handleEvent({ ...event, id: event.id || c.req.header('webhook-id') });
      return c.json({ received: true, result });
    } catch (err) {
      console.error('[makelo] whop webhook failed', err);
      return c.json({ error: 'processing failed' }, 500); // Whop retries
    }
  });

  // ---------- admin dashboard on its own host ----------
  const adminApp = createAdminApp({ db, config, auth, sites, billing, settings, sandboxes, payments, limitAuth, fetchImpl });

  // Admin host → admin app; app host → builder API + accounts; anything else → published user sites.
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/internal/')) {
      return next();
    }

    if (hostOf(c) === config.adminHost) {
      return adminApp.fetch(c.req.raw);
    }

    if (isAppHost(c)) {
      return next();
    }

    return serveSite(c);
  });

  // ---------- CORS for the desktop app (bearer tokens only, never cookies) ----------
  app.use('/api/platform/*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = origin && config.corsOrigins.includes(origin);

    if (c.req.method === 'OPTIONS') {
      return allowed
        ? new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
              'Access-Control-Allow-Headers': 'Authorization,Content-Type',
              'Access-Control-Max-Age': '600',
            },
          })
        : c.body(null, 403);
    }

    await next();

    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
  });

  // ---------- account pages ----------
  app.get('/account/signup', (c) => (currentUser(c) ? c.redirect('/account') : c.html(authPage({ mode: 'signup', next: c.req.query('next') }))));
  app.get('/account/login', (c) => (currentUser(c) ? c.redirect(safeNext(c.req.query('next'))) : c.html(authPage({ mode: 'login', next: c.req.query('next') }))));

  for (const mode of ['signup', 'login']) {
    app.post(`/account/${mode}`, async (c) => {
      if (!sameOrigin(c)) {
        return c.text('Bad origin', 403);
      }

      const form = await c.req.parseBody();
      const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';

      if (!limitAuth(`${mode}:${ip}`)) {
        return c.html(authPage({ mode, error: 'Too many attempts. Wait 10 minutes and try again.', email: form.email, next: form.next }), 429);
      }

      const result = await auth[mode](form.email, form.password);

      if (result.error) {
        return c.html(authPage({ mode, error: result.error, email: form.email, next: form.next }), 400);
      }

      if (mode === 'signup') {
        billing.enroll(result.user.id);

        if (adminEmails.has(result.user.email)) {
          auth.setRole(result.user.id, 'admin');
        }
      }

      setSession(c, result.user.id);

      return c.redirect(mode === 'signup' && !form.next ? '/' : safeNext(form.next), 303);
    });
  }

  app.post('/account/logout', (c) => {
    if (!sameOrigin(c)) {
      return c.text('Bad origin', 403);
    }

    auth.endSession(getCookie(c, cookieName));
    deleteCookie(c, cookieName, { path: '/', secure: config.secureCookies });

    return c.redirect('/account/login', 303);
  });

  // Every remaining /account route needs a logged-in user (cookie only).
  app.use('/account/*', async (c, next) => {
    const user = currentUser(c);

    if (!user || c.get('viaToken')) {
      return c.redirect(`/account/login?next=${encodeURIComponent(c.req.path)}`);
    }

    if (c.req.method === 'POST' && !sameOrigin(c)) {
      return c.text('Bad origin', 403);
    }

    c.set('user', user);
    await next();
  });

  app.get('/account', (c) => {
    const user = currentUser(c);

    if (!user) {
      return c.redirect('/account/login?next=/account');
    }

    return c.html(
      dashboardPage({ user, sites: sites.list(user.id), siteUrl: sites.siteUrl, tokens: auth.listApiTokens(user.id), flash: flashFrom(c), billing: billingSummary(user.id) }),
    );
  });

  // ---------- billing & credits ----------
  app.get('/account/billing', (c) => {
    const user = c.get('user');

    return c.html(
      billingPage({
        user,
        sub: billing.subscription(user.id),
        balance: billing.balance(user.id),
        used: billing.usedThisPeriod(user.id),
        plans: billing.plans().filter((p) => p.visible && !p.archived),
        packs: payments.packs().filter((k) => k.visible && !k.archived),
        membership: payments.membership(user.id),
        history: payments.history(user.id),
        payEnabled: payments.configured(),
        flash: flashFrom(c),
      }),
    );
  });

  app.post('/account/billing/checkout', async (c) => {
    const form = await c.req.parseBody();

    try {
      const r = await payments.checkout(c.get('user'), { kind: String(form.kind), id: Number(form.id) });
      return r.error ? back(c, '/account/billing', 'error', r.error) : c.redirect(r.url, 303);
    } catch (err) {
      console.error('[makelo] checkout failed', err);
      return back(c, '/account/billing', 'error', `Could not start checkout: ${err.message}`);
    }
  });

  app.post('/account/billing/cancel', async (c) => {
    try {
      const r = await payments.cancel(c.get('user').id);
      return back(c, '/account/billing', r.error ? 'error' : 'ok', r.error || 'Subscription cancelled. You keep your plan until the end of this period.');
    } catch (err) {
      return back(c, '/account/billing', 'error', `Could not cancel: ${err.message}`);
    }
  });

  app.post('/account/tokens', async (c) => {
    const user = c.get('user');
    const form = await c.req.parseBody();
    const token = auth.createApiToken(user.id, form.name);

    return c.html(
      dashboardPage({ user, sites: sites.list(user.id), siteUrl: sites.siteUrl, tokens: auth.listApiTokens(user.id), newToken: token, billing: billingSummary(user.id) }),
    );
  });

  app.post('/account/tokens/:id/delete', (c) => {
    auth.deleteApiToken(c.get('user').id, c.req.param('id'));
    return back(c, '/account', 'ok', 'Token revoked.');
  });

  const ownedSite = (c) => sites.getOwned(Number(c.req.param('id')), c.get('user').id);

  app.get('/account/apps/:id', (c) => {
    const site = ownedSite(c);

    if (!site) {
      return c.redirect('/account');
    }

    return c.html(
      appPage({
        user: c.get('user'),
        site,
        siteUrl: sites.siteUrl,
        domains: domains.forSite(site.id),
        instructions: domains.instructions,
        deploys: sites.deploys(site.id),
        flash: flashFrom(c),
        config,
      }),
    );
  });

  app.post('/account/apps/:id/rename', async (c) => {
    const site = ownedSite(c);
    if (!site) return c.redirect('/account');
    const r = sites.rename(site, (await c.req.parseBody()).name);
    return back(c, `/account/apps/${site.id}`, r.error ? 'error' : 'ok', r.error || 'Name saved.');
  });

  app.post('/account/apps/:id/slug', async (c) => {
    const site = ownedSite(c);
    if (!site) return c.redirect('/account');
    const r = sites.changeSlug(site, (await c.req.parseBody()).slug);
    return back(c, `/account/apps/${site.id}`, r.error ? 'error' : 'ok', r.error || `Your app now lives at ${r.site && sites.siteUrl(r.site)}`);
  });

  app.post('/account/apps/:id/delete', (c) => {
    const site = ownedSite(c);
    if (site) sites.remove(site);
    return back(c, '/account', 'ok', 'App deleted.');
  });

  app.post('/account/apps/:id/domains', async (c) => {
    const site = ownedSite(c);
    if (!site) return c.redirect('/account');
    if (!billing.limits(c.get('user').id).customDomains) {
      return back(c, `/account/apps/${site.id}`, 'error', 'Your plan does not include custom domains. Upgrade to connect your own domain.');
    }

    const r = domains.add(site, (await c.req.parseBody()).hostname);
    return back(c, `/account/apps/${site.id}`, r.error ? 'error' : 'ok', r.error || 'Domain added. Now add the DNS records below.');
  });

  app.post('/account/domains/:id/verify', async (c) => {
    const d = domains.getOwned(Number(c.req.param('id')), c.get('user').id);
    if (!d) return c.redirect('/account');
    const r = await domains.verify(d);
    const path = `/account/apps/${d.site_id}`;
    if (!r.ok) return back(c, path, 'error', r.error);
    return r.warning ? back(c, path, 'warn', r.warning) : back(c, path, 'ok', `${d.hostname} is connected. HTTPS is issued on the first visit.`);
  });

  app.post('/account/domains/:id/delete', (c) => {
    const d = domains.getOwned(Number(c.req.param('id')), c.get('user').id);
    if (d) domains.remove(d);
    return back(c, d ? `/account/apps/${d.site_id}` : '/account', 'ok', 'Domain removed.');
  });

  // ---------- JSON API used by the builder (web: cookie; desktop: bearer) ----------
  app.get('/api/platform/auth-check', (c) => {
    const user = currentUser(c);

    if (user) {
      const uri = c.req.header('x-forwarded-uri') || '';

      // AI requests need credits.
      if (/^\/api\/(chat|llmcall|enhancer)\b/.test(uri) && !billing.hasCredits(user.id)) {
        return c.json({ error: "You've used all your Makelo credits. Upgrade your plan or wait for your monthly credits to renew." }, 402);
      }

      c.header('X-Makelo-User', String(user.id));
      return c.text('ok');
    }

    const wantsHtml = (c.req.header('accept') || '').includes('text/html');
    const uri = c.req.header('x-forwarded-uri') || '/';

    return wantsHtml ? c.redirect(`/account/login?next=${encodeURIComponent(safeNext(uri))}`) : c.json({ error: 'Log in to Makelo first.' }, 401);
  });

  app.use('/api/platform/*', async (c, next) => {
    if (c.req.path === '/api/platform/auth-check') return next();
    const user = currentUser(c);
    if (!user) return c.json({ error: 'Log in to Makelo first.' }, 401);
    if (c.req.method === 'POST' && !sameOrigin(c)) return c.json({ error: 'Bad origin' }, 403);
    c.set('user', user);
    await next();
  });

  const siteJson = (s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    url: sites.siteUrl(s),
    chatId: s.chat_id,
    published: Boolean(s.current_deploy),
    domains: domains.forSite(s.id).map((d) => ({ hostname: d.hostname, verified: Boolean(d.verified_at) })),
    settingsUrl: `${config.scheme}://${config.appHost}/account/apps/${s.id}`,
  });

  app.get('/api/platform/me', (c) => {
    const u = c.get('user');
    const sub = billing.subscription(u.id);
    return c.json({ user: { id: u.id, email: u.email, plan: sub?.plan?.name || null, credits: billing.balance(u.id) } });
  });
  app.get('/api/platform/sites', (c) => c.json({ sites: sites.list(c.get('user').id).map(siteJson) }));

  app.post(
    '/api/platform/publish',
    bodyLimit({ maxSize: Math.ceil(config.maxDeployBytes * 1.4) + 1_000_000, onError: (c) => c.json({ error: 'App is too large to publish.' }, 413) }),
    async (c) => {
      let body;

      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const ensured = sites.ensureForChat(c.get('user').id, {
        name: body.name,
        chatId: body.chatId,
        maxApps: billing.limits(c.get('user').id).maxApps,
      });

      if (ensured.error) {
        return c.json({ error: ensured.error }, 400);
      }

      const result = sites.deploy(ensured.site, body.files);

      if (result.error) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ site: siteJson(result.site), deployId: result.deployId, files: result.files, bytes: result.bytes });
    },
  );

  // ---------- cloud sandboxes (replace in-browser WebContainers) ----------
  const sbxError = (c, err) => {
    const status = err.status || (err.code === 'ENOENT' || err.name === 'NotFoundError' || err.name === 'FileNotFoundError' ? 404 : 500);
    return c.json({ error: status === 404 && !err.status ? 'ENOENT: no such file or directory' : err.message || 'Sandbox error', code: status === 404 ? 'ENOENT' : undefined }, status);
  };

  app.get('/api/platform/sandbox/config', (c) =>
    c.json({ enabled: Boolean(sandboxes?.configured()), provider: sandboxes?.providerName || null, usedSecondsThisMonth: sandboxes ? sandboxes.usageThisMonth(c.get('user').id) : 0, monthlyLimitSeconds: config.sandboxMonthlySeconds }),
  );

  app.post('/api/platform/sandbox', async (c) => {
    if (!sandboxes) return c.json({ error: 'Cloud sandboxes are not enabled on this server.' }, 503);

    try {
      const { project } = await c.req.json();
      if (!billing.hasCredits(c.get('user').id)) {
        return c.json({ error: "You've used all your Makelo credits. Upgrade your plan to keep building." }, 402);
      }

      return c.json(await sandboxes.open(c.get('user').id, project));
    } catch (err) {
      return sbxError(c, err);
    }
  });

  app.use('/api/platform/sandbox/:token/*', async (c, next) => {
    const session = sandboxes?.get(c.req.param('token'), c.get('user').id);
    if (!session) return c.json({ error: 'Sandbox session expired — reload the page.' }, 410);
    c.set('sbx', session);
    await next();
  });

  app.get('/api/platform/sandbox/:token/events', (c) => {
    const session = c.get('sbx');

    return streamSSE(c, async (stream) => {
      let open = true;
      const queue = [];
      let wake = null;
      const detach = sandboxes.attach(session, (ev) => {
        queue.push(ev);
        wake?.();
      });

      stream.onAbort(() => {
        open = false;
        wake?.();
      });

      await stream.writeSSE({ event: 'ready', data: '{}' });

      while (open && !session.closed) {
        if (!queue.length) {
          await Promise.race([new Promise((r) => (wake = r)), stream.sleep(15_000)]);
          wake = null;

          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
        }

        const batch = queue.splice(0, 200);
        await stream.writeSSE({ event: 'batch', data: JSON.stringify(batch) });
      }

      detach();
    });
  });

  const sbxBody = bodyLimit({ maxSize: 40 * 1024 * 1024, onError: (c) => c.json({ error: 'File too large' }, 413) });

  app.post('/api/platform/sandbox/:token/fs', sbxBody, async (c) => {
    try {
      return c.json(await sandboxes.fs(c.get('sbx'), await c.req.json()));
    } catch (err) {
      return sbxError(c, err);
    }
  });

  app.post('/api/platform/sandbox/:token/spawn', async (c) => {
    try {
      return c.json(await sandboxes.spawn(c.get('sbx'), await c.req.json()));
    } catch (err) {
      return sbxError(c, err);
    }
  });

  app.post('/api/platform/sandbox/:token/input', async (c) => {
    try {
      const { pid, data } = await c.req.json();
      await sandboxes.input(c.get('sbx'), Number(pid), data);
      return c.json({ ok: true });
    } catch (err) {
      return sbxError(c, err);
    }
  });

  app.post('/api/platform/sandbox/:token/resize', async (c) => {
    const { pid, cols, rows } = await c.req.json();
    await sandboxes.resize(c.get('sbx'), Number(pid), cols, rows).catch(() => {});
    return c.json({ ok: true });
  });

  app.post('/api/platform/sandbox/:token/kill', async (c) => {
    const { pid } = await c.req.json();
    await sandboxes.kill(c.get('sbx'), Number(pid)).catch(() => {});
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // ---------- serving published apps ----------
  function serveSite(c) {
    const host = hostOf(c);
    let site = null;

    if (host.endsWith(`.${config.sitesDomain}`)) {
      const label = host.slice(0, -(config.sitesDomain.length + 1));
      site = label.includes('.') ? null : sites.bySlug(label);
    } else {
      site = domains.siteForHost(host) || domains.siteForHost(host.replace(/^www\./, ''));
    }

    if (!site) {
      return c.html(placeholderPage({ title: 'Nothing here yet', message: `No app is connected to ${host}.`, href: PH(config) }), 404);
    }

    if (!site.current_deploy) {
      return c.html(placeholderPage({ title: `${site.name} is coming soon`, message: 'This app has not been published yet.', href: PH(config) }), 404);
    }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Method not allowed', 405);
    }

    const file = sites.resolveFile(site, c.req.path);

    if (!file) {
      return c.html(placeholderPage({ title: 'Page not found', message: 'This page does not exist in the app.', href: PH(config) }), 404);
    }

    const type = contentType(file);
    const immutable = /\/assets\/|\.[0-9a-f]{8,}\./i.test(file);

    return new Response(c.req.method === 'HEAD' ? null : fs.readFileSync(file), {
      headers: {
        'Content-Type': type,
        'Cache-Control': type.startsWith('text/html') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return { app, db, auth, sites, domains, sandboxes, settings, billing, payments };
}
