import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { decrypt, encrypt } from '../src/secrets.js';
import { createApp } from '../src/server.js';

const APP = 'app.makelo.test';
const ADMIN = 'admin.makelo.test';

function setup(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-admin-'));
  const config = loadConfig({
    APP_HOST: APP,
    ADMIN_HOST: ADMIN,
    SITES_DOMAIN: 'makelo.test',
    DATA_DIR: dataDir,
    SECURE_COOKIES: 'false',
    PUBLIC_SCHEME: 'http',
    ADMIN_EMAILS: 'boss@example.com',
    SANDBOX_PROVIDER: 'off',
    ...extra,
  });
  const ctx = createApp(config);
  const req = (host, url, { method = 'GET', cookie, form, body, headers = {} } = {}) => {
    const h = { host, ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (form) {
      payload = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    if (method === 'POST' && !('origin' in headers)) h.origin = `http://${host}`;
    return ctx.app.request(`http://${host}${url}`, { method, headers: h, body: payload });
  };
  const signup = async (email) => {
    const r = await req(APP, '/account/signup', { method: 'POST', form: { email, password: 'supersecret1' } });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const adminLogin = async (email) => {
    const r = await req(ADMIN, '/login', { method: 'POST', form: { email, password: 'supersecret1' } });
    return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ctx, req, signup, adminLogin, dataDir };
}

test('secrets are encrypted at rest and round-trip', () => {
  const key = Buffer.alloc(32, 7);
  const enc = encrypt(key, 'sk-test-123');
  assert.doesNotMatch(enc, /sk-test/);
  assert.equal(decrypt(key, enc), 'sk-test-123');
  assert.throws(() => decrypt(Buffer.alloc(32, 8), enc));
});

test('admin dashboard is only for admins, on its own host', async () => {
  const { req, signup, adminLogin } = setup();
  await signup('user@example.com');
  await signup('boss@example.com');

  assert.equal((await req(ADMIN, '/')).headers.get('location'), '/login');
  assert.equal((await adminLogin('user@example.com')).status, 403);

  const { status, cookie } = await adminLogin('boss@example.com');
  assert.equal(status, 303);
  const home = await req(ADMIN, '/', { cookie });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Overview/);

  // The normal app session does not open the admin, and the admin cookie does not leak to the app host
  const userCookie = await signup('other@example.com');
  assert.equal((await req(ADMIN, '/', { cookie: userCookie })).headers.get('location'), '/login');

  // Cross-site posts are refused
  const evil = await req(ADMIN, '/keys', { method: 'POST', cookie, form: { env: 'OPENAI_API_KEY', value: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('admin saves API keys encrypted; builder fetches them internally', async () => {
  const { ctx, req, signup, adminLogin, dataDir } = setup();
  await signup('boss@example.com');
  const { cookie } = await adminLogin('boss@example.com');

  const save = await req(ADMIN, '/keys', { method: 'POST', cookie, form: { env: 'OPENAI_API_KEY', value: 'sk-live-abcdef123456' } });
  assert.match(decodeURIComponent(save.headers.get('location')), /ok=OpenAI key saved/);

  const raw = ctx.db.prepare("SELECT value FROM settings WHERE key = 'key:OPENAI_API_KEY'").get().value;
  assert.doesNotMatch(raw, /sk-live/);
  assert.ok(fs.existsSync(path.join(dataDir, 'secret.key')));

  const page = await (await req(ADMIN, '/keys', { cookie })).text();
  assert.match(page, /sk-l••••3456/);
  assert.doesNotMatch(page, /sk-live-abcdef123456/);

  const keys = await (await req('platform', '/internal/provider-keys')).json();
  assert.equal(keys.keys.OPENAI_API_KEY, 'sk-live-abcdef123456');
  assert.equal(keys.keys.STRIPE_SECRET_KEY, undefined);

  await req(ADMIN, '/keys', { method: 'POST', cookie, form: { env: 'OPENAI_API_KEY', clear: '1' } });
  assert.equal((await (await req('platform', '/internal/provider-keys')).json()).keys.OPENAI_API_KEY, undefined);
});

test('internal API requires the shared secret when one is set', async () => {
  const { req } = setup({ INTERNAL_SECRET: 's3cret' });
  assert.equal((await req('platform', '/internal/provider-keys')).status, 403);
  assert.equal((await req('platform', '/internal/provider-keys', { headers: { 'x-internal-secret': 's3cret' } })).status, 200);
});

test('plans: admin creates a plan, assigns it, credits follow the plan', async () => {
  const { ctx, req, signup, adminLogin } = setup();
  await signup('boss@example.com');
  await signup('maker@example.com');
  const { cookie } = await adminLogin('boss@example.com');
  const maker = ctx.auth.userByEmail('maker@example.com');

  // New users start on Free with its credits
  assert.equal(ctx.billing.subscription(maker.id).plan.slug, 'free');
  assert.equal(ctx.billing.balance(maker.id), 100);

  const create = await req(ADMIN, '/plans', {
    method: 'POST',
    cookie,
    form: { name: 'Agency', slug: 'agency', price: '99.50', currency: 'GBP', monthly_credits: '50000', max_apps: '500', custom_domains: '1', visible: '1' },
  });
  assert.match(decodeURIComponent(create.headers.get('location')), /Agency.*created/);
  const agency = ctx.billing.plans().find((p) => p.slug === 'agency');
  assert.equal(agency.price_cents, 9950);

  await req(ADMIN, `/users/${maker.id}/plan`, { method: 'POST', cookie, form: { plan_id: String(agency.id) } });
  assert.equal(ctx.billing.balance(maker.id), 50000);
  assert.equal(ctx.billing.limits(maker.id).maxApps, 500);

  await req(ADMIN, `/users/${maker.id}/credits`, { method: 'POST', cookie, form: { delta: '-49990', note: 'test' } });
  assert.equal(ctx.billing.balance(maker.id), 10);

  const plansPage = await (await req(ADMIN, '/plans', { cookie })).text();
  assert.match(plansPage, /Agency/);
  assert.match(plansPage, /£99\.50/);
});

test('AI usage is metered and blocks when credits run out', async () => {
  const { ctx, req, signup } = setup();
  const cookie = await signup('maker@example.com');
  const maker = ctx.auth.userByEmail('maker@example.com');

  // 30k input + 10k output tokens = 30*1 + 10*3 = 60 credits (default rates)
  const r = await (await req('platform', '/internal/usage', { method: 'POST', body: { userId: maker.id, provider: 'OpenAI', model: 'gpt-5', inputTokens: 30000, outputTokens: 10000 } })).json();
  assert.equal(r.charged, 60);
  assert.equal(r.balance, 40);

  const ok = await req(APP, '/api/platform/auth-check', { cookie, headers: { 'x-forwarded-uri': '/api/chat' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-makelo-user'), String(maker.id));

  ctx.billing.adjust(maker.id, -40, 'drain');
  const blocked = await req(APP, '/api/platform/auth-check', { cookie, headers: { 'x-forwarded-uri': '/api/chat', accept: 'application/json' } });
  assert.equal(blocked.status, 402);
  // Non-AI pages still load
  assert.equal((await req(APP, '/api/platform/auth-check', { cookie, headers: { 'x-forwarded-uri': '/chat/abc' } })).status, 200);

  // Sandbox time is charged per minute
  ctx.billing.adjust(maker.id, 100, 'top up');
  assert.equal(ctx.billing.chargeSandbox(maker.id, 150), 3);
  assert.equal(ctx.billing.balance(maker.id), 97);
});

test('plan limits: free plan cannot add custom domains', async () => {
  const { ctx, req, signup } = setup();
  const cookie = await signup('maker@example.com');
  const files = { '/index.html': Buffer.from('hi').toString('base64') };
  const { site } = await (await req(APP, '/api/platform/publish', { method: 'POST', cookie, body: { name: 'A', files } })).json();
  const r = await req(APP, `/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'myshop.com' } });
  assert.match(decodeURIComponent(r.headers.get('location')), /does not include custom domains/);
  assert.equal(ctx.domains.forSite(site.id).length, 0);
});

test('admin can suspend a user, which signs them out', async () => {
  const { ctx, req, signup, adminLogin } = setup();
  await signup('boss@example.com');
  const userCookie = await signup('bad@example.com');
  const { cookie } = await adminLogin('boss@example.com');
  const bad = ctx.auth.userByEmail('bad@example.com');

  await req(ADMIN, `/users/${bad.id}/suspend`, { method: 'POST', cookie, form: { suspend: '1' } });
  assert.equal((await req(APP, '/api/platform/me', { cookie: userCookie })).status, 401);
  const login = await req(APP, '/account/login', { method: 'POST', form: { email: 'bad@example.com', password: 'supersecret1' } });
  assert.match(await login.text(), /suspended/);

  // Admin cannot suspend themselves
  const boss = ctx.auth.userByEmail('boss@example.com');
  await req(ADMIN, `/users/${boss.id}/suspend`, { method: 'POST', cookie, form: { suspend: '1' } });
  assert.equal(ctx.auth.userById(boss.id).suspended_at, null);
});

test('every admin page renders', async () => {
  const { ctx, req, signup, adminLogin } = setup();
  await signup('boss@example.com');
  const { cookie } = await adminLogin('boss@example.com');
  const boss = ctx.auth.userByEmail('boss@example.com');
  for (const p of ['/', '/users', `/users/${boss.id}`, '/plans', '/plans/1', '/usage', '/usage?kind=ai', '/keys', '/settings']) {
    const r = await req(ADMIN, p, { cookie });
    assert.equal(r.status, 200, p);
  }
  const save = await req(ADMIN, '/settings', { method: 'POST', cookie, form: { credits_per_1k_input: '2', credits_per_1k_output: '5', credits_per_sandbox_minute: '0.5', signup_bonus_credits: '10', currency: 'usd', default_plan_id: '2' } });
  assert.match(decodeURIComponent(save.headers.get('location')), /Settings saved/);
  assert.equal(ctx.billing.rate('credits_per_1k_output'), 5);
  assert.equal(ctx.billing.rate('currency'), 'USD');
  assert.equal(ctx.billing.defaultPlan().slug, 'pro');
});
