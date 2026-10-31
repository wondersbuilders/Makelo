import crypto from 'node:crypto';
import { now } from './db.js';

const DEFAULT_PACKS = [
  { name: 'Starter top-up', credits: 500, price_cents: 500, sort: 0 },
  { name: 'Builder top-up', credits: 2000, price_cents: 1500, sort: 1 },
  { name: 'Power top-up', credits: 10000, price_cents: 6000, sort: 2 },
];

/**
 * Verify a Whop webhook (Standard Webhooks): HMAC-SHA256 over "{id}.{timestamp}.{body}",
 * base64, sent as "v1,<sig>" in the webhook-signature header (may hold several, space separated).
 */
export function verifyWhopSignature({ secret, id, timestamp, signature, body, toleranceSec = 300, nowMs = Date.now() }) {
  if (!secret || !id || !timestamp || !signature) {
    return false;
  }

  const ts = Number(timestamp);

  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) {
    return false;
  }

  const signed = `${id}.${timestamp}.${body}`;
  const keys = [Buffer.from(secret, 'utf8')];

  // Standard Webhooks "whsec_" secrets are base64 after the prefix; Whop's "ws_" secrets are used as-is.
  if (secret.startsWith('whsec_')) {
    keys.push(Buffer.from(secret.slice(6), 'base64'));
  }

  const expected = keys.map((k) => crypto.createHmac('sha256', k).update(signed).digest());

  return String(signature)
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean)
    .some((sig) => {
      const got = Buffer.from(sig, 'base64');
      return expected.some((e) => e.length === got.length && crypto.timingSafeEqual(e, got));
    });
}

export function createPayments({ db, config, settings, billing, auth, fetchImpl = fetch }) {
  const q = {
    countPacks: db.prepare('SELECT COUNT(*) AS n FROM credit_packs'),
    insertPack: db.prepare(
      'INSERT INTO credit_packs (name, credits, price_cents, currency, visible, sort, created_at, updated_at) VALUES (@name, @credits, @price_cents, @currency, @visible, @sort, @t, @t)',
    ),
    updatePack: db.prepare(
      'UPDATE credit_packs SET name=@name, credits=@credits, price_cents=@price_cents, currency=@currency, visible=@visible, sort=@sort, updated_at=@t WHERE id=@id',
    ),
    archivePack: db.prepare('UPDATE credit_packs SET archived = ?, updated_at = ? WHERE id = ?'),
    pack: db.prepare('SELECT * FROM credit_packs WHERE id = ?'),
    packs: db.prepare('SELECT * FROM credit_packs ORDER BY archived, sort, price_cents'),
    membership: db.prepare('SELECT * FROM gateway_memberships WHERE user_id = ?'),
    membershipById: db.prepare('SELECT * FROM gateway_memberships WHERE membership_id = ?'),
    upsertMembership: db.prepare(
      `INSERT INTO gateway_memberships (user_id, membership_id, plan_id, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET membership_id = excluded.membership_id, plan_id = excluded.plan_id, status = excluded.status, updated_at = excluded.updated_at`,
    ),
    membershipStatus: db.prepare('UPDATE gateway_memberships SET status = ?, updated_at = ? WHERE membership_id = ?'),
    deleteMembership: db.prepare('DELETE FROM gateway_memberships WHERE membership_id = ?'),
    insertPayment: db.prepare(
      'INSERT OR IGNORE INTO payments (user_id, provider, ref, kind, amount_cents, currency, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    paymentsForUser: db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 25'),
    allPayments: db.prepare('SELECT p.*, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 300'),
    revenueSince: db.prepare(
      "SELECT currency, COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM payments WHERE status = 'paid' AND created_at >= ? GROUP BY currency",
    ),
    seenEvent: db.prepare('SELECT 1 FROM webhook_events WHERE id = ?'),
    markEvent: db.prepare('INSERT OR IGNORE INTO webhook_events (id, created_at) VALUES (?, ?)'),
  };

  if (q.countPacks.get().n === 0) {
    const t = now();

    for (const p of DEFAULT_PACKS) {
      q.insertPack.run({ currency: 'GBP', visible: 1, ...p, t });
    }
  }

  const apiBase = () =>
    settings.get('whop_sandbox') === '1' ? 'https://sandbox-api.whop.com/api/v1' : 'https://api.whop.com/api/v1';
  const apiKey = () => settings.secret('WHOP_API_KEY');
  const companyId = () => settings.secret('WHOP_COMPANY_ID');

  async function whop(method, path, body) {
    const res = await fetchImpl(`${apiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `Whop request failed (${res.status})`;
      throw Object.assign(new Error(msg), { status: res.status });
    }

    return data;
  }

  const toWhopAmount = (cents) => Math.round(cents) / 100;
  const fromWhopAmount = (v) => Math.round(Number(v || 0) * 100);
  const appUrl = (path) => `${config.scheme}://${config.appHost}${path}`;
  const absolute = (url) => (/^https?:\/\//.test(url) ? url : `https://whop.com${url.startsWith('/') ? '' : '/'}${url}`);

  const payments = {
    configured: () => Boolean(apiKey() && companyId()),
    webhookConfigured: () => Boolean(settings.secret('WHOP_WEBHOOK_SECRET')),

    packs: () => q.packs.all(),
    pack: (id) => q.pack.get(id),

    savePack(input) {
      const data = {
        name: String(input.name || '').trim().slice(0, 60),
        credits: Math.max(1, Math.round(Number(input.credits || 0))),
        price_cents: Math.max(0, Math.round(Number(input.price || 0) * 100)),
        currency: String(input.currency || billing.rate('currency')).toUpperCase().slice(0, 3),
        visible: input.visible ? 1 : 0,
        sort: Math.round(Number(input.sort || 0)),
        t: now(),
      };

      if (!data.name || !Number(input.credits)) {
        return { error: 'A credit pack needs a name and a number of credits.' };
      }

      if (input.id) {
        q.updatePack.run({ ...data, id: Number(input.id) });
        return { pack: q.pack.get(Number(input.id)) };
      }

      return { pack: q.pack.get(q.insertPack.run(data).lastInsertRowid) };
    },

    archivePack: (id, archived = true) => q.archivePack.run(archived ? 1 : 0, now(), id),
    membership: (userId) => q.membership.get(userId) || null,
    history: (userId) => q.paymentsForUser.all(userId),
    allPayments: () => q.allPayments.all(),
    revenueSince: (since) => q.revenueSince.all(since),

    /** Create a Whop checkout and return the URL to send the user to. */
    async checkout(user, { kind, id }) {
      if (!payments.configured()) {
        return { error: 'Payments are not set up yet. Please try again later.' };
      }

      const metadata = { makelo_user_id: String(user.id), makelo_kind: kind, makelo_item_id: String(id) };
      let body;

      if (kind === 'plan') {
        const plan = billing.plan(Number(id));

        if (!plan || plan.archived || plan.price_cents <= 0) {
          return { error: 'That plan cannot be bought.' };
        }

        body = plan.gateway_plan_id
          ? { mode: 'payment', plan_id: plan.gateway_plan_id }
          : {
              mode: 'payment',
              plan: {
                company_id: companyId(),
                currency: plan.currency.toLowerCase(),
                plan_type: 'renewal',
                initial_price: toWhopAmount(plan.price_cents),
                renewal_price: toWhopAmount(plan.price_cents),
                billing_period: 30,
                title: `Makelo ${plan.name}`,
                product: { external_identifier: `makelo-plan-${plan.slug}`, title: `Makelo ${plan.name}` },
              },
            };
      } else if (kind === 'credits') {
        const pack = q.pack.get(Number(id));

        if (!pack || pack.archived) {
          return { error: 'That credit pack is not available.' };
        }

        body = {
          mode: 'payment',
          plan: {
            company_id: companyId(),
            currency: pack.currency.toLowerCase(),
            plan_type: 'one_time',
            initial_price: toWhopAmount(pack.price_cents),
            title: `${pack.credits.toLocaleString('en-GB')} Makelo credits`,
            product: { external_identifier: `makelo-credits-${pack.id}`, title: `Makelo credits — ${pack.name}` },
          },
        };
      } else {
        return { error: 'Unknown purchase.' };
      }

      const checkout = await whop('POST', '/checkout_configurations', {
        ...body,
        metadata,
        redirect_url: appUrl('/account/billing?ok=Thanks!%20Your%20payment%20is%20being%20confirmed%20—%20credits%20appear%20in%20a%20few%20seconds.'),
      });

      if (!checkout.purchase_url) {
        return { error: 'Whop did not return a checkout link.' };
      }

      return { url: absolute(checkout.purchase_url), checkoutId: checkout.id };
    },

    /** Cancel the user's subscription at the end of the paid period. */
    async cancel(userId) {
      const m = q.membership.get(userId);

      if (!m) {
        return { error: 'You have no active subscription.' };
      }

      await whop('POST', `/memberships/${encodeURIComponent(m.membership_id)}/cancel`, { cancellation_mode: 'at_period_end' });
      q.membershipStatus.run('canceling', now(), m.membership_id);

      return { ok: true };
    },

    /**
     * Handle a verified Whop webhook. Returns a short status string (for logs/tests).
     * Fulfilment is idempotent: each payment id is processed once.
     */
    async handleEvent(event) {
      const type = event?.type || event?.action;
      const data = event?.data || {};

      if (event?.id && q.seenEvent.get(String(event.id))) {
        return 'duplicate-event';
      }

      let result = 'ignored';

      if (type === 'payment.succeeded') {
        result = await onPaymentSucceeded(data);
      } else if (type === 'membership.deactivated' || (type === 'membership.updated' && ['canceled', 'expired', 'completed'].includes(data.status))) {
        result = onMembershipEnded(data);
      } else if (type === 'membership.updated' && data.status === 'canceling') {
        q.membershipStatus.run('canceling', now(), String(data.id));
        result = 'membership-canceling';
      }

      if (event?.id) {
        q.markEvent.run(String(event.id), now());
      }

      return result;
    },
  };

  async function onPaymentSucceeded(p) {
    const meta = p.metadata || {};
    const membershipId = p.membership?.id ? String(p.membership.id) : null;
    const link = membershipId ? q.membershipById.get(membershipId) : null;
    const userId = Number(meta.makelo_user_id) || link?.user_id;

    if (!userId || !auth.userById(userId)) {
      return 'unknown-user';
    }

    const ref = `whop:${p.id}`;
    const amount = fromWhopAmount(p.total ?? p.subtotal);
    const currency = String(p.currency || billing.rate('currency')).toUpperCase();
    const record = (kind, description) =>
      q.insertPayment.run(userId, 'whop', ref, kind, amount, currency, description, 'paid', now()).changes > 0;

    // Renewal of an existing subscription
    if (link && (p.billing_reason === 'subscription_cycle' || (!meta.makelo_kind && link))) {
      const plan = billing.plan(link.plan_id);

      if (!record('renewal', `${plan?.name || 'Plan'} renewal`)) {
        return 'duplicate-payment';
      }

      billing.changePlan(userId, link.plan_id, `${plan?.name || 'Plan'} renewed — payment received`);
      q.membershipStatus.run('active', now(), link.membership_id);

      return 'renewed';
    }

    if (meta.makelo_kind === 'credits') {
      const pack = q.pack.get(Number(meta.makelo_item_id));
      const credits = pack ? pack.credits : 0;

      if (!credits) {
        return 'unknown-pack';
      }

      if (!record('credits', `${credits.toLocaleString('en-GB')} credits`)) {
        return 'duplicate-payment';
      }

      billing.adjust(userId, credits, `Bought ${pack.name}`, 'purchase');

      return 'credits-granted';
    }

    if (meta.makelo_kind === 'plan') {
      const plan = billing.plan(Number(meta.makelo_item_id));

      if (!plan) {
        return 'unknown-plan';
      }

      if (!record('plan', `${plan.name} plan`)) {
        return 'duplicate-payment';
      }

      // Upgrading: end the previous subscription so the user is not billed twice.
      const previous = q.membership.get(userId);

      if (previous && membershipId && previous.membership_id !== membershipId) {
        await whop('POST', `/memberships/${encodeURIComponent(previous.membership_id)}/cancel`, { cancellation_mode: 'immediate' }).catch(
          (err) => console.error('[makelo] could not cancel previous Whop membership', previous.membership_id, err.message),
        );
        q.deleteMembership.run(previous.membership_id);
      }

      if (membershipId) {
        q.upsertMembership.run(userId, membershipId, plan.id, 'active', now());
      }

      billing.changePlan(userId, plan.id, `Subscribed to ${plan.name}`);

      return 'plan-activated';
    }

    return 'ignored';
  }

  function onMembershipEnded(m) {
    const link = q.membershipById.get(String(m.id));

    if (!link) {
      return 'unknown-membership';
    }

    q.deleteMembership.run(link.membership_id);
    const fallback = billing.defaultPlan();

    if (fallback) {
      billing.changePlan(link.user_id, fallback.id, 'Subscription ended — moved to the free plan');
    }

    return 'downgraded';
  }

  return payments;
}
