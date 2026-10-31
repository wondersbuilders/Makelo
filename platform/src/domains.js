import dns from 'node:dns/promises';
import { randomToken } from './auth.js';
import { now } from './db.js';

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(input) {
  let h = String(input || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');

  return h;
}

export const VERIFY_PREFIX = '_makelo-verify';

/** Country suffixes where the registrable domain has three labels (myshop.co.uk is a root domain). */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'org.za', 'com.ng', 'org.ng', 'ng.com',
  'co.ke', 'or.ke', 'com.gh', 'co.in', 'net.in', 'org.in', 'com.br', 'com.mx', 'com.ar', 'co.jp',
  'com.cn', 'com.hk', 'com.sg', 'com.my', 'co.id', 'com.ph', 'co.kr', 'com.tr', 'com.pl', 'com.cy',
  'co.il', 'com.eg', 'co.th', 'com.vn', 'com.pk', 'com.sa', 'co.ae', 'com.ua',
]);

export function createDomains(db, config, resolver = dns) {
  const q = {
    forSite: db.prepare('SELECT * FROM domains WHERE site_id = ? ORDER BY created_at'),
    byId: db.prepare(
      'SELECT d.*, s.user_id FROM domains d JOIN sites s ON s.id = d.site_id WHERE d.id = ? AND s.user_id = ?',
    ),
    verifiedByHost: db.prepare('SELECT * FROM domains WHERE hostname = ? AND verified_at IS NOT NULL'),
    siteHasHost: db.prepare('SELECT 1 FROM domains WHERE site_id = ? AND hostname = ?'),
    dropOtherClaims: db.prepare('DELETE FROM domains WHERE hostname = ? AND id != ? AND verified_at IS NULL'),
    insert: db.prepare('INSERT INTO domains (site_id, hostname, verify_token, created_at) VALUES (?, ?, ?, ?)'),
    markVerified: db.prepare('UPDATE domains SET verified_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM domains WHERE id = ?'),
    verifiedSite: db.prepare(
      'SELECT s.* FROM domains d JOIN sites s ON s.id = d.site_id WHERE d.hostname = ? AND d.verified_at IS NOT NULL',
    ),
  };

  const isApex = (host) => {
    const labels = host.split('.');
    return labels.length === 2 || (labels.length === 3 && MULTI_PART_SUFFIXES.has(labels.slice(1).join('.')));
  };

  /** DNS records the customer must add at their registrar. */
  function instructions(domain, site) {
    const records = [
      { type: 'TXT', name: `${VERIFY_PREFIX}.${domain.hostname}`, value: domain.verify_token, purpose: 'Proves you own the domain' },
    ];

    if (isApex(domain.hostname)) {
      records.push({
        type: 'A',
        name: domain.hostname,
        value: config.serverIpv4 || '<your Makelo server IP>',
        purpose: 'Points your domain at Makelo',
      });
    } else {
      records.push({
        type: 'CNAME',
        name: domain.hostname,
        value: config.cnameTarget || `${site.slug}.${config.sitesDomain}`,
        purpose: 'Points your domain at Makelo',
      });
    }

    return records;
  }

  return {
    instructions,
    forSite: (siteId) => q.forSite.all(siteId),
    getOwned: (id, userId) => q.byId.get(id, userId),

    add(site, rawHost) {
      const hostname = normalizeHostname(rawHost);

      if (!HOST_RE.test(hostname)) {
        return { error: 'Enter a domain like myshop.com or app.myshop.com.' };
      }

      if (hostname === config.sitesDomain || hostname.endsWith(`.${config.sitesDomain}`) || hostname === config.appHost) {
        return { error: `You don't need to add ${config.sitesDomain} addresses — your free subdomain already works.` };
      }

      if (q.verifiedByHost.get(hostname)) {
        return { error: 'That domain is already connected to another app. If you own it, remove it there first.' };
      }

      if (q.siteHasHost.get(site.id, hostname)) {
        return { error: 'That domain is already added to this app.' };
      }

      const info = q.insert.run(site.id, hostname, `cma-${randomToken(18)}`, now());

      return { domain: db.prepare('SELECT * FROM domains WHERE id = ?').get(info.lastInsertRowid) };
    },

    /** Check the TXT ownership record and that traffic will reach us. */
    async verify(domain) {
      let txt = [];

      try {
        txt = (await resolver.resolveTxt(`${VERIFY_PREFIX}.${domain.hostname}`)).map((parts) => parts.join(''));
      } catch {
        /* no record yet */
      }

      if (!txt.includes(domain.verify_token)) {
        return {
          ok: false,
          error: `TXT record not found yet for ${VERIFY_PREFIX}.${domain.hostname}. DNS changes can take up to an hour — try again soon.`,
        };
      }

      let pointing = false;

      try {
        if (isApex(domain.hostname)) {
          const a = await resolver.resolve4(domain.hostname);
          pointing = !config.serverIpv4 || a.includes(config.serverIpv4);
        } else {
          const cname = (await resolver.resolveCname(domain.hostname)).map((c) => c.toLowerCase().replace(/\.$/, ''));
          pointing = cname.some((c) => c === config.cnameTarget || c.endsWith(`.${config.sitesDomain}`));
        }
      } catch {
        pointing = false;
      }

      if (q.verifiedByHost.get(domain.hostname)) {
        return { ok: false, error: 'Someone else already verified this domain.' };
      }

      db.transaction(() => {
        q.markVerified.run(now(), domain.id);
        q.dropOtherClaims.run(domain.hostname, domain.id);
      })();

      return pointing
        ? { ok: true }
        : {
            ok: true,
            warning:
              'Ownership confirmed. Your A/CNAME record does not point at Makelo yet, so visitors will not see your app until it does.',
          };
    },

    remove: (domain) => q.remove.run(domain.id),

    /** Site served for a verified custom hostname. */
    siteForHost: (host) => q.verifiedSite.get(host) || null,

    /** Caddy on-demand TLS asks this before issuing a certificate. */
    allowCertificate(host, sites) {
      const h = normalizeHostname(host);

      if (h === config.appHost || h === config.sitesDomain || h === `www.${config.sitesDomain}`) {
        return true;
      }

      if (h.endsWith(`.${config.sitesDomain}`)) {
        const label = h.slice(0, -(config.sitesDomain.length + 1));
        return !label.includes('.') && Boolean(sites.bySlug(label));
      }

      return Boolean(q.verifiedSite.get(h));
    },
  };
}
