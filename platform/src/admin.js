import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  adminLayout,
  adminLoginPage,
  keysPage,
  overviewPage,
  planPage,
  plansPage,
  settingsPage,
  usagePage,
  userPage,
  usersPage,
} from './admin-views.js';
import { RATE_DEFAULTS } from './billing.js';
import { normalizeHostname } from './domains.js';
import { KEY_CATALOG } from './secrets.js';

const DAY = 86400_000;

/**
 * Admin dashboard, served on its own host (ADMIN_HOST, e.g. admin.makelo.com) with its own
 * session cookie. Only users with role "admin" can sign in. People listed in ADMIN_EMAILS are
 * promoted to admin the first time they sign in here.
 */
export function createAdminApp({ db, config, auth, sites, billing, settings, sandboxes, limitAuth }) {
  const app = new Hono();
  const cookieName = config.secureCookies ? '__Host-mk_admin' : 'mk_admin';
  const bootstrapAdmins = new Set(
    String(config.adminEmails || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  const q = {
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countUsersSince: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?'),
    paying: db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(p.price_cents), 0) AS cents FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active' AND p.price_cents > 0",
    ),
    publishedApps: db.prepare('SELECT COUNT(*) AS n FROM sites WHERE current_deploy IS NOT NULL'),
    domains: db.prepare('SELECT COUNT(*) AS n FROM domains WHERE verified_at IS NOT NULL'),
    usedByKind: db.prepare(
      'SELECT kind, COALESCE(-SUM(delta), 0) AS used FROM credit_ledger WHERE delta < 0 AND created_at >= ? GROUP BY kind',
    ),
    granted: db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE delta > 0 AND created_at >= ?'),
    daily: db.prepare(
      "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, -SUM(delta) AS used FROM credit_ledger WHERE delta < 0 AND created_at >= ? GROUP BY day",
    ),
    tokens: db.prepare(
      "SELECT COALESCE(SUM(json_extract(meta, '$.inputTokens') + json_extract(meta, '$.outputTokens')), 0) AS n FROM credit_ledger WHERE kind = 'ai' AND created_at >= ?",
    ),
    recentUsers: db.prepare(
      'SELECT u.id, u.email, u.created_at, p.name AS plan FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN plans p ON p.id = s.plan_id ORDER BY u.created_at DESC LIMIT 8',
    ),
    topUsers: db.prepare(
      'SELECT u.id, u.email, -SUM(l.delta) AS used FROM credit_ledger l JOIN users u ON u.id = l.user_id WHERE l.delta < 0 AND l.created_at >= ? GROUP BY u.id ORDER BY used DESC LIMIT 8',
    ),
    users: db.prepare(
      `SELECT u.id, u.email, u.role, u.suspended_at, u.created_at, p.name AS plan,
         (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger l WHERE l.user_id = u.id) AS balance,
         (SELECT COUNT(*) FROM sites x WHERE x.user_id = u.id) AS apps
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN plans p ON p.id = s.plan_id
       WHERE u.email LIKE ? ORDER BY u.created_at DESC LIMIT 200`,
    ),
    user: db.prepare('SELECT id, email, role, suspended_at, created_at FROM users WHERE id = ?'),
    userLedger: db.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 60'),
    ledger: db.prepare(
      'SELECT l.*, u.email FROM credit_ledger l JOIN users u ON u.id = l.user_id WHERE (? = \'\' OR l.kind = ?) ORDER BY l.id DESC LIMIT 200',
    ),
  };

  const hostOf = (c) => normalizeHostname(c.req.header('host') || '');
  const appUrl = `${config.scheme}://${config.appHost}`;
  const flashFrom = (c) => {
    const ok = c.req.query('ok');
    const err = c.req.query('error');
    return err ? { type: 'error', message: err } : ok ? { type: 'ok', message: ok } : null;
  };
  const back = (c, path, kind, message) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}`, 303);

  function sameOrigin(c) {
    const origin = c.req.header('origin') || c.req.header('referer');

    try {
      return Boolean(origin) && normalizeHostname(new URL(origin).host) === hostOf(c);
    } catch {
      return false;
    }
  }

  const page = (c, title, body) =>
    c.html(adminLayout({ title, admin: c.get('admin'), path: c.req.path, body, flash: flashFrom(c), appUrl }));

  // ---------- sign in ----------
  app.get('/login', (c) => c.html(adminLoginPage({})));

  app.post('/login', async (c) => {
    if (!sameOrigin(c)) {
      return c.text('Bad origin', 403);
    }

    const form = await c.req.parseBody();
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';

    if (!limitAuth(`admin:${ip}`)) {
      return c.html(adminLoginPage({ error: 'Too many attempts. Wait 10 minutes.', email: form.email }), 429);
    }

    const result = await auth.login(form.email, form.password);

    if (result.error) {
      return c.html(adminLoginPage({ error: result.error, email: form.email }), 400);
    }

    let user = result.user;

    if (user.role !== 'admin' && bootstrapAdmins.has(user.email)) {
      auth.setRole(user.id, 'admin');
      user = { ...user, role: 'admin' };
    }

    if (user.role !== 'admin') {
      return c.html(adminLoginPage({ error: 'This account does not have admin access.', email: form.email }), 403);
    }

    setCookie(c, cookieName, auth.startSession(user.id), {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: 12 * 3600,
    });

    return c.redirect('/', 303);
  });

  app.post('/logout', (c) => {
    auth.endSession(getCookie(c, cookieName));
    deleteCookie(c, cookieName, { path: '/', secure: config.secureCookies });
    return c.redirect('/login', 303);
  });

  // ---------- everything else requires an admin ----------
  app.use('*', async (c, next) => {
    const user = auth.userFromSession(getCookie(c, cookieName));

    if (!user || user.role !== 'admin') {
      return c.redirect('/login');
    }

    if (c.req.method === 'POST' && !sameOrigin(c)) {
      return c.text('Bad origin', 403);
    }

    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.set('admin', user);
    await next();
  });

  app.get('/', (c) => {
    const since30 = Date.now() - 30 * DAY;
    const used = Object.fromEntries(q.usedByKind.all(since30).map((r) => [r.kind, r.used]));
    const dailyMap = Object.fromEntries(q.daily.all(since30).map((r) => [r.day, r.used]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10);
      return { day, used: dailyMap[day] || 0 };
    });
    const paying = q.paying.get();
    const keyStatus = settings.keyStatus();
    const essential = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'E2B_API_KEY'];

    return page(
      c,
      'Overview',
      overviewPage({
        users: q.countUsers.get().n,
        newUsers7d: q.countUsersSince.get(Date.now() - 7 * DAY).n,
        paying: paying.n,
        mrrCents: paying.cents,
        currency: billing.rate('currency'),
        publishedApps: q.publishedApps.get().n,
        domains: q.domains.get().n,
        used30: (used.ai || 0) + (used.sandbox || 0),
        usedAi30: used.ai || 0,
        usedSandbox30: used.sandbox || 0,
        liveSandboxes: sandboxes?.liveCount() ?? 0,
        sandboxProvider: sandboxes?.configured() ? sandboxes.providerName : null,
        missingKeys: keyStatus.filter((k) => essential.includes(k.env) && k.source === 'missing').map((k) => k.label),
        daily,
        recentUsers: q.recentUsers.all(),
        topUsers: q.topUsers.all(since30),
      }),
    );
  });

  // ---------- users ----------
  app.get('/users', (c) => {
    const query = String(c.req.query('q') || '').trim();
    return page(c, 'Users', usersPage({ users: q.users.all(`%${query}%`), query }));
  });

  const loadUser = (c) => q.user.get(Number(c.req.param('id')));

  app.get('/users/:id', (c) => {
    const u = loadUser(c);

    if (!u) {
      return c.redirect('/users');
    }

    return page(
      c,
      u.email,
      userPage({
        u,
        sub: billing.subscription(u.id),
        balance: billing.balance(u.id),
        used: billing.usedThisPeriod(u.id),
        plans: billing.plans(),
        ledger: q.userLedger.all(u.id),
        apps: sites.list(u.id).map((s) => ({ ...s, url: sites.siteUrl(s) })),
        self: u.id === c.get('admin').id,
      }),
    );
  });

  app.post('/users/:id/plan', async (c) => {
    const u = loadUser(c);
    if (!u) return c.redirect('/users');
    const r = billing.changePlan(u.id, Number((await c.req.parseBody()).plan_id), `Plan set by admin ${c.get('admin').email}`);
    return back(c, `/users/${u.id}`, r.error ? 'error' : 'ok', r.error || `Moved to ${r.plan.name}.`);
  });

  app.post('/users/:id/credits', async (c) => {
    const u = loadUser(c);
    if (!u) return c.redirect('/users');
    const form = await c.req.parseBody();
    const r = billing.adjust(u.id, form.delta, `${form.note || 'Adjustment'} (by ${c.get('admin').email})`);
    return back(c, `/users/${u.id}`, r.error ? 'error' : 'ok', r.error || `Credits updated. Balance: ${r.balance}`);
  });

  app.post('/users/:id/role', async (c) => {
    const u = loadUser(c);
    if (!u || u.id === c.get('admin').id) return c.redirect('/users');
    const role = (await c.req.parseBody()).role === 'admin' ? 'admin' : 'user';
    auth.setRole(u.id, role);
    return back(c, `/users/${u.id}`, 'ok', role === 'admin' ? 'User is now an admin.' : 'Admin rights removed.');
  });

  app.post('/users/:id/suspend', async (c) => {
    const u = loadUser(c);
    if (!u || u.id === c.get('admin').id) return c.redirect('/users');
    const suspend = (await c.req.parseBody()).suspend === '1';
    auth.setSuspended(u.id, suspend);
    return back(c, `/users/${u.id}`, 'ok', suspend ? 'Account suspended and signed out.' : 'Account reactivated.');
  });

  // ---------- plans ----------
  app.get('/plans', (c) =>
    page(c, 'Plans', plansPage({ plans: billing.plans(), defaultPlanId: billing.defaultPlan()?.id, currency: billing.rate('currency') })),
  );

  app.post('/plans', async (c) => {
    const r = billing.savePlan(await c.req.parseBody());
    return back(c, '/plans', r.error ? 'error' : 'ok', r.error || `Plan "${r.plan.name}" created.`);
  });

  app.get('/plans/:id', (c) => {
    const plan = billing.plan(Number(c.req.param('id')));
    return plan ? page(c, plan.name, planPage({ plan, currency: billing.rate('currency') })) : c.redirect('/plans');
  });

  app.post('/plans/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const r = billing.savePlan({ ...(await c.req.parseBody()), id });
    return back(c, `/plans/${id}`, r.error ? 'error' : 'ok', r.error || 'Plan saved.');
  });

  app.post('/plans/:id/archive', async (c) => {
    const id = Number(c.req.param('id'));
    const archive = (await c.req.parseBody()).archived === '1';

    if (archive && billing.defaultPlan()?.id === id) {
      return back(c, `/plans/${id}`, 'error', 'This is the plan for new sign-ups. Choose another default in Settings first.');
    }

    billing.archivePlan(id, archive);
    return back(c, '/plans', 'ok', archive ? 'Plan archived.' : 'Plan restored.');
  });

  // ---------- usage ----------
  app.get('/usage', (c) => {
    const since30 = Date.now() - 30 * DAY;
    const kind = String(c.req.query('kind') || '');
    const used = Object.fromEntries(q.usedByKind.all(since30).map((r) => [r.kind, r.used]));
    const dailyMap = Object.fromEntries(q.daily.all(since30).map((r) => [r.day, r.used]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10);
      return { day, used: dailyMap[day] || 0 };
    });

    return page(
      c,
      'Credits & usage',
      usagePage({
        totals: { ai: used.ai || 0, sandbox: used.sandbox || 0, granted: q.granted.get(since30).n, tokens: q.tokens.get(since30).n },
        daily,
        entries: q.ledger.all(kind, kind),
        kind,
      }),
    );
  });

  // ---------- API keys ----------
  app.get('/keys', (c) => page(c, 'API keys', keysPage({ keys: settings.keyStatus() })));

  app.post('/keys', async (c) => {
    const form = await c.req.parseBody();
    const entry = KEY_CATALOG.find((k) => k.env === form.env);

    if (!entry) {
      return back(c, '/keys', 'error', 'Unknown key.');
    }

    if (form.clear === '1') {
      settings.remove(`key:${entry.env}`);
      return back(c, '/keys', 'ok', `${entry.label} key removed.`);
    }

    const value = String(form.value || '').trim();

    if (!value) {
      return back(c, '/keys', 'error', `Paste a value for ${entry.label} first.`);
    }

    if (value.length > 4000 || /\s/.test(value.replace(/^smtp/, ''))) {
      return back(c, '/keys', 'error', 'That does not look like a valid key (no spaces allowed).');
    }

    settings.set(`key:${entry.env}`, value, { secret: true });

    return back(c, '/keys', 'ok', `${entry.label} key saved.`);
  });

  // ---------- settings ----------
  const RATE_KEYS = Object.keys(RATE_DEFAULTS);

  app.get('/settings', (c) =>
    page(
      c,
      'Settings',
      settingsPage({
        rates: Object.fromEntries(RATE_KEYS.map((k) => [k, billing.rate(k)])),
        plans: billing.plans(),
        defaultPlanId: billing.defaultPlan()?.id,
      }),
    ),
  );

  app.post('/settings', async (c) => {
    const form = await c.req.parseBody();

    for (const k of RATE_KEYS) {
      if (form[k] === undefined) continue;

      if (k === 'currency') {
        const cur = String(form[k]).trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(cur)) settings.set('rate:currency', cur);
        continue;
      }

      const v = Number(form[k]);

      if (Number.isFinite(v) && v >= 0) {
        settings.set(`rate:${k}`, String(v));
      }
    }

    const planId = Number(form.default_plan_id);
    const plan = planId ? billing.plan(planId) : null;

    if (plan && !plan.archived) {
      settings.set('default_plan_id', String(plan.id));
    }

    return back(c, '/settings', 'ok', 'Settings saved.');
  });

  app.notFound((c) => c.redirect('/'));

  return app;
}
