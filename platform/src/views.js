export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const LOGO = `<svg viewBox="0 0 230 48" height="30" aria-label="Makelo"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#2563EB"/></linearGradient></defs><rect x="0" y="4" width="40" height="40" rx="9" fill="url(#g)"/><path d="M14 13 L14 32 L19 27.3 L22.5 34.5 L26 33 L22.6 25.9 L29 25.5 Z" fill="#fff" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/><text x="50" y="33" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="25" font-weight="700" fill="currentColor">Make<tspan fill="#7C3AED">lo</tspan></text></svg>`;

export const CSS = `
:root{--bg:#f7f7fb;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--accent:#7c3aed;--accent2:#2563eb;--ok:#059669;--warn:#b45309;--bad:#dc2626;--code:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b12;--card:#15151f;--text:#f3f4f6;--muted:#9ca3af;--line:#272735;--code:#1f1f2b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,Segoe UI,system-ui,sans-serif}
a{color:var(--accent)}header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--card)}
header nav{display:flex;gap:16px;align-items:center}header a.logo{color:var(--text);display:flex}
main{max-width:920px;margin:32px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:18px}
.narrow{max-width:420px}h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}p.muted,.muted{color:var(--muted)}
label{display:block;font-weight:600;margin:12px 0 6px}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--text);font:inherit}
button,.btn{display:inline-block;border:0;border-radius:9px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;text-decoration:none}
button.secondary,.btn.secondary{background:var(--code);color:var(--text);border:1px solid var(--line)}button.danger{background:var(--bad)}
.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.row>*{flex:1}.row>button{flex:0 0 auto}
.flash{padding:12px 14px;border-radius:10px;margin-bottom:16px}.flash.error{background:#fee2e2;color:#991b1b}.flash.ok{background:#d1fae5;color:#065f46}.flash.warn{background:#fef3c7;color:#92400e}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}code{background:var(--code);padding:2px 6px;border-radius:6px;word-break:break-all}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:99px}.pill.ok{background:#d1fae5;color:#065f46}.pill.wait{background:#fef3c7;color:#92400e}.pill.off{background:var(--code);color:var(--muted)}.pill:not(.ok):not(.wait):not(.off):not(.bad){background:var(--code);color:var(--fg,inherit)}.pill.bad{background:#fee2e2;color:#991b1b}
.apps{display:grid;gap:12px}.app{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
form.inline{display:inline}
.num{text-align:right;font-variant-numeric:tabular-nums}
`;

export function layout({ title, user, body, flash }) {
  const flashHtml = flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.message)}</div>` : '';
  const nav = user
    ? `<nav><a href="/">Builder</a><a href="/account">My apps</a><a href="/account/billing">Billing</a><span class="muted">${esc(user.email)}</span>
       <form class="inline" method="post" action="/account/logout"><button class="secondary">Log out</button></form></nav>`
    : `<nav><a href="/account/login">Log in</a><a class="btn" href="/account/signup">Sign up free</a></nav>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Makelo</title><link rel="icon" href="/favicon.svg"><style>${CSS}</style></head>
<body><header><a class="logo" href="/">${LOGO}</a>${nav}</header><main>${flashHtml}${body}</main></body></html>`;
}

export function authPage({ mode, error, email = '', next = '' }) {
  const signup = mode === 'signup';
  const action = signup ? '/account/signup' : '/account/login';

  return layout({
    title: signup ? 'Create your account' : 'Log in',
    flash: error ? { type: 'error', message: error } : null,
    body: `<div class="card narrow" style="margin:40px auto">
      <h1>${signup ? 'Create your free account' : 'Welcome back'}</h1>
      <p class="muted">${signup ? 'Build web and mobile apps with AI. Every app gets a free subdomain.' : 'Log in to keep building.'}</p>
      <form method="post" action="${action}">
        <input type="hidden" name="next" value="${esc(next)}">
        <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
        <label for="password">Password</label><input id="password" name="password" type="password" minlength="8" required autocomplete="${signup ? 'new-password' : 'current-password'}">
        <p></p><button style="width:100%">${signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="muted">${signup ? 'Already have an account? <a href="/account/login">Log in</a>' : 'New here? <a href="/account/signup">Create an account</a>'}</p>
    </div>`,
  });
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function planCard(billing) {
  if (!billing) return '';
  const plan = billing.plan;
  const renew = billing.periodEnd ? new Date(billing.periodEnd).toISOString().slice(0, 10) : '';
  const price = (p) => {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency }).format(p.price_cents / 100);
    } catch {
      return `${p.currency} ${(p.price_cents / 100).toFixed(2)}`;
    }
  };
  const others = billing.plans
    .filter((p) => !plan || p.id !== plan.id)
    .map((p) => `<div class="card" style="margin:0;background:var(--bg)"><b>${esc(p.name)}</b> · ${esc(price(p))}/month<div class="muted" style="font-size:13px">${Number(p.monthly_credits).toLocaleString('en-GB')} credits · ${p.max_apps} apps${p.custom_domains ? ' · custom domains' : ''}</div></div>`)
    .join('');

  return `<div class="card"><div class="app"><div><h2 style="margin:0">${esc(plan?.name || 'Free')} plan</h2>
    <div class="muted">${Number(billing.balance).toLocaleString('en-GB')} credits left${renew ? ` · renews ${esc(renew)}` : ''}</div></div>
    <div style="display:flex;gap:8px;align-items:center"><span class="pill ${billing.balance > 0 ? 'ok' : 'wait'}">${billing.balance > 0 ? 'Active' : 'Out of credits'}</span>
    <a class="btn" href="/account/billing">Upgrade or buy credits</a></div></div>
    ${others ? `<p class="muted" style="margin-top:14px">Other plans</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">${others}</div>` : ''}
  </div>`;
}

export function dashboardPage({ user, sites, siteUrl, tokens, newToken, flash, billing }) {
  const apps = sites.length
    ? sites
        .map(
          (s) => `<div class="card app"><div><h2 style="margin:0">${esc(s.name)}</h2>
          <a href="${esc(siteUrl(s))}" target="_blank" rel="noopener">${esc(siteUrl(s).replace(/^https?:\/\//, ''))}</a>
          <div class="muted">${s.current_deploy ? `Published ${when(s.updated_at)}` : 'Not published yet'}</div></div>
          <div>${s.chat_id ? `<a class="btn secondary" href="/chat/${encodeURIComponent(s.chat_id)}">Open in builder</a> ` : ''}
          <a class="btn" href="/account/apps/${s.id}">Settings &amp; domains</a></div></div>`,
        )
        .join('')
    : `<div class="card"><h2>No apps yet</h2><p class="muted">Open the <a href="/">builder</a>, describe your app, then press <b>Publish → Makelo</b>. It goes live on a free subdomain instantly.</p></div>`;

  const tokenRows = tokens
    .map(
      (t) => `<tr><td>${esc(t.name)}</td><td>${when(t.created_at)}</td><td>
      <form class="inline" method="post" action="/account/tokens/${esc(t.id)}/delete"><button class="secondary">Revoke</button></form></td></tr>`,
    )
    .join('');

  return layout({
    title: 'My apps',
    user,
    flash,
    body: `<div class="row" style="align-items:center;margin-bottom:12px"><h1>My apps</h1><div style="text-align:right"><a class="btn" href="/">+ Build a new app</a></div></div>
      ${planCard(billing)}
      <div class="apps">${apps}</div>
      <div class="card"><h2>Desktop app access</h2>
        <p class="muted">The Makelo desktop app publishes to your account with an access token. Paste it into the desktop app when it asks.</p>
        ${newToken ? `<div class="flash ok">Copy this now — it won't be shown again:<br><code>${esc(newToken)}</code></div>` : ''}
        ${tokenRows ? `<table><tr><th>Name</th><th>Created</th><th></th></tr>${tokenRows}</table><p></p>` : ''}
        <form method="post" action="/account/tokens" class="row"><div><label for="tname">Token name</label><input id="tname" name="name" value="My laptop"></div><button>Create token</button></form>
      </div>`,
  });
}

export function appPage({ user, site, siteUrl, domains, instructions, deploys, flash, config }) {
  const domainRows = domains
    .map((d) => {
      const records = instructions(d, site)
        .map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code></td><td><code>${esc(r.value)}</code></td><td class="muted">${esc(r.purpose)}</td></tr>`)
        .join('');

      return `<div class="card" style="background:var(--bg)"><div class="app"><div><b>${esc(d.hostname)}</b>
        ${d.verified_at ? '<span class="pill ok">Connected</span>' : '<span class="pill wait">Waiting for DNS</span>'}</div>
        <div>${d.verified_at ? `<a href="${esc(config.scheme)}://${esc(d.hostname)}" target="_blank" rel="noopener">Visit</a> ` : `<form class="inline" method="post" action="/account/domains/${d.id}/verify"><button>Check DNS</button></form> `}
        <form class="inline" method="post" action="/account/domains/${d.id}/delete"><button class="secondary">Remove</button></form></div></div>
        ${d.verified_at ? '' : `<p class="muted">Add these records at the company you bought the domain from, then press <b>Check DNS</b>.</p>
        <table><tr><th>Type</th><th>Name / Host</th><th>Value</th><th></th></tr>${records}</table>`}</div>`;
    })
    .join('');

  const deployRows = deploys
    .map((d) => `<tr><td>#${d.id}</td><td>${when(d.created_at)}</td><td>${d.file_count} file${d.file_count === 1 ? '' : 's'}</td><td>${(d.bytes / 1024).toFixed(0)} KB</td><td>${d.id === site.current_deploy ? '<span class="pill ok">Live</span>' : ''}</td></tr>`)
    .join('');

  return layout({
    title: site.name,
    user,
    flash,
    body: `<p><a href="/account">← My apps</a></p>
      <div class="card"><h1>${esc(site.name)}</h1>
        <p>Free address: <a href="${esc(siteUrl(site))}" target="_blank" rel="noopener">${esc(siteUrl(site))}</a> ${site.current_deploy ? '<span class="pill ok">Live</span>' : '<span class="pill off">Not published</span>'}</p>
        ${site.chat_id ? `<a class="btn secondary" href="/chat/${encodeURIComponent(site.chat_id)}">Open in builder</a>` : ''}
      </div>
      <div class="card"><h2>Your own domain</h2>
        <p class="muted">Connect a domain you own, like <code>myshop.com</code> or <code>app.myshop.com</code>. HTTPS is set up automatically.</p>
        ${domainRows}
        <form method="post" action="/account/apps/${site.id}/domains" class="row"><div><label for="host">Domain</label><input id="host" name="hostname" placeholder="app.myshop.com" required></div><button>Connect domain</button></form>
      </div>
      <div class="card"><h2>Settings</h2>
        <form method="post" action="/account/apps/${site.id}/rename" class="row"><div><label for="name">App name</label><input id="name" name="name" value="${esc(site.name)}"></div><button class="secondary">Save</button></form>
        <form method="post" action="/account/apps/${site.id}/slug" class="row"><div><label for="slug">Free subdomain</label><input id="slug" name="slug" value="${esc(site.slug)}" pattern="[a-z0-9-]{1,63}"></div><div class="muted" style="flex:0 0 auto;padding-bottom:10px">.${esc(config.sitesDomain)}</div><button class="secondary">Change</button></form>
      </div>
      <div class="card"><h2>Publish history</h2>${deployRows ? `<table><tr><th>Version</th><th>When</th><th>Size</th><th></th><th></th></tr>${deployRows}</table>` : '<p class="muted">Not published yet.</p>'}</div>
      <div class="card"><h2>Delete app</h2><p class="muted">Takes the app offline and removes its files and domains. This can't be undone.</p>
        <form method="post" action="/account/apps/${site.id}/delete" onsubmit="return confirm('Delete ${esc(site.name).replace(/'/g, '')} permanently?')"><button class="danger">Delete app</button></form></div>`,
  });
}

export function placeholderPage({ title, message, href = 'https://makelo.com' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS} body{display:grid;place-items:center;min-height:100vh;text-align:center}</style></head>
<body><div class="card narrow"><div style="color:var(--text)">${LOGO}</div><h1 style="margin-top:16px">${esc(title)}</h1><p class="muted">${esc(message)}</p>
<a class="btn" href="${esc(href)}">Build your own app with Makelo</a></div></body></html>`;
}

const fmtMoney = (cents, currency) => {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format((cents || 0) / 100);
  } catch {
    return `${currency} ${((cents || 0) / 100).toFixed(2)}`;
  }
};

/** Billing & credits: current plan, upgrade options, credit top-ups, payment history. */
export function billingPage({ user, sub, balance, used, plans, packs, membership, history, payEnabled, flash }) {
  const current = sub?.plan;
  const renew = sub?.period_end ? new Date(sub.period_end).toISOString().slice(0, 10) : '';
  const buy = (kind, id, label, primary = true) =>
    payEnabled
      ? `<form method="post" action="/account/billing/checkout"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${id}"><button class="${primary ? '' : 'secondary'}" style="width:100%">${esc(label)}</button></form>`
      : `<button class="secondary" style="width:100%" disabled>Payments coming soon</button>`;

  const planCards = plans
    .map((p) => {
      const isCurrent = current && current.id === p.id;
      const action = isCurrent
        ? '<button class="secondary" style="width:100%" disabled>Current plan</button>'
        : p.price_cents > 0
          ? buy('plan', p.id, current && current.price_cents > p.price_cents ? `Switch to ${p.name}` : `Upgrade to ${p.name}`)
          : '';
      return `<div class="card" style="margin:0;display:flex;flex-direction:column;gap:8px;${isCurrent ? 'border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,58,237,.15)' : ''}">
        <div><h2 style="margin:0">${esc(p.name)}</h2><div class="muted" style="font-size:13px">${esc(p.description || '')}</div></div>
        <div style="font-size:28px;font-weight:700">${p.price_cents ? esc(fmtMoney(p.price_cents, p.currency)) : 'Free'}<span class="muted" style="font-size:14px;font-weight:400">${p.price_cents ? ' /month' : ''}</span></div>
        <ul style="margin:0;padding-left:18px;color:var(--muted);font-size:14px">
          <li>${Number(p.monthly_credits).toLocaleString('en-GB')} credits every month</li>
          <li>Up to ${p.max_apps} published apps</li>
          <li>${p.custom_domains ? 'Connect your own domains' : 'Free subdomain only'}</li>
        </ul>
        <div style="margin-top:auto">${action}</div></div>`;
    })
    .join('');

  const packCards = packs
    .map(
      (k) => `<div class="card" style="margin:0;display:flex;flex-direction:column;gap:6px"><b>${esc(k.name)}</b>
      <div style="font-size:22px;font-weight:700">${Number(k.credits).toLocaleString('en-GB')} <span class="muted" style="font-size:14px;font-weight:400">credits</span></div>
      <div class="muted">${esc(fmtMoney(k.price_cents, k.currency))} · one-off · kept when your plan renews</div>${buy('credits', k.id, `Buy for ${fmtMoney(k.price_cents, k.currency)}`, false)}</div>`,
    )
    .join('');

  const rows = history
    .map(
      (h) => `<tr><td>${new Date(h.created_at).toISOString().slice(0, 10)}</td><td>${esc(h.description)}</td><td class="num">${esc(fmtMoney(h.amount_cents, h.currency))}</td><td><span class="pill ok">${esc(h.status)}</span></td></tr>`,
    )
    .join('');

  return layout({
    title: 'Billing & credits',
    user,
    flash,
    body: `<p><a href="/account">← My apps</a></p><h1>Billing & credits</h1>
      <div class="card"><div class="app"><div><h2 style="margin:0">${esc(current?.name || 'Free')} plan</h2>
        <div class="muted">${Number(balance).toLocaleString('en-GB')} credits left${renew ? ` · ${membership?.status === 'canceling' ? 'ends' : 'renews'} ${esc(renew)}` : ''} · used this period: ${Number((used.ai || 0) + (used.sandbox || 0)).toLocaleString('en-GB')}</div></div>
        ${
          membership && membership.status !== 'canceling'
            ? `<form method="post" action="/account/billing/cancel" onsubmit="return confirm('Cancel your subscription? You keep your plan until the end of this period.')"><button class="secondary">Cancel subscription</button></form>`
            : membership?.status === 'canceling'
              ? '<span class="pill wait">Cancels at period end</span>'
              : ''
        }</div></div>
      <h2 style="margin:22px 0 10px">Plans</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px">${planCards}</div>
      <h2 style="margin:26px 0 10px">Top up credits</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">${packCards || '<p class="muted">No credit packs available.</p>'}</div>
      <div class="card" style="margin-top:22px"><h2>Payment history</h2>${rows ? `<table><tr><th>Date</th><th>Item</th><th class="num">Amount</th><th>Status</th></tr>${rows}</table>` : '<p class="muted">No payments yet.</p>'}
        <p class="muted" style="font-size:13px">Payments are processed securely by Whop.</p></div>`,
  });
}
