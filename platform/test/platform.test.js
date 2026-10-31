import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { safeRelPath, slugify } from '../src/sites.js';

const APP = 'app.clickmyapp.test';

function setup(dnsRecords = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-'));
  const config = loadConfig({
    APP_HOST: APP,
    SITES_DOMAIN: 'clickmyapp.test',
    DATA_DIR: dataDir,
    SECURE_COOKIES: 'false',
    PUBLIC_SCHEME: 'http',
    SERVER_IPV4: '203.0.113.10',
  });
  const resolver = {
    resolveTxt: async (h) => (dnsRecords.txt?.[h] ? [[dnsRecords.txt[h]]] : Promise.reject(new Error('ENODATA'))),
    resolveCname: async (h) => dnsRecords.cname?.[h] || Promise.reject(new Error('ENODATA')),
    resolve4: async (h) => dnsRecords.a?.[h] || Promise.reject(new Error('ENODATA')),
  };
  const ctx = createApp(config, { resolver });

  const req = (url, { host = APP, method = 'GET', cookie, body, form, headers = {} } = {}) => {
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

  async function signup(email = 'kmik@example.com', password = 'correct-horse-1') {
    const res = await req('/account/signup', { method: 'POST', form: { email, password } });
    assert.equal(res.status, 303);
    return res.headers.get('set-cookie').split(';')[0];
  }

  const files = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));

  return { ctx, config, req, signup, files, dnsRecords };
}

test('slug and path helpers', () => {
  assert.equal(slugify('My Café Shop!!'), 'my-cafe-shop');
  assert.equal(safeRelPath('/assets/app.js'), 'assets/app.js');
  assert.equal(safeRelPath('../../etc/passwd'), 'etc/passwd'); // normalised inside the deploy root
  assert.equal(safeRelPath('/a/../../b'), 'b');
  assert.equal(safeRelPath('/.git/config'), null);
  assert.equal(safeRelPath('a\\b'), null);
  assert.equal(safeRelPath('/'), null);
});

test('signup, login, logout and bad passwords', async () => {
  const { req, signup } = setup();
  const cookie = await signup();

  const me = await req('/api/platform/me', { cookie });
  assert.equal((await me.json()).user.email, 'kmik@example.com');

  const dup = await req('/account/signup', { method: 'POST', form: { email: 'KMIK@example.com', password: 'whatever123' } });
  assert.equal(dup.status, 400);

  const bad = await req('/account/login', { method: 'POST', form: { email: 'kmik@example.com', password: 'nope-nope' } });
  assert.equal(bad.status, 400);

  const good = await req('/account/login', { method: 'POST', form: { email: 'kmik@example.com', password: 'correct-horse-1' } });
  assert.equal(good.status, 303);

  await req('/account/logout', { method: 'POST', cookie });
  assert.equal((await req('/api/platform/me', { cookie })).status, 401);
});

test('cross-site form posts are rejected', async () => {
  const { req, signup } = setup();
  const cookie = await signup();
  const res = await req('/api/platform/publish', { method: 'POST', cookie, body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('auth-check redirects browsers to login and lets users through', async () => {
  const { req, signup } = setup();
  const anon = await req('/api/platform/auth-check', { headers: { accept: 'text/html', 'x-forwarded-uri': '/chat/abc' } });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/account/login?next=%2Fchat%2Fabc');
  const api = await req('/api/platform/auth-check', { headers: { accept: 'application/json' } });
  assert.equal(api.status, 401);
  const cookie = await signup();
  assert.equal((await req('/api/platform/auth-check', { cookie })).status, 200);
});

test('publish goes live on a free subdomain, with SPA fallback and binary files', async () => {
  const { req, signup, files } = setup();
  const cookie = await signup();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);

  const res = await req('/api/platform/publish', {
    method: 'POST',
    cookie,
    body: {
      name: 'Pizza Orders',
      chatId: 'chat-1',
      files: { ...files({ '/index.html': '<h1>Pizza</h1>', '/assets/app.js': 'console.log(1)' }), '/logo.png': png.toString('base64') },
    },
  });
  assert.equal(res.status, 200);
  const { site } = await res.json();
  assert.match(site.slug, /^pizza-orders-[0-9a-f]{4}$/);
  assert.equal(site.url, `http://${site.slug}.clickmyapp.test`);

  const host = `${site.slug}.clickmyapp.test`;
  assert.equal(await (await req('/', { host })).text(), '<h1>Pizza</h1>');
  assert.equal(await (await req('/menu/today', { host })).text(), '<h1>Pizza</h1>'); // SPA route
  assert.equal((await req('/missing.js', { host })).status, 404);
  const img = await req('/logo.png', { host });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.match((await req('/assets/app.js', { host })).headers.get('cache-control'), /immutable/);

  // Re-publishing the same chat updates the same site
  const again = await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'Pizza Orders', chatId: 'chat-1', files: files({ '/index.html': 'v2' }) } });
  assert.equal((await again.json()).site.id, site.id);
  assert.equal(await (await req('/', { host })).text(), 'v2');
});

test('publish validation', async () => {
  const { req, signup, files } = setup();
  const cookie = await signup();
  const noIndex = await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'x', files: files({ '/a.js': '1' }) } });
  assert.match((await noIndex.json()).error, /index\.html/);
  const sneaky = await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'x', files: files({ '/index.html': 'ok', '/.git/config': 'x' }) } });
  assert.equal(sneaky.status, 400);
  const anon = await req('/api/platform/publish', { method: 'POST', body: { name: 'x', files: files({ '/index.html': 'ok' }) } });
  assert.equal(anon.status, 401);
});

test("users can't see or change each other's apps", async () => {
  const { req, signup, files } = setup();
  const a = await signup('a@example.com');
  const b = await signup('b@example.com');
  const { site } = await (await req('/api/platform/publish', { method: 'POST', cookie: a, body: { name: 'A', files: files({ '/index.html': 'a' }) } })).json();

  assert.equal((await (await req('/api/platform/sites', { cookie: b })).json()).sites.length, 0);
  const steal = await req(`/account/apps/${site.id}/slug`, { method: 'POST', cookie: b, form: { slug: 'stolen' } });
  assert.equal(steal.headers.get('location'), '/account');
  assert.equal((await req(`/account/apps/${site.id}`, { cookie: b })).headers.get('location'), '/account');
});

test('custom domain: add, verify via DNS, serve, and allow TLS', async () => {
  const dnsRecords = { txt: {}, cname: {}, a: {} };
  const { req, signup, files, ctx } = setup(dnsRecords);
  const cookie = await signup();
  const { site } = await (await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'Shop', files: files({ '/index.html': 'shop' }) } })).json();

  const add = await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'https://App.MyShop.com/' } });
  assert.match(decodeURIComponent(add.headers.get('location')), /Domain added/);
  const domain = ctx.domains.forSite(site.id)[0];
  assert.equal(domain.hostname, 'app.myshop.com');

  // Not verified yet: not served, no certificate
  assert.equal((await req('/', { host: 'app.myshop.com' })).status, 404);
  assert.equal((await req('/internal/tls-ask?domain=app.myshop.com', { host: 'platform' })).status, 404);

  const fail = await req(`/account/domains/${domain.id}/verify`, { method: 'POST', cookie });
  assert.match(decodeURIComponent(fail.headers.get('location')), /error=TXT record not found/);

  dnsRecords.txt['_clickmyapp-verify.app.myshop.com'] = domain.verify_token;
  dnsRecords.cname['app.myshop.com'] = ['sites.clickmyapp.test.'];
  const ok = await req(`/account/domains/${domain.id}/verify`, { method: 'POST', cookie });
  assert.match(decodeURIComponent(ok.headers.get('location')), /ok=app\.myshop\.com is connected/);

  assert.equal(await (await req('/', { host: 'app.myshop.com' })).text(), 'shop');
  assert.equal((await req('/internal/tls-ask?domain=app.myshop.com', { host: 'platform' })).status, 200);
  assert.equal((await req(`/internal/tls-ask?domain=${site.slug}.clickmyapp.test`, { host: 'platform' })).status, 200);
  assert.equal((await req('/internal/tls-ask?domain=random.example.org', { host: 'platform' })).status, 404);
  assert.equal((await req('/internal/tls-ask?domain=nope-0000.clickmyapp.test', { host: 'platform' })).status, 404);

  const dupe = await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'app.myshop.com' } });
  assert.match(decodeURIComponent(dupe.headers.get('location')), /already connected to another app/);
  const own = await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'x.clickmyapp.test' } });
  assert.match(decodeURIComponent(own.headers.get('location')), /error=/);
});

test('apex domain asks for an A record', async () => {
  const { req, signup, files, ctx } = setup();
  const cookie = await signup();
  const { site } = await (await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'Apex', files: files({ '/index.html': 'x' }) } })).json();
  await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'myshop.com' } });
  const d = ctx.domains.forSite(site.id)[0];
  const rec = ctx.domains.instructions(d, site);
  assert.deepEqual(rec.map((r) => r.type), ['TXT', 'A']);
  assert.equal(rec[1].value, '203.0.113.10');

  await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'bakeryshop.co.uk' } });
  await req(`/account/apps/${site.id}/domains`, { method: 'POST', cookie, form: { hostname: 'app.bakeryshop.co.uk' } });
  const byHost = Object.fromEntries(ctx.domains.forSite(site.id).map((x) => [x.hostname, ctx.domains.instructions(x, site)[1].type]));
  assert.equal(byHost['bakeryshop.co.uk'], 'A');
  assert.equal(byHost['app.bakeryshop.co.uk'], 'CNAME');
});

test('desktop app publishes with a bearer token and CORS', async () => {
  const { req, signup, files, ctx } = setup();
  await signup();
  const token = ctx.auth.createApiToken(1, 'laptop');
  const pre = await req('/api/platform/publish', { method: 'OPTIONS', headers: { origin: 'app://-', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'app://-');

  const res = await req('/api/platform/publish', {
    method: 'POST',
    body: { name: 'Desk', files: files({ '/index.html': 'desk' }) },
    headers: { authorization: `Bearer ${token}`, origin: 'app://-' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'app://-');

  const bad = await req('/api/platform/me', { headers: { authorization: 'Bearer cma_wrong' } });
  assert.equal(bad.status, 401);
});

test('reserved and taken subdomains are refused', async () => {
  const { req, signup, files } = setup();
  const cookie = await signup();
  const { site } = await (await req('/api/platform/publish', { method: 'POST', cookie, body: { name: 'One', files: files({ '/index.html': '1' }) } })).json();
  for (const slug of ['app', 'www', 'Bad_Slug', '-x']) {
    const r = await req(`/account/apps/${site.id}/slug`, { method: 'POST', cookie, form: { slug } });
    assert.match(decodeURIComponent(r.headers.get('location')), /error=/, slug);
  }
  const ok = await req(`/account/apps/${site.id}/slug`, { method: 'POST', cookie, form: { slug: 'my-pizza' } });
  assert.match(decodeURIComponent(ok.headers.get('location')), /ok=/);
  assert.equal(await (await req('/', { host: 'my-pizza.clickmyapp.test' })).text(), '1');
});

test('dashboard and app pages render and escape user input', async () => {
  const { req, signup, files } = setup();
  const cookie = await signup();
  const { site } = await (await req('/api/platform/publish', { method: 'POST', cookie, body: { name: '<script>alert(1)</script>', files: files({ '/index.html': '1' }) } })).json();
  const dash = await (await req('/account', { cookie })).text();
  assert.ok(dash.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!dash.includes('<script>alert(1)'));
  const page = await req(`/account/apps/${site.id}`, { cookie });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Your own domain'));
});

test('an unverified claim cannot block the real owner', async () => {
  const dnsRecords = { txt: {}, cname: {}, a: {} };
  const { req, signup, files, ctx } = setup(dnsRecords);
  const squatter = await signup('squat@example.com');
  const owner = await signup('owner@example.com');
  const pub = async (cookie, name) =>
    (await (await req('/api/platform/publish', { method: 'POST', cookie, body: { name, files: files({ '/index.html': name }) } })).json()).site;
  const s1 = await pub(squatter, 'Squat');
  const s2 = await pub(owner, 'Real');

  await req(`/account/apps/${s1.id}/domains`, { method: 'POST', cookie: squatter, form: { hostname: 'realbiz.com' } });
  const add = await req(`/account/apps/${s2.id}/domains`, { method: 'POST', cookie: owner, form: { hostname: 'realbiz.com' } });
  assert.match(decodeURIComponent(add.headers.get('location')), /ok=Domain added/);

  const real = ctx.domains.forSite(s2.id)[0];
  dnsRecords.txt['_clickmyapp-verify.realbiz.com'] = real.verify_token;
  dnsRecords.a['realbiz.com'] = ['203.0.113.10'];

  // The squatter cannot verify (their token is not in DNS)
  const squatClaim = ctx.domains.forSite(s1.id)[0];
  const sv = await req(`/account/domains/${squatClaim.id}/verify`, { method: 'POST', cookie: squatter });
  assert.match(decodeURIComponent(sv.headers.get('location')), /error=/);

  const ov = await req(`/account/domains/${real.id}/verify`, { method: 'POST', cookie: owner });
  assert.match(decodeURIComponent(ov.headers.get('location')), /ok=realbiz\.com is connected/);
  assert.equal(await (await req('/', { host: 'realbiz.com' })).text(), 'Real');
  assert.equal(ctx.domains.forSite(s1.id).length, 0); // squatter's claim removed
});
