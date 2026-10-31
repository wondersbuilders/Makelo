import { CSS, esc, LOGO } from './views.js';

const ADMIN_CSS = `
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.side{background:var(--card);border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
.side .brand{display:flex;align-items:center;gap:8px;color:var(--text);margin:0 6px 14px}
.side .tag{font-size:11px;font-weight:700;letter-spacing:.06em;background:#ede9fe;color:#6d28d9;border-radius:6px;padding:2px 6px}
.side a.nav{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:9px;color:var(--text);text-decoration:none;font-size:14px}
.side a.nav:hover{background:var(--bg)} .side a.nav.on{background:var(--bg);font-weight:600;box-shadow:inset 3px 0 0 var(--accent)}
.side .foot{margin-top:auto;font-size:13px;color:var(--muted);padding:8px 6px}
.content{padding:28px 32px;max-width:1180px;width:100%}
.content h1{margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.stat .k{font-size:12.5px;color:var(--muted)} .stat .v{font-size:26px;font-weight:700;margin-top:4px} .stat .s{font-size:12px;color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px} @media (max-width:900px){.grid2{grid-template-columns:1fr}.shell{grid-template-columns:1fr}.side{position:static;height:auto}}
.bars{display:flex;align-items:flex-end;gap:3px;height:120px;padding-top:8px}
.bars div{flex:1;background:linear-gradient(180deg,#7c3aed,#2563eb);border-radius:4px 4px 0 0;min-height:2px}
.num{text-align:right;font-variant-numeric:tabular-nums} .neg{color:var(--bad)} .pos{color:var(--ok)}
select{padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}
.keyrow{display:grid;grid-template-columns:220px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.keyrow:last-child{border-bottom:0} .keyrow form{display:flex;gap:8px} .keyrow input{min-width:0} .keyactions{display:flex;gap:8px;align-items:center}
.check{display:flex;gap:8px;align-items:center;font-weight:500;margin:12px 0 0} .check input{width:auto}
`;

const NAV = [
  ['/', 'Overview', '◎'],
  ['/users', 'Users', '👤'],
  ['/plans', 'Plans', '◆'],
  ['/usage', 'Credits & usage', '⚡'],
  ['/payments', 'Payments', '£'],
  ['/keys', 'API keys', '🔑'],
  ['/settings', 'Settings', '⚙'],
];

export function adminLayout({ title, admin, path, body, flash, appUrl }) {
  const flashHtml = flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.message)}</div>` : '';
  const nav = admin
    ? NAV.map(([href, label, icon]) => {
        const on = href === '/' ? path === '/' : path.startsWith(href);
        return `<a class="nav${on ? ' on' : ''}" href="${href}"><span>${icon}</span>${esc(label)}</a>`;
      }).join('')
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Makelo Admin</title><style>${CSS}${ADMIN_CSS}</style></head><body>
${
  admin
    ? `<div class="shell"><aside class="side"><div class="brand">${LOGO}<span class="tag">ADMIN</span></div>${nav}
       <div class="foot">${esc(admin.email)}<br><a href="${esc(appUrl)}">Open app ↗</a>
       <form method="post" action="/logout" style="margin-top:8px"><button class="secondary" style="width:100%">Log out</button></form></div></aside>
       <main class="content">${flashHtml}${body}</main></div>`
    : `<main style="max-width:420px;margin:60px auto;padding:0 16px">${flashHtml}${body}</main>`
}</body></html>`;
}

export function adminLoginPage({ error, email = '' }) {
  return adminLayout({
    title: 'Admin login',
    flash: error ? { type: 'error', message: error } : null,
    body: `<div class="card"><div style="color:var(--text);margin-bottom:12px">${LOGO}</div><h1>Admin sign in</h1>
      <p class="muted">Restricted to Makelo administrators.</p>
      <form method="post" action="/login">
        <label for="email">Email</label><input id="email" name="email" type="email" required value="${esc(email)}" autocomplete="username">
        <label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
        <p></p><button style="width:100%">Sign in</button>
      </form></div>`,
  });
}

export const money = (cents, currency = 'GBP') => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format((cents || 0) / 100);
  } catch {
    return `${currency} ${((cents || 0) / 100).toFixed(2)}`;
  }
};

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
const dateTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '—');
const n = (v) => Number(v || 0).toLocaleString('en-GB');

export function overviewPage(d) {
  const max = Math.max(1, ...d.daily.map((x) => x.used));
  const bars = d.daily.map((x) => `<div title="${esc(x.day)}: ${n(x.used)} credits" style="height:${Math.round((x.used / max) * 100)}%"></div>`).join('');

  return `<h1>Overview</h1>
  <div class="stats">
    <div class="stat"><div class="k">Users</div><div class="v">${n(d.users)}</div><div class="s">+${n(d.newUsers7d)} in 7 days</div></div>
    <div class="stat"><div class="k">Paying users</div><div class="v">${n(d.paying)}</div><div class="s">on paid plans</div></div>
    <div class="stat"><div class="k">Revenue (30 days)</div><div class="v">${esc(d.revenue30)}</div><div class="s">${n(d.payments30)} payments · est. MRR ${esc(money(d.mrrCents, d.currency))}</div></div>
    <div class="stat"><div class="k">Published apps</div><div class="v">${n(d.publishedApps)}</div><div class="s">${n(d.domains)} custom domains</div></div>
    <div class="stat"><div class="k">Credits used (30 days)</div><div class="v">${n(d.used30)}</div><div class="s">AI ${n(d.usedAi30)} · Sandbox ${n(d.usedSandbox30)}</div></div>
    <div class="stat"><div class="k">Live sandboxes</div><div class="v">${n(d.liveSandboxes)}</div><div class="s">${esc(d.sandboxProvider || 'not configured')}</div></div>
  </div>
  ${d.paymentsWarning ? `<div class="flash warn">${esc(d.paymentsWarning)} <a href="/keys">API keys</a></div>` : ''}
  ${d.missingKeys.length ? `<div class="flash warn">Missing keys: ${esc(d.missingKeys.join(', '))} — add them under <a href="/keys">API keys</a>.</div>` : ''}
  <div class="card"><h2>Credits used per day (last 30 days)</h2><div class="bars">${bars}</div></div>
  <div class="grid2">
    <div class="card"><h2>Newest users</h2><table><tr><th>Email</th><th>Plan</th><th>Joined</th></tr>
      ${d.recentUsers.map((u) => `<tr><td><a href="/users/${u.id}">${esc(u.email)}</a></td><td>${esc(u.plan || '—')}</td><td>${date(u.created_at)}</td></tr>`).join('') || '<tr><td colspan=3 class="muted">No users yet</td></tr>'}
    </table></div>
    <div class="card"><h2>Top credit users (30 days)</h2><table><tr><th>Email</th><th class="num">Credits</th></tr>
      ${d.topUsers.map((u) => `<tr><td><a href="/users/${u.id}">${esc(u.email)}</a></td><td class="num">${n(u.used)}</td></tr>`).join('') || '<tr><td colspan=2 class="muted">No usage yet</td></tr>'}
    </table></div>
  </div>`;
}

export function usersPage({ users, query }) {
  return `<h1>Users</h1>
  <form class="row" method="get" action="/users" style="margin-bottom:14px"><div><input name="q" placeholder="Search by email" value="${esc(query)}"></div><button class="secondary">Search</button></form>
  <div class="card" style="padding:8px 14px"><table>
    <tr><th>Email</th><th>Plan</th><th class="num">Credits left</th><th class="num">Apps</th><th>Role</th><th>Status</th><th>Joined</th></tr>
    ${users
      .map(
        (u) => `<tr><td><a href="/users/${u.id}">${esc(u.email)}</a></td><td>${esc(u.plan || '—')}</td>
        <td class="num ${u.balance <= 0 ? 'neg' : ''}">${n(u.balance)}</td><td class="num">${n(u.apps)}</td>
        <td>${u.role === 'admin' ? '<span class="pill ok">Admin</span>' : 'User'}</td>
        <td>${u.suspended_at ? '<span class="pill wait">Suspended</span>' : '<span class="pill off">Active</span>'}</td><td>${date(u.created_at)}</td></tr>`,
      )
      .join('') || '<tr><td colspan=7 class="muted">No users found</td></tr>'}
  </table></div>`;
}

export function userPage({ u, sub, balance, used, plans, ledger, apps, self }) {
  const options = plans
    .filter((p) => !p.archived)
    .map((p) => `<option value="${p.id}" ${sub?.plan_id === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(money(p.price_cents, p.currency))}/mo, ${n(p.monthly_credits)} credits</option>`)
    .join('');

  return `<p><a href="/users">← Users</a></p><h1>${esc(u.email)}</h1>
  <div class="stats">
    <div class="stat"><div class="k">Plan</div><div class="v" style="font-size:20px">${esc(sub?.plan?.name || '—')}</div><div class="s">renews ${date(sub?.period_end)}</div></div>
    <div class="stat"><div class="k">Credits left</div><div class="v ${balance <= 0 ? 'neg' : ''}">${n(balance)}</div></div>
    <div class="stat"><div class="k">Used this period</div><div class="v">${n((used.ai || 0) + (used.sandbox || 0))}</div><div class="s">AI ${n(used.ai)} · Sandbox ${n(used.sandbox)}</div></div>
    <div class="stat"><div class="k">Apps</div><div class="v">${n(apps.length)}</div></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Plan</h2><form method="post" action="/users/${u.id}/plan" class="row"><div><select name="plan_id" style="width:100%">${options}</select></div><button>Change plan</button></form>
      <p class="muted" style="font-size:13px">Changing plan starts a new period and resets credits to the plan's allowance.</p></div>
    <div class="card"><h2>Adjust credits</h2><form method="post" action="/users/${u.id}/credits" class="row">
      <div style="flex:0 0 110px"><input name="delta" type="number" placeholder="+500 or -100" required></div><div><input name="note" placeholder="Reason (shown in ledger)"></div><button>Apply</button></form></div>
  </div>
  <div class="card"><h2>Account</h2><div class="row" style="align-items:center">
    ${
      self
        ? '<p class="muted">This is your own account.</p>'
        : `<form method="post" action="/users/${u.id}/role"><input type="hidden" name="role" value="${u.role === 'admin' ? 'user' : 'admin'}"><button class="secondary">${u.role === 'admin' ? 'Remove admin rights' : 'Make admin'}</button></form>
      <form method="post" action="/users/${u.id}/suspend"><input type="hidden" name="suspend" value="${u.suspended_at ? '0' : '1'}"><button class="${u.suspended_at ? 'secondary' : 'danger'}">${u.suspended_at ? 'Reactivate account' : 'Suspend account'}</button></form>`
    }
  </div></div>
  <div class="card"><h2>Apps</h2><table><tr><th>Name</th><th>Address</th><th>Updated</th></tr>
    ${apps.map((a) => `<tr><td>${esc(a.name)}</td><td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ''))}</a></td><td>${date(a.updated_at)}</td></tr>`).join('') || '<tr><td colspan=3 class="muted">No apps</td></tr>'}
  </table></div>
  <div class="card"><h2>Credit history</h2><table><tr><th>When</th><th>Type</th><th>Detail</th><th class="num">Credits</th></tr>
    ${ledger.map((l) => `<tr><td>${dateTime(l.created_at)}</td><td>${esc(l.kind)}</td><td>${esc(l.note)}</td><td class="num ${l.delta < 0 ? 'neg' : 'pos'}">${l.delta > 0 ? '+' : ''}${n(l.delta)}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">No activity</td></tr>'}
  </table></div>`;
}

function planForm(p = {}, currency = 'GBP') {
  const v = (k, d = '') => esc(p[k] ?? d);

  return `<form method="post" action="${p.id ? `/plans/${p.id}` : '/plans'}">
    <div class="row"><div><label>Name</label><input name="name" required value="${v('name')}" placeholder="Pro"></div>
      ${p.id ? '' : `<div><label>Code</label><input name="slug" value="${v('slug')}" placeholder="pro"></div>`}
      <div style="flex:0 0 120px"><label>Price / month</label><input name="price" type="number" step="0.01" min="0" value="${p.price_cents !== undefined ? (p.price_cents / 100).toFixed(2) : ''}" placeholder="15.00"></div>
      <div style="flex:0 0 90px"><label>Currency</label><input name="currency" value="${v('currency', currency)}" maxlength="3"></div></div>
    <label>Description</label><input name="description" value="${v('description')}" placeholder="Shown on the pricing page">
    <div class="row"><div><label>Monthly credits</label><input name="monthly_credits" type="number" min="0" value="${v('monthly_credits', 1000)}"></div>
      <div><label>Max apps</label><input name="max_apps" type="number" min="0" value="${v('max_apps', 10)}"></div>
      <div><label>Sort order</label><input name="sort" type="number" value="${v('sort', 0)}"></div></div>
    <label>Whop plan ID <span class="muted" style="font-weight:400">(optional — leave empty and Makelo creates the Whop plan for you)</span></label><input name="gateway_plan_id" value="${v('gateway_plan_id')}" placeholder="plan_…">
    <label class="check"><input type="checkbox" name="custom_domains" value="1" ${p.custom_domains ? 'checked' : ''}> Allow custom domains</label>
    <label class="check"><input type="checkbox" name="visible" value="1" ${p.id === undefined || p.visible ? 'checked' : ''}> Show on pricing page</label>
    <p></p><button>${p.id ? 'Save plan' : 'Create plan'}</button>
  </form>`;
}

export function plansPage({ plans, defaultPlanId, currency, packs }) {
  return `<h1>Plans</h1>
  <div class="card" style="padding:8px 14px"><table>
    <tr><th>Plan</th><th class="num">Price</th><th class="num">Credits / mo</th><th class="num">Max apps</th><th>Domains</th><th class="num">Subscribers</th><th></th></tr>
    ${plans
      .map(
        (p) => `<tr style="${p.archived ? 'opacity:.5' : ''}"><td><b>${esc(p.name)}</b> <span class="muted">${esc(p.slug)}</span>
          ${p.id === defaultPlanId ? ' <span class="pill ok">Default</span>' : ''}${p.visible ? '' : ' <span class="pill off">Hidden</span>'}${p.archived ? ' <span class="pill off">Archived</span>' : ''}</td>
        <td class="num">${esc(money(p.price_cents, p.currency))}</td><td class="num">${n(p.monthly_credits)}</td><td class="num">${n(p.max_apps)}</td>
        <td>${p.custom_domains ? 'Yes' : 'No'}</td><td class="num">${n(p.subscribers)}</td><td><a href="/plans/${p.id}">Edit</a></td></tr>`,
      )
      .join('')}
  </table></div>
  <div class="card"><h2>New plan</h2>${planForm({}, currency)}</div>
  ${packsSection(packs, currency)}`;
}

function packsSection(packs = [], currency = 'GBP') {
  const rows = packs
    .map(
      (k) => `<tr style="${k.archived ? 'opacity:.5' : ''}"><td colspan="6"><form method="post" action="/packs/${k.id}" class="row" style="align-items:end">
        <div><label>Name</label><input name="name" value="${esc(k.name)}"></div>
        <div style="flex:0 0 120px"><label>Credits</label><input name="credits" type="number" min="1" value="${k.credits}"></div>
        <div style="flex:0 0 110px"><label>Price</label><input name="price" type="number" step="0.01" min="0" value="${(k.price_cents / 100).toFixed(2)}"></div>
        <div style="flex:0 0 80px"><label>Currency</label><input name="currency" maxlength="3" value="${esc(k.currency)}"></div>
        <div style="flex:0 0 70px"><label>Order</label><input name="sort" type="number" value="${k.sort}"></div>
        <label class="check" style="flex:0 0 auto;margin-bottom:10px"><input type="checkbox" name="visible" value="1" ${k.visible ? 'checked' : ''}> Visible</label>
        <button class="secondary">Save</button></form>
        <form method="post" action="/packs/${k.id}/archive" style="margin-top:6px"><input type="hidden" name="archived" value="${k.archived ? '0' : '1'}"><button class="secondary" style="font-size:12px;padding:5px 10px">${k.archived ? 'Restore' : 'Archive'}</button></form></td></tr>`,
    )
    .join('');

  return `<div class="card"><h2>Credit top-up packs</h2><p class="muted">One-off purchases. Credits are added on top of the plan allowance.</p>
    <table>${rows}</table>
    <h2 style="margin-top:18px">New credit pack</h2>
    <form method="post" action="/packs" class="row" style="align-items:end">
      <div><label>Name</label><input name="name" required placeholder="Mega top-up"></div>
      <div style="flex:0 0 120px"><label>Credits</label><input name="credits" type="number" min="1" required placeholder="5000"></div>
      <div style="flex:0 0 110px"><label>Price</label><input name="price" type="number" step="0.01" min="0" required placeholder="35.00"></div>
      <div style="flex:0 0 80px"><label>Currency</label><input name="currency" maxlength="3" value="${esc(currency)}"></div>
      <input type="hidden" name="visible" value="1"><button>Create pack</button></form></div>`;
}

export function paymentsPage({ payments, revenue, configured, webhookConfigured, webhookUrl, sandbox }) {
  return `<h1>Payments</h1>
  ${!configured ? '<div class="flash warn">Whop is not connected. Add the Whop API key and company ID under <a href="/keys">API keys</a>.</div>' : ''}
  <div class="stats">
    ${revenue.map((r) => `<div class="stat"><div class="k">Revenue 30 days (${esc(r.currency)})</div><div class="v">${esc(money(r.cents, r.currency))}</div><div class="s">${n(r.n)} payments</div></div>`).join('') || '<div class="stat"><div class="k">Revenue 30 days</div><div class="v">£0.00</div></div>'}
    <div class="stat"><div class="k">Gateway</div><div class="v" style="font-size:20px">Whop ${sandbox ? '<span class="pill wait">Sandbox</span>' : ''}</div><div class="s">${configured ? 'Connected' : 'Not connected'} · webhook ${webhookConfigured ? 'secret set' : 'secret missing'}</div></div>
  </div>
  <div class="card"><h2>Webhook</h2><p class="muted">In the Whop dashboard, create a webhook pointing to this URL with the events <code>payment.succeeded</code>, <code>membership.updated</code> and <code>membership.deactivated</code>, then paste its secret under API keys.</p>
    <code>${esc(webhookUrl)}</code></div>
  <div class="card" style="padding:8px 14px"><table><tr><th>When</th><th>User</th><th>Type</th><th>Item</th><th class="num">Amount</th><th>Reference</th></tr>
    ${payments.map((p) => `<tr><td>${dateTime(p.created_at)}</td><td>${p.user_id ? `<a href="/users/${p.user_id}">${esc(p.email || p.user_id)}</a>` : '—'}</td><td>${esc(p.kind)}</td><td>${esc(p.description)}</td><td class="num">${esc(money(p.amount_cents, p.currency))}</td><td><code style="font-size:11px">${esc(p.ref)}</code></td></tr>`).join('') || '<tr><td colspan=6 class="muted">No payments yet</td></tr>'}
  </table></div>`;
}

export function planPage({ plan, currency }) {
  return `<p><a href="/plans">← Plans</a></p><h1>${esc(plan.name)}</h1>
  <div class="card">${planForm(plan, currency)}</div>
  <div class="card"><h2>${plan.archived ? 'Restore plan' : 'Archive plan'}</h2>
    <p class="muted">${plan.archived ? 'Make this plan available again.' : 'Archived plans can’t be chosen for new users. Existing subscribers keep it.'}</p>
    <form method="post" action="/plans/${plan.id}/archive"><input type="hidden" name="archived" value="${plan.archived ? '0' : '1'}"><button class="${plan.archived ? 'secondary' : 'danger'}">${plan.archived ? 'Restore' : 'Archive'}</button></form></div>`;
}

export function usagePage({ totals, daily, entries, kind }) {
  const max = Math.max(1, ...daily.map((x) => x.used));
  const bars = daily.map((x) => `<div title="${esc(x.day)}: ${n(x.used)}" style="height:${Math.round((x.used / max) * 100)}%"></div>`).join('');
  const tab = (k, label) => `<a class="btn ${kind === k ? '' : 'secondary'}" href="/usage${k ? `?kind=${k}` : ''}">${label}</a>`;

  return `<h1>Credits & usage</h1>
  <div class="stats">
    <div class="stat"><div class="k">AI credits (30 days)</div><div class="v">${n(totals.ai)}</div></div>
    <div class="stat"><div class="k">Sandbox credits (30 days)</div><div class="v">${n(totals.sandbox)}</div></div>
    <div class="stat"><div class="k">Credits granted (30 days)</div><div class="v">${n(totals.granted)}</div></div>
    <div class="stat"><div class="k">AI tokens (30 days)</div><div class="v">${n(totals.tokens)}</div></div>
  </div>
  <div class="card"><h2>Credits used per day</h2><div class="bars">${bars}</div></div>
  <div style="display:flex;gap:8px;margin-bottom:12px">${tab('', 'All')}${tab('ai', 'AI')}${tab('sandbox', 'Sandbox')}${tab('grant', 'Grants')}${tab('admin', 'Admin adjustments')}</div>
  <div class="card" style="padding:8px 14px"><table><tr><th>When</th><th>User</th><th>Type</th><th>Detail</th><th class="num">Credits</th></tr>
    ${entries.map((l) => `<tr><td>${dateTime(l.created_at)}</td><td><a href="/users/${l.user_id}">${esc(l.email)}</a></td><td>${esc(l.kind)}</td><td>${esc(l.note)}</td><td class="num ${l.delta < 0 ? 'neg' : 'pos'}">${l.delta > 0 ? '+' : ''}${n(l.delta)}</td></tr>`).join('') || '<tr><td colspan=5 class="muted">No activity yet</td></tr>'}
  </table></div>`;
}

const timeAgoShort = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function keyState(k) {
  if (k.source === 'missing') {
    return '<span class="pill wait">Not connected</span>';
  }

  const where = k.source === 'dashboard' ? '' : ' <span class="muted" style="font-size:12px">(server env)</span>';
  const value = `<code>${esc(k.masked)}</code>`;

  if (!k.test) {
    return `<span class="pill">Saved</span> ${value}${where}`;
  }

  return k.test.ok
    ? `<span class="pill ok">Connected</span> ${value}${where} <span class="muted" style="font-size:12px">checked ${timeAgoShort(k.test.at)}</span>`
    : `<span class="pill bad" title="${esc(k.test.message)}">Failed</span> ${value}${where}<div class="muted" style="font-size:12px;margin-top:4px">${esc(k.test.message)}</div>`;
}

export function keysPage({ keys, testable = new Set() }) {
  const groups = [...new Set(keys.map((k) => k.group))];
  const set = keys.filter((k) => k.source !== 'missing');
  const connected = set.filter((k) => k.test?.ok).length;

  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <h1 style="margin:0">API keys &amp; providers</h1>
    <form method="post" action="/keys/test-all"><button class="secondary">Test all connections</button></form></div>
  <p class="muted">Connect every third-party service Makelo uses. Keys are encrypted, override the server's environment
  variables and take effect within a minute — no restart. Users never see or enter keys: every AI request runs on the keys
  connected here. ${set.length} of ${keys.length} set${set.length ? `, ${connected} verified` : ''}.</p>
  ${groups
    .map(
      (g) => `<div class="card"><h2>${esc(g)}</h2>
      ${keys
        .filter((k) => k.group === g)
        .map(
          (k) => `<div class="keyrow"><div><b>${esc(k.label)}</b><div class="muted" style="font-size:12px"><code>${esc(k.env)}</code>${k.help ? ` · ${esc(k.help)}` : ''}</div></div>
          <div>${keyState(k)}</div>
          <div class="keyactions"><form method="post" action="/keys"><input type="hidden" name="env" value="${esc(k.env)}"><input name="value" type="${k.format === 'url' ? 'url' : 'password'}" placeholder="${k.format === 'url' ? 'https://…' : k.format === 'json' ? 'Paste JSON' : 'Paste key'}" autocomplete="off"><button>Save</button>
            ${k.source === 'dashboard' ? `<button class="secondary" name="clear" value="1" formnovalidate>Remove</button>` : ''}</form>
            ${k.source !== 'missing' && testable.has(k.env) ? `<form method="post" action="/keys/test"><input type="hidden" name="env" value="${esc(k.env)}"><button class="secondary">Test</button></form>` : ''}</div></div>`,
        )
        .join('')}</div>`,
    )
    .join('')}`;
}

export function settingsPage({ rates, plans, defaultPlanId, whopSandbox }) {
  return `<h1>Settings</h1>
  <form method="post" action="/settings">
  <div class="card"><h2>Credit pricing</h2><p class="muted">How many credits each activity costs. Changes apply immediately.</p>
    <div class="row"><div><label>Credits per 1,000 input tokens</label><input name="credits_per_1k_input" type="number" step="0.01" min="0" value="${esc(rates.credits_per_1k_input)}"></div>
      <div><label>Credits per 1,000 output tokens</label><input name="credits_per_1k_output" type="number" step="0.01" min="0" value="${esc(rates.credits_per_1k_output)}"></div>
      <div><label>Credits per sandbox minute</label><input name="credits_per_sandbox_minute" type="number" step="0.01" min="0" value="${esc(rates.credits_per_sandbox_minute)}"></div></div></div>
  <div class="card"><h2>New users</h2>
    <div class="row"><div><label>Plan for new sign-ups</label><select name="default_plan_id" style="width:100%">${plans
      .filter((p) => !p.archived)
      .map((p) => `<option value="${p.id}" ${p.id === defaultPlanId ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('')}</select></div>
      <div><label>Extra sign-up bonus credits</label><input name="signup_bonus_credits" type="number" min="0" value="${esc(rates.signup_bonus_credits)}"></div>
      <div style="flex:0 0 120px"><label>Currency</label><input name="currency" maxlength="3" value="${esc(rates.currency)}"></div></div></div>
  <div class="card"><h2>Payments</h2>
    <input type="hidden" name="whop_sandbox_present" value="1">
    <label class="check"><input type="checkbox" name="whop_sandbox" value="1" ${whopSandbox ? 'checked' : ''}> Whop sandbox mode (test payments with test cards — turn off to take real money)</label></div>
  <button>Save settings</button></form>`;
}
