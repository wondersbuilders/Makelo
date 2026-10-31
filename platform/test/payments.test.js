import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { verifyWhopSignature } from '../src/payments.js';
import { createApp } from '../src/server.js';

const APP = 'app.makelo.test';
const ADMIN = 'admin.makelo.test';
const SECRET = 'ws_test_secret_123';

function sign(body, { id = `msg_${crypto.randomBytes(4).toString('hex')}`, ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}`, 'content-type': 'application/json' };
}

function setup() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, auth: init.headers.Authorization });
    if (url.endsWith('/checkout_configurations')) {
      return new Response(JSON.stringify({ id: 'ch_123', purchase_url: '/checkout/ch_123/' }), { status: 200 });
    }
    if (/\/memberships\/.+\/cancel$/.test(url)) {
      return new Response(JSON.stringify({ id: 'mem', status: 'canceling' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  };
  const config = loadConfig({
    APP_HOST: APP,
    ADMIN_HOST: ADMIN,
    SITES_DOMAIN: 'makelo.test',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pay-')),
    SECURE_COOKIES: 'false',
    PUBLIC_SCHEME: 'http',
    ADMIN_EMAILS: 'boss@example.com',
    SANDBOX_PROVIDER: 'off',
  });
  const ctx = createApp(config, { fetchImpl });
  const req = (host, url, { method = 'GET', cookie, form, raw, headers = {} } = {}) => {
    const h = { host, ...headers };
    if (cookie) h.cookie = cookie;
    let body = raw;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
      if (!h.origin) h.origin = `http://${host}`;
    }
    return ctx.app.request(`http://${host}${url}`, { method, headers: h, body });
  };
  const signup = async (email) =>
    (await req(APP, '/account/signup', { method: 'POST', form: { email, password: 'supersecret1' } })).headers.get('set-cookie').split(';')[0];
  const connectWhop = () => {
    ctx.settings.set('key:WHOP_API_KEY', 'apik_test', { secret: true });
    ctx.settings.set('key:WHOP_COMPANY_ID', 'biz_test', { secret: true });
    ctx.settings.set('key:WHOP_WEBHOOK_SECRET', SECRET, { secret: true });
  };
  const webhook = (event, opts) => {
    const body = JSON.stringify(event);
    return req(APP, '/webhooks/whop', { method: 'POST', raw: body, headers: sign(body, opts) });
  };
  return { ctx, req, signup, connectWhop, webhook, calls };
}

test('Whop signature verification (Standard Webhooks)', () => {
  const body = '{"type":"payment.succeeded"}';
  const h = sign(body, { id: 'msg_1', ts: 1_800_000_000 });
  const base = { secret: SECRET, id: 'msg_1', timestamp: '1800000000', body, nowMs: 1_800_000_000_000 };
  assert.equal(verifyWhopSignature({ ...base, signature: h['webhook-signature'] }), true);
  assert.equal(verifyWhopSignature({ ...base, signature: `v1,bad v1,${h['webhook-signature'].slice(3)}` }), true); // any of several
  assert.equal(verifyWhopSignature({ ...base, signature: h['webhook-signature'], body: body + ' ' }), false);
  assert.equal(verifyWhopSignature({ ...base, signature: h['webhook-signature'], secret: 'ws_other' }), false);
  assert.equal(verifyWhopSignature({ ...base, signature: h['webhook-signature'], nowMs: 1_800_000_000_000 + 10 * 60_000 }), false); // too old
});

test('billing page shows plans and packs; checkout disabled until Whop is connected', async () => {
  const { req, signup, connectWhop } = setup();
  const cookie = await signup('maker@example.com');
  let page = await (await req(APP, '/account/billing', { cookie })).text();
  assert.match(page, /Free plan/);
  assert.match(page, /Upgrade to Pro|Payments coming soon/);
  assert.match(page, /Payments coming soon/);
  assert.match(page, /Starter top-up/);
  connectWhop();
  page = await (await req(APP, '/account/billing', { cookie })).text();
  assert.match(page, /Upgrade to Pro/);
  assert.match(page, /Buy for £5\.00/);
});

test('buying a plan: checkout → webhook → plan + credits; renewal; cancel; deactivation', async () => {
  const { ctx, req, signup, connectWhop, webhook, calls } = setup();
  connectWhop();
  const cookie = await signup('maker@example.com');
  const user = ctx.auth.userByEmail('maker@example.com');
  const pro = ctx.billing.plans().find((p) => p.slug === 'pro');

  const r = await req(APP, '/account/billing/checkout', { method: 'POST', cookie, form: { kind: 'plan', id: String(pro.id) } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://whop.com/checkout/ch_123/');
  const sent = calls[0];
  assert.equal(sent.auth, 'Bearer apik_test');
  assert.equal(sent.body.plan.company_id, 'biz_test');
  assert.equal(sent.body.plan.plan_type, 'renewal');
  assert.equal(sent.body.plan.initial_price, 15);
  assert.equal(sent.body.plan.currency, 'gbp');
  assert.equal(sent.body.metadata.makelo_user_id, String(user.id));
  assert.match(sent.body.redirect_url, /^http:\/\/app\.makelo\.test\/account\/billing/);

  // Unsigned / wrongly signed webhooks are rejected
  const bad = await req(APP, '/webhooks/whop', { method: 'POST', raw: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 401);

  const paid = {
    id: 'evt_1',
    type: 'payment.succeeded',
    data: { id: 'pay_1', total: 15, currency: 'gbp', billing_reason: 'subscription_create', metadata: { makelo_user_id: String(user.id), makelo_kind: 'plan', makelo_item_id: String(pro.id) }, membership: { id: 'mem_1', status: 'active' } },
  };
  assert.equal((await (await webhook(paid)).json()).result, 'plan-activated');
  assert.equal(ctx.billing.subscription(user.id).plan.slug, 'pro');
  assert.equal(ctx.billing.balance(user.id), 2000);

  // Retried delivery of the same event is ignored; same payment under a new event id too
  assert.equal((await (await webhook(paid)).json()).result, 'duplicate-event');
  assert.equal((await (await webhook({ ...paid, id: 'evt_1b' })).json()).result, 'duplicate-payment');
  assert.equal(ctx.billing.balance(user.id), 2000);

  // Renewal: payment for the same membership without our metadata
  ctx.billing.adjust(user.id, -1500, 'used');
  const renewal = { id: 'evt_2', type: 'payment.succeeded', data: { id: 'pay_2', total: 15, currency: 'gbp', billing_reason: 'subscription_cycle', membership: { id: 'mem_1' } } };
  assert.equal((await (await webhook(renewal)).json()).result, 'renewed');
  assert.equal(ctx.billing.balance(user.id), 2000);

  // Cancel from the billing page
  const cancel = await req(APP, '/account/billing/cancel', { method: 'POST', cookie, form: {} });
  assert.match(decodeURIComponent(cancel.headers.get('location')), /Subscription cancelled/);
  assert.match(calls.at(-1).url, /\/memberships\/mem_1\/cancel$/);
  assert.equal(calls.at(-1).body.cancellation_mode, 'at_period_end');
  assert.match(await (await req(APP, '/account/billing', { cookie })).text(), /Cancels at period end/);

  // Membership ends → back to Free
  assert.equal((await (await webhook({ id: 'evt_3', type: 'membership.deactivated', data: { id: 'mem_1', status: 'canceled' } })).json()).result, 'downgraded');
  assert.equal(ctx.billing.subscription(user.id).plan.slug, 'free');

  // Payments recorded
  const history = ctx.payments.history(user.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].amount_cents, 1500);
});

test('upgrading cancels the previous subscription', async () => {
  const { ctx, signup, connectWhop, webhook, calls } = setup();
  connectWhop();
  await signup('maker@example.com');
  const user = ctx.auth.userByEmail('maker@example.com');
  const plans = ctx.billing.plans();
  const pro = plans.find((p) => p.slug === 'pro');
  const biz = plans.find((p) => p.slug === 'business');
  const pay = (id, mem, plan) => ({ id: `evt_${id}`, type: 'payment.succeeded', data: { id: `pay_${id}`, total: plan.price_cents / 100, currency: 'gbp', billing_reason: 'subscription_create', metadata: { makelo_user_id: String(user.id), makelo_kind: 'plan', makelo_item_id: String(plan.id) }, membership: { id: mem } } });
  await webhook(pay('a', 'mem_a', pro));
  await webhook(pay('b', 'mem_b', biz));
  assert.equal(ctx.billing.subscription(user.id).plan.slug, 'business');
  assert.equal(ctx.billing.balance(user.id), 10000);
  assert.ok(calls.some((c) => /\/memberships\/mem_a\/cancel$/.test(c.url) && c.body.cancellation_mode === 'immediate'));
  assert.equal(ctx.payments.membership(user.id).membership_id, 'mem_b');
});

test('buying a credit pack adds credits once', async () => {
  const { ctx, req, signup, connectWhop, webhook, calls } = setup();
  connectWhop();
  const cookie = await signup('maker@example.com');
  const user = ctx.auth.userByEmail('maker@example.com');
  const pack = ctx.payments.packs().find((k) => k.credits === 2000);

  await req(APP, '/account/billing/checkout', { method: 'POST', cookie, form: { kind: 'credits', id: String(pack.id) } });
  assert.equal(calls[0].body.plan.plan_type, 'one_time');
  assert.equal(calls[0].body.plan.initial_price, 15);

  const ev = { id: 'evt_c1', type: 'payment.succeeded', data: { id: 'pay_c1', total: 15, currency: 'gbp', billing_reason: 'one_time', metadata: { makelo_user_id: String(user.id), makelo_kind: 'credits', makelo_item_id: String(pack.id) } } };
  assert.equal((await (await webhook(ev)).json()).result, 'credits-granted');
  assert.equal(ctx.billing.balance(user.id), 100 + 2000);
  await webhook({ ...ev, id: 'evt_c2' });
  assert.equal(ctx.billing.balance(user.id), 2100);
});

test('admin manages credit packs and sees payments', async () => {
  const { ctx, req, signup, connectWhop, webhook } = setup();
  connectWhop();
  await signup('boss@example.com');
  await signup('maker@example.com');
  const login = await req(ADMIN, '/login', { method: 'POST', form: { email: 'boss@example.com', password: 'supersecret1' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const created = await req(ADMIN, '/packs', { method: 'POST', cookie, form: { name: 'Mega', credits: '50000', price: '199', currency: 'GBP', visible: '1' } });
  assert.match(decodeURIComponent(created.headers.get('location')), /Mega.*created/);
  const mega = ctx.payments.packs().find((k) => k.name === 'Mega');
  assert.equal(mega.price_cents, 19900);

  const maker = ctx.auth.userByEmail('maker@example.com');
  await webhook({ id: 'evt_m', type: 'payment.succeeded', data: { id: 'pay_m', total: 199, currency: 'gbp', metadata: { makelo_user_id: String(maker.id), makelo_kind: 'credits', makelo_item_id: String(mega.id) } } });

  const page = await (await req(ADMIN, '/payments', { cookie })).text();
  assert.match(page, /maker@example\.com/);
  assert.match(page, /£199\.00/);
  assert.match(page, /webhooks\/whop/);
  assert.match(await (await req(ADMIN, '/', { cookie })).text(), /£199\.00/);

  await req(ADMIN, `/packs/${mega.id}/archive`, { method: 'POST', cookie, form: { archived: '1' } });
  const makerCookie = (await req(APP, '/account/login', { method: 'POST', form: { email: 'maker@example.com', password: 'supersecret1' } })).headers.get('set-cookie').split(';')[0];
  assert.doesNotMatch(await (await req(APP, '/account/billing', { cookie: makerCookie })).text(), /Mega/);

  // Sandbox switch
  await req(ADMIN, '/settings', { method: 'POST', cookie, form: { whop_sandbox_present: '1', whop_sandbox: '1' } });
  assert.equal(ctx.settings.get('whop_sandbox'), '1');
});

test('purchased credits survive plan renewal; plan credits reset', async () => {
  const { ctx, signup } = setup();
  await signup('maker@example.com');
  const user = ctx.auth.userByEmail('maker@example.com');
  const pro = ctx.billing.plans().find((p) => p.slug === 'pro');
  ctx.billing.changePlan(user.id, pro.id); // 2000 plan credits
  ctx.billing.adjust(user.id, 500, 'Bought pack', 'purchase'); // +500 bought
  ctx.billing.adjust(user.id, -1800, 'used', 'ai'); // plan credits spent first → 200 plan + 500 bought left
  assert.equal(ctx.billing.balance(user.id), 700);
  ctx.billing.changePlan(user.id, pro.id, 'renewal');
  assert.equal(ctx.billing.balance(user.id), 2500); // fresh 2000 + 500 carried
  ctx.billing.adjust(user.id, -2300, 'used', 'ai'); // dips into bought credits: 200 left, all bought
  ctx.billing.changePlan(user.id, pro.id, 'renewal');
  assert.equal(ctx.billing.balance(user.id), 2200); // 2000 + 200 carried
  ctx.billing.adjust(user.id, -2200, 'used', 'ai');
  ctx.billing.changePlan(user.id, pro.id, 'renewal');
  assert.equal(ctx.billing.balance(user.id), 2000); // nothing left to carry
});
