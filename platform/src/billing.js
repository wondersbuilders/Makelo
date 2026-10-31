import { now } from './db.js';

const MONTH = 30 * 86400_000;

/** Plans created on first start. Admins can edit or archive them. */
const DEFAULT_PLANS = [
  { slug: 'free', name: 'Free', description: 'Try Makelo', price_cents: 0, monthly_credits: 100, max_apps: 3, custom_domains: 0, sort: 0 },
  { slug: 'pro', name: 'Pro', description: 'For makers shipping real apps', price_cents: 1500, monthly_credits: 2000, max_apps: 20, custom_domains: 1, sort: 1 },
  { slug: 'business', name: 'Business', description: 'Teams and agencies', price_cents: 4900, monthly_credits: 10000, max_apps: 100, custom_domains: 1, sort: 2 },
];

/** Default pricing rules (editable in Admin → Settings). */
export const RATE_DEFAULTS = {
  credits_per_1k_input: 1,
  credits_per_1k_output: 3,
  credits_per_sandbox_minute: 1,
  signup_bonus_credits: 0,
  currency: 'GBP',
};

export function createBilling(db, settings) {
  const q = {
    countPlans: db.prepare('SELECT COUNT(*) AS n FROM plans'),
    insertPlan: db.prepare(
      `INSERT INTO plans (slug, name, description, price_cents, currency, monthly_credits, max_apps, custom_domains, stripe_price_id, visible, sort, created_at, updated_at)
       VALUES (@slug, @name, @description, @price_cents, @currency, @monthly_credits, @max_apps, @custom_domains, @stripe_price_id, @visible, @sort, @t, @t)`,
    ),
    updatePlan: db.prepare(
      `UPDATE plans SET name=@name, description=@description, price_cents=@price_cents, currency=@currency, monthly_credits=@monthly_credits,
       max_apps=@max_apps, custom_domains=@custom_domains, stripe_price_id=@stripe_price_id, visible=@visible, sort=@sort, updated_at=@t WHERE id=@id`,
    ),
    archivePlan: db.prepare('UPDATE plans SET archived = ?, updated_at = ? WHERE id = ?'),
    plan: db.prepare('SELECT * FROM plans WHERE id = ?'),
    planBySlug: db.prepare('SELECT * FROM plans WHERE slug = ?'),
    plans: db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS subscribers
       FROM plans p ORDER BY p.archived, p.sort, p.price_cents`,
    ),
    sub: db.prepare('SELECT * FROM subscriptions WHERE user_id = ?'),
    upsertSub: db.prepare(
      `INSERT INTO subscriptions (user_id, plan_id, status, period_start, period_end, updated_at) VALUES (?, ?, 'active', ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', period_start = excluded.period_start,
       period_end = excluded.period_end, updated_at = excluded.updated_at`,
    ),
    balance: db.prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM credit_ledger WHERE user_id = ?'),
    addLedger: db.prepare('INSERT INTO credit_ledger (user_id, delta, kind, note, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    usedSince: db.prepare(
      "SELECT kind, COALESCE(-SUM(delta), 0) AS used FROM credit_ledger WHERE user_id = ? AND delta < 0 AND created_at >= ? GROUP BY kind",
    ),
  };

  if (q.countPlans.get().n === 0) {
    const t = now();

    for (const p of DEFAULT_PLANS) {
      q.insertPlan.run({ currency: 'GBP', stripe_price_id: null, visible: 1, ...p, t });
    }
  }

  const rate = (key) =>
    key === 'currency' ? settings.get('rate:currency', RATE_DEFAULTS.currency) : settings.getNumber(`rate:${key}`, RATE_DEFAULTS[key]);

  function defaultPlan() {
    const id = settings.getNumber('default_plan_id', 0);
    const chosen = id ? q.plan.get(id) : null;

    return chosen && !chosen.archived ? chosen : q.planBySlug.get('free') || q.plans.all().find((p) => !p.archived);
  }

  /** Start a fresh billing period and reset credits to the plan's monthly allowance. */
  function startPeriod(userId, plan, note) {
    const t = now();
    const balance = q.balance.get(userId).b;

    db.transaction(() => {
      q.upsertSub.run(userId, plan.id, t, t + MONTH, t);
      const delta = plan.monthly_credits - Math.max(0, balance);

      if (delta !== 0) {
        q.addLedger.run(userId, delta, 'grant', note || `${plan.name} monthly credits`, null, t);
      }
    })();
  }

  const billing = {
    rate,
    plans: () => q.plans.all(),
    plan: (id) => q.plan.get(id),
    defaultPlan,

    savePlan(input) {
      const data = {
        name: String(input.name || '').trim().slice(0, 60),
        description: String(input.description || '').trim().slice(0, 200),
        price_cents: Math.max(0, Math.round(Number(input.price || 0) * 100)),
        currency: String(input.currency || rate('currency') || 'GBP').toUpperCase().slice(0, 3),
        monthly_credits: Math.max(0, Math.round(Number(input.monthly_credits || 0))),
        max_apps: Math.max(0, Math.round(Number(input.max_apps || 0))),
        custom_domains: input.custom_domains ? 1 : 0,
        stripe_price_id: String(input.stripe_price_id || '').trim() || null,
        visible: input.visible ? 1 : 0,
        sort: Math.round(Number(input.sort || 0)),
        t: now(),
      };

      if (!data.name) {
        return { error: 'Plan name is required.' };
      }

      if (input.id) {
        q.updatePlan.run({ ...data, id: Number(input.id) });
        return { plan: q.plan.get(Number(input.id)) };
      }

      const slug = String(input.slug || data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

      if (!slug || q.planBySlug.get(slug)) {
        return { error: 'Choose a unique plan code (letters and numbers).' };
      }

      const info = q.insertPlan.run({ ...data, slug });

      return { plan: q.plan.get(info.lastInsertRowid) };
    },

    archivePlan: (id, archived = true) => q.archivePlan.run(archived ? 1 : 0, now(), id),

    /** Called at signup. */
    enroll(userId) {
      const plan = defaultPlan();

      if (plan) {
        startPeriod(userId, plan, `Welcome — ${plan.name} plan credits`);
      }

      const bonus = rate('signup_bonus_credits');

      if (bonus > 0) {
        q.addLedger.run(userId, bonus, 'grant', 'Sign-up bonus', null, now());
      }
    },

    /** Current subscription, renewing the period (and credits) when it has ended. */
    subscription(userId) {
      let sub = q.sub.get(userId);

      if (!sub) {
        billing.enroll(userId);
        sub = q.sub.get(userId);
      } else if (sub.status === 'active' && sub.period_end <= now()) {
        const plan = q.plan.get(sub.plan_id) || defaultPlan();
        startPeriod(userId, plan, `${plan.name} credits renewed`);
        sub = q.sub.get(userId);
      }

      return sub ? { ...sub, plan: q.plan.get(sub.plan_id) } : null;
    },

    changePlan(userId, planId, note) {
      const plan = q.plan.get(planId);

      if (!plan) {
        return { error: 'Plan not found.' };
      }

      startPeriod(userId, plan, note || `Moved to ${plan.name}`);

      return { plan };
    },

    balance(userId) {
      billing.subscription(userId);
      return q.balance.get(userId).b;
    },

    hasCredits: (userId) => billing.balance(userId) > 0,

    adjust(userId, delta, note, kind = 'admin') {
      const n = Math.round(Number(delta));

      if (!Number.isFinite(n) || n === 0) {
        return { error: 'Enter a non-zero number of credits.' };
      }

      q.addLedger.run(userId, n, kind, String(note || '').slice(0, 200), null, now());

      return { balance: q.balance.get(userId).b };
    },

    /** AI usage reported by the builder after each response. */
    chargeAi(userId, { provider, model, inputTokens = 0, outputTokens = 0 }) {
      const credits = Math.ceil(
        (Math.max(0, inputTokens) * rate('credits_per_1k_input') + Math.max(0, outputTokens) * rate('credits_per_1k_output')) / 1000,
      );

      if (credits > 0) {
        q.addLedger.run(
          userId,
          -credits,
          'ai',
          `${provider || 'AI'} ${model || ''}`.trim().slice(0, 120),
          JSON.stringify({ provider, model, inputTokens, outputTokens }),
          now(),
        );
      }

      return credits;
    },

    /** Sandbox time, reported by the sandbox manager in seconds. */
    chargeSandbox(userId, seconds) {
      const credits = Math.ceil((Math.max(0, seconds) / 60) * rate('credits_per_sandbox_minute'));

      if (credits > 0) {
        q.addLedger.run(userId, -credits, 'sandbox', `${Math.round(seconds / 60)} min cloud sandbox`, JSON.stringify({ seconds }), now());
      }

      return credits;
    },

    /** What the plan allows. */
    limits(userId) {
      const sub = billing.subscription(userId);
      const plan = sub?.plan;

      return {
        maxApps: plan ? plan.max_apps : 3,
        customDomains: plan ? Boolean(plan.custom_domains) : false,
        planName: plan?.name || 'Free',
      };
    },

    usedThisPeriod(userId) {
      const sub = billing.subscription(userId);
      return Object.fromEntries(q.usedSince.all(userId, sub ? sub.period_start : 0).map((r) => [r.kind, r.used]));
    },
  };

  return billing;
}
