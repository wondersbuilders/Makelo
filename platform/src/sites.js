import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RESERVED_SLUGS } from './config.js';
import { now } from './db.js';

export function slugify(name) {
  const base = String(name || 'app')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  return base || 'app';
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const isValidSlug = (slug) => SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);

/** Turn a client-supplied path into a safe relative path, or null if it is unsafe. */
export function safeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512 || p.includes('\0') || p.includes('\\')) {
    return null;
  }

  const norm = path.posix.normalize('/' + p.replace(/^\/+/, ''));

  if (norm === '/' || norm.endsWith('/') || norm.split('/').some((seg) => seg === '..' || seg.startsWith('.git'))) {
    return null;
  }

  return norm.slice(1);
}

export function createSites(db, config) {
  const sitesRoot = path.join(config.dataDir, 'sites');
  fs.mkdirSync(sitesRoot, { recursive: true });

  const q = {
    byId: db.prepare('SELECT * FROM sites WHERE id = ?'),
    byOwner: db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?'),
    bySlug: db.prepare('SELECT * FROM sites WHERE slug = ?'),
    byChat: db.prepare('SELECT * FROM sites WHERE user_id = ? AND chat_id = ?'),
    forUser: db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY updated_at DESC'),
    countForUser: db.prepare('SELECT COUNT(*) AS n FROM sites WHERE user_id = ?'),
    insert: db.prepare(
      'INSERT INTO sites (user_id, name, slug, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    rename: db.prepare('UPDATE sites SET name = ?, updated_at = ? WHERE id = ?'),
    setSlug: db.prepare('UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM sites WHERE id = ?'),
    insertDeploy: db.prepare('INSERT INTO deploys (site_id, file_count, bytes, created_at) VALUES (?, ?, ?, ?)'),
    setCurrent: db.prepare('UPDATE sites SET current_deploy = ?, updated_at = ? WHERE id = ?'),
    oldDeploys: db.prepare('SELECT id FROM deploys WHERE site_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?'),
    deleteDeploy: db.prepare('DELETE FROM deploys WHERE id = ?'),
    deploysFor: db.prepare('SELECT * FROM deploys WHERE site_id = ? ORDER BY id DESC LIMIT 10'),
  };

  function uniqueSlug(name) {
    const base = slugify(name).slice(0, 34).replace(/-+$/g, '') || 'app';

    for (let i = 0; i < 20; i++) {
      const slug = `${base}-${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;

      if (isValidSlug(slug) && !q.bySlug.get(slug)) {
        return slug;
      }
    }

    throw new Error('Could not allocate a subdomain, try again.');
  }

  const siteUrl = (site) => `${config.scheme}://${site.slug}.${config.sitesDomain}`;

  return {
    siteUrl,
    get: (id) => q.byId.get(id),
    bySlug: (slug) => q.bySlug.get(slug) || null,
    getOwned: (id, userId) => q.byOwner.get(id, userId),
    list: (userId) => q.forUser.all(userId),
    deploys: (siteId) => q.deploysFor.all(siteId),

    /** Find the site attached to a builder chat, or create one with a free subdomain. */
    ensureForChat(userId, { name, chatId }) {
      const cleanName = String(name || 'My app').trim().slice(0, 80) || 'My app';
      const chat = chatId ? String(chatId).slice(0, 100) : null;

      if (chat) {
        const existing = q.byChat.get(userId, chat);

        if (existing) {
          return { site: existing };
        }
      }

      if (q.countForUser.get(userId).n >= config.maxSitesPerUser) {
        return { error: `You can have up to ${config.maxSitesPerUser} apps on your plan.` };
      }

      const t = now();
      const info = q.insert.run(userId, cleanName, uniqueSlug(cleanName), chat, t, t);

      return { site: q.byId.get(info.lastInsertRowid) };
    },

    rename(site, name) {
      const clean = String(name || '').trim().slice(0, 80);

      if (!clean) {
        return { error: 'Name cannot be empty.' };
      }

      q.rename.run(clean, now(), site.id);

      return { site: q.byId.get(site.id) };
    },

    changeSlug(site, wanted) {
      const slug = String(wanted || '').trim().toLowerCase();

      if (!isValidSlug(slug)) {
        return { error: 'Subdomain must be 1–63 letters, numbers or dashes, and not a reserved word.' };
      }

      const taken = q.bySlug.get(slug);

      if (taken && taken.id !== site.id) {
        return { error: 'That subdomain is taken.' };
      }

      q.setSlug.run(slug, now(), site.id);

      return { site: q.byId.get(site.id) };
    },

    remove(site) {
      q.remove.run(site.id);
      fs.rmSync(path.join(sitesRoot, String(site.id)), { recursive: true, force: true });
    },

    /**
     * Store a new deploy. `files` maps path -> base64 content.
     * Files are written to a fresh folder and the site is switched over only once all writes succeed.
     */
    deploy(site, files) {
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        return { error: 'No files were sent.' };
      }

      const entries = Object.entries(files);

      if (entries.length === 0) {
        return { error: 'The build produced no files.' };
      }

      if (entries.length > config.maxDeployFiles) {
        return { error: `Too many files (max ${config.maxDeployFiles}).` };
      }

      const decoded = [];
      let bytes = 0;

      for (const [rawPath, b64] of entries) {
        const rel = safeRelPath(rawPath);

        if (!rel) {
          return { error: `Unsafe file path: ${String(rawPath).slice(0, 80)}` };
        }

        if (typeof b64 !== 'string') {
          return { error: `File ${rel} must be base64 text.` };
        }

        const buf = Buffer.from(b64, 'base64');
        bytes += buf.length;

        if (bytes > config.maxDeployBytes) {
          return { error: `App is too large (max ${Math.round(config.maxDeployBytes / 1048576)} MB).` };
        }

        decoded.push([rel, buf]);
      }

      if (!decoded.some(([rel]) => rel === 'index.html')) {
        return { error: 'The build has no index.html at its top level, so there is nothing to show.' };
      }

      const deployId = q.insertDeploy.run(site.id, decoded.length, bytes, now()).lastInsertRowid;
      const dir = path.join(sitesRoot, String(site.id), String(deployId));

      try {
        for (const [rel, buf] of decoded) {
          const target = path.join(dir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, buf);
        }
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        q.deleteDeploy.run(deployId);
        throw err;
      }

      q.setCurrent.run(deployId, now(), site.id);

      for (const old of q.oldDeploys.all(site.id, config.keepDeploys)) {
        fs.rmSync(path.join(sitesRoot, String(site.id), String(old.id)), { recursive: true, force: true });
        q.deleteDeploy.run(old.id);
      }

      return { site: q.byId.get(site.id), deployId, files: decoded.length, bytes };
    },

    /** Resolve a request path against a site's live deploy. Returns an absolute file path or null. */
    resolveFile(site, urlPath) {
      if (!site.current_deploy) {
        return null;
      }

      const root = path.join(sitesRoot, String(site.id), String(site.current_deploy));
      let decoded;

      try {
        decoded = decodeURIComponent(urlPath.split('?')[0]);
      } catch {
        return null;
      }

      const rel = path.posix.normalize('/' + decoded).replace(/^\/+/, '');

      if (rel.split('/').includes('..')) {
        return null;
      }

      const candidates = rel === '' ? ['index.html'] : [rel, `${rel}/index.html`, `${rel}.html`];

      // Single-page apps: unknown routes without a file extension fall back to index.html.
      if (!path.posix.extname(rel)) {
        candidates.push('index.html');
      }

      for (const c of candidates) {
        const abs = path.join(root, c);

        if (abs.startsWith(root + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          return abs;
        }
      }

      return null;
    },
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
