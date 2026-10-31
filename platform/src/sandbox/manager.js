import crypto from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { now } from '../db.js';

/** The builder addresses files as /home/project/...; each sandbox maps that onto its own root. */
export const CLIENT_WORKDIR = '/home/project';
const IGNORE = /(^|\/)(node_modules|\.git|\.cache|\.next\/cache)(\/|$)/;
const MAX_INLINE_FILE = 1024 * 1024;
const BACKLOG = 4000;

export function createSandboxManager(db, config, provider) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandboxes (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_key TEXT NOT NULL,
      provider    TEXT NOT NULL,
      sandbox_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_used   INTEGER NOT NULL,
      PRIMARY KEY (user_id, project_key)
    );
    CREATE TABLE IF NOT EXISTS sandbox_usage (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
  `);

  const q = {
    get: db.prepare('SELECT * FROM sandboxes WHERE user_id = ? AND project_key = ? AND provider = ?'),
    upsert: db.prepare(
      `INSERT INTO sandboxes (user_id, project_key, provider, sandbox_id, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, project_key) DO UPDATE SET provider = excluded.provider, sandbox_id = excluded.sandbox_id, last_used = excluded.last_used`,
    ),
    touch: db.prepare('UPDATE sandboxes SET last_used = ? WHERE user_id = ? AND project_key = ?'),
    remove: db.prepare('DELETE FROM sandboxes WHERE user_id = ? AND project_key = ?'),
    addUsage: db.prepare(
      `INSERT INTO sandbox_usage (user_id, day, seconds) VALUES (?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`,
    ),
    usageSince: db.prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM sandbox_usage WHERE user_id = ? AND day >= ?'),
  };

  /** sessionToken -> session */
  const sessions = new Map();
  /** `${userId}:${projectKey}` -> session (one live session per project) */
  const byProject = new Map();

  function toAbs(session, clientPath) {
    // Accept '/home/project/x', 'home/project/x', './x' and 'x' alike.
    let rel = path.posix.normalize('/' + String(clientPath || '.'));
    const wd = CLIENT_WORKDIR;

    if (rel === wd || rel.startsWith(wd + '/')) {
      rel = rel.slice(wd.length);
    }

    const norm = path.posix.normalize('/' + rel).replace(/^\/+/, '').replace(/\/+$/, '');

    if (norm.split('/').includes('..')) {
      throw Object.assign(new Error('Path outside project'), { status: 400 });
    }

    return norm ? `${session.handle.root}/${norm}` : session.handle.root;
  }

  const toClient = (session, abs) => CLIENT_WORKDIR + abs.slice(session.handle.root.length);

  function emit(session, event) {
    if (session.clients.size === 0) {
      session.backlog.push(event);

      if (session.backlog.length > BACKLOG) {
        session.backlog.splice(0, session.backlog.length - BACKLOG);
      }

      return;
    }

    for (const send of session.clients) {
      send(event);
    }
  }

  // ---------- file watching (WebContainer PathWatcherEvent compatible) ----------
  async function startWatching(session) {
    const pending = new Map();
    let timer = null;

    const flush = async () => {
      timer = null;
      const batch = [...pending.entries()];
      pending.clear();
      const events = [];

      for (const [abs, kind] of batch) {
        const clientPath = toClient(session, abs);

        if (kind === 'remove') {
          const wasDir = session.knownDirs.has(abs);
          session.knownDirs.delete(abs);
          events.push({ type: wasDir ? 'remove_dir' : 'remove_file', path: clientPath });
          continue;
        }

        const st = await session.handle.stat(abs);

        if (!st) {
          events.push({ type: session.knownDirs.delete(abs) ? 'remove_dir' : 'remove_file', path: clientPath });
        } else if (st.type === 'dir') {
          if (!session.knownDirs.has(abs)) {
            session.knownDirs.add(abs);
            events.push({ type: 'add_dir', path: clientPath });
          }
        } else {
          let content;

          if (st.size <= MAX_INLINE_FILE) {
            try {
              content = (await session.handle.readFile(abs)).toString('base64');
            } catch {
              /* vanished between events */
            }
          }

          events.push({ type: kind === 'create' ? 'add_file' : 'change', path: clientPath, content });
        }
      }

      if (events.length) {
        emit(session, { t: 'fs', events });
      }
    };

    session.stopWatch = await session.handle.watch(session.handle.root, (ev) => {
      const rel = ev.path.slice(session.handle.root.length);

      if (IGNORE.test(rel) || /package-lock\.json$/.test(rel)) {
        return;
      }

      const kind = ev.type === 'remove' ? 'remove' : ev.type === 'create' || ev.type === 'rename' ? 'create' : 'write';
      const prev = pending.get(ev.path);
      pending.set(ev.path, prev === 'create' && kind === 'write' ? 'create' : kind);
      timer ??= setTimeout(flush, 120);
    });
  }

  // ---------- dev-server port detection ----------
  async function startPortPolling(session) {
    // The local provider shares the host's network, so ignore ports that were open before the session.
    const baseline = provider.sharedNetwork ? new Set(await session.handle.listPorts().catch(() => [])) : new Set();

    const tick = async () => {
      if (session.closed) return;

      try {
        const ports = new Set(await session.handle.listPorts());

        for (const p of baseline) {
          ports.delete(p);
        }

        for (const port of ports) {
          if (!session.ports.has(port)) {
            const url = session.handle.previewUrl(port);
            session.ports.set(port, url);
            emit(session, { t: 'port', port, type: 'open', url });
          }
        }

        for (const [port, url] of session.ports) {
          if (!ports.has(port)) {
            session.ports.delete(port);
            emit(session, { t: 'port', port, type: 'close', url });
          }
        }
      } catch {
        /* sandbox busy or resuming */
      }

      if (!session.closed) {
        session.portTimer = setTimeout(tick, config.sandboxPortPollMs);
      }
    };

    session.portTimer = setTimeout(tick, 500);
  }

  // ---------- idle handling + usage metering ----------
  function meter(session) {
    const t = now();

    if (session.clients.size > 0) {
      const secs = Math.round((t - session.lastMeter) / 1000);

      if (secs > 0) {
        q.addUsage.run(session.userId, new Date(t).toISOString().slice(0, 10), secs);
      }
    }

    session.lastMeter = t;
  }

  function scheduleIdleClose(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => close(session), config.sandboxIdleMs);
  }

  async function close(session) {
    if (session.closed) return;
    session.closed = true;
    meter(session);
    clearTimeout(session.portTimer);
    clearInterval(session.keepAliveTimer);
    clearTimeout(session.idleTimer);

    try {
      session.stopWatch?.();
    } catch {
      /* ignore */
    }

    session.handle.closeAll?.();

    // Wake any open event streams so they end promptly.
    for (const send of session.clients) {
      send({ t: 'closed' });
    }

    sessions.delete(session.token);
    byProject.delete(session.projectId);
  }

  // ---------- public API ----------
  return {
    providerName: provider.name,

    /** Start or resume the sandbox for a project and return a session token. */
    async open(userId, projectKey) {
      const key = String(projectKey || '').slice(0, 120);

      if (!/^[\w.:-]{1,120}$/.test(key)) {
        throw Object.assign(new Error('Invalid project id'), { status: 400 });
      }

      const projectId = `${userId}:${key}`;
      const live = byProject.get(projectId);

      if (live && !live.closed) {
        return { token: live.token, workdir: CLIENT_WORKDIR, resumed: true, ports: [...live.ports].map(([port, url]) => ({ port, url })) };
      }

      if (config.sandboxMonthlySeconds > 0) {
        const monthStart = new Date().toISOString().slice(0, 8) + '01';

        if (q.usageSince.get(userId, monthStart).s >= config.sandboxMonthlySeconds) {
          throw Object.assign(new Error('You have used all your sandbox time for this month.'), { status: 402 });
        }
      }

      const row = q.get.get(userId, key, provider.name);
      let handle = null;

      if (row) {
        try {
          handle = await provider.connect(row.sandbox_id);
        } catch {
          q.remove.run(userId, key);
        }
      }

      if (!handle) {
        handle = await provider.create({ userId, projectKey: key });
      }

      q.upsert.run(userId, key, provider.name, handle.id, now(), now());

      const session = {
        token: crypto.randomBytes(24).toString('base64url'),
        userId,
        projectId,
        projectKey: key,
        handle,
        clients: new Set(),
        backlog: [],
        procs: new Map(),
        ports: new Map(),
        knownDirs: new Set(),
        lastMeter: now(),
        closed: false,
      };

      sessions.set(session.token, session);
      byProject.set(projectId, session);

      await startWatching(session);
      await startPortPolling(session);
      session.keepAliveTimer = setInterval(() => {
        if (session.clients.size > 0) {
          meter(session);
          session.handle.keepAlive().catch(() => {});
          q.touch.run(now(), userId, key);
        }
      }, 60_000);
      scheduleIdleClose(session);

      return { token: session.token, workdir: CLIENT_WORKDIR, resumed: Boolean(row), ports: [] };
    },

    get(token, userId) {
      const s = sessions.get(token);
      return s && !s.closed && s.userId === userId ? s : null;
    },

    /** Attach an event listener (one browser tab). Returns a detach function. */
    attach(session, send) {
      session.lastMeter = session.clients.size === 0 ? now() : session.lastMeter;
      session.clients.add(send);
      clearTimeout(session.idleTimer);

      for (const ev of session.backlog.splice(0)) {
        send(ev);
      }

      for (const [port, url] of session.ports) {
        send({ t: 'port', port, type: 'open', url });
      }

      session.handle.keepAlive().catch(() => {});

      return () => {
        meter(session);
        session.clients.delete(send);

        if (session.clients.size === 0) {
          scheduleIdleClose(session);
        }
      };
    },

    async fs(session, { op, path: p, data, encoding, recursive, withFileTypes }) {
      const abs = toAbs(session, p);
      const h = session.handle;

      switch (op) {
        case 'readFile': {
          const buf = await h.readFile(abs);
          return encoding ? { text: buf.toString('utf8') } : { data: buf.toString('base64') };
        }
        case 'writeFile': {
          const buf = typeof data === 'string' ? Buffer.from(data, encoding ? 'utf8' : 'base64') : Buffer.alloc(0);
          await h.mkdir(path.posix.dirname(abs));
          await h.writeFile(abs, buf);
          return { ok: true };
        }
        case 'readdir': {
          const entries = await h.list(abs);
          return { entries: withFileTypes ? entries : entries.map((e) => e.name) };
        }
        case 'mkdir':
          await h.mkdir(abs);
          session.knownDirs.add(abs);
          return { ok: true };
        case 'rm': {
          const st = await h.stat(abs);

          if (!st) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${p}'`), { status: 404 });
          }

          if (st.type === 'dir' && !recursive) {
            const entries = await h.list(abs);

            if (entries.length) {
              throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rm '${p}'`), { status: 400 });
            }
          }

          await h.remove(abs);
          return { ok: true };
        }
        case 'stat': {
          return { stat: await h.stat(abs) };
        }
        default:
          throw Object.assign(new Error(`Unknown fs op ${op}`), { status: 400 });
      }
    },

    /**
     * Start a process. `/bin/jsh --osc` (WebContainer's interactive shell) becomes an
     * interactive bash PTY that emits the same OSC markers; everything else runs via bash -lc.
     */
    async spawn(session, { command, args = [], terminal }) {
      const cmd = String(command || '');
      const argv = Array.isArray(args) ? args.map(String) : [];
      const isShell = /(^|\/)(jsh|bash|sh|zsh)$/.test(cmd);
      const interactive = isShell && (argv.includes('--osc') || argv.length === 0);
      const h = session.handle;
      let pid;
      const decoder = new StringDecoder('utf8');

      // Output can arrive before the provider has told us the pid; hold it until then.
      const early = [];
      let earlyExit = null;

      const onData = (chunk) => {
        const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);

        if (!text) return;

        if (pid === undefined) {
          early.push(text);
        } else {
          const proc = session.procs.get(pid);

          if (proc) {
            proc.outputCount++;
          }

          emit(session, { t: 'out', pid, d: text });
        }
      };
      const onExit = (code) => {
        if (pid === undefined) {
          earlyExit = code;
          return;
        }

        session.procs.delete(pid);
        emit(session, { t: 'exit', pid, code });
      };
      const flushEarly = () => {
        if (early.length) emit(session, { t: 'out', pid, d: early.splice(0).join('') });
        if (earlyExit !== null) onExit(earlyExit);
      };

      if (interactive) {
        ({ pid } = await h.startPty({
          cols: Math.max(20, Math.min(500, Number(terminal?.cols) || 80)),
          rows: Math.max(5, Math.min(200, Number(terminal?.rows) || 24)),
          onData,
          onExit,
        }));
      } else {
        const line = isShell && argv[0] === '-c' ? argv.slice(1).join(' ') : [cmd, ...argv].map(h.shellQuote).join(' ');
        ({ pid } = await h.startCommand({ cmd: line, onData, onExit }));
      }

      session.procs.set(pid, { interactive, outputCount: early.length });
      flushEarly();

      return { pid };
    },

    async input(session, pid, data) {
      if (!session.procs.has(pid)) {
        throw Object.assign(new Error('Process has exited'), { status: 410 });
      }

      const text = String(data);
      const cut = text.lastIndexOf('\x03');

      // bash's line editor discards whatever it already read when Ctrl+C arrives, so let
      // the interrupt land before sending the command that follows it.
      if (cut >= 0 && cut < text.length - 1) {
        const proc = session.procs.get(pid);
        const before = proc.outputCount;
        await session.handle.sendInput(pid, text.slice(0, cut + 1));

        // Wait until the shell has reacted to the interrupt (echoed ^C / redrawn its prompt).
        for (let waited = 0; waited < 600 && proc.outputCount === before; waited += 20) {
          await new Promise((r) => setTimeout(r, 20));
        }

        await new Promise((r) => setTimeout(r, 60));
        await session.handle.sendInput(pid, text.slice(cut + 1));
      } else {
        await session.handle.sendInput(pid, text);
      }
    },

    async resize(session, pid, cols, rows) {
      if (session.procs.has(pid)) {
        await session.handle.resize(pid, Math.max(20, Number(cols) || 80), Math.max(5, Number(rows) || 24));
      }
    },

    async kill(session, pid) {
      if (session.procs.has(pid)) {
        await session.handle.kill(pid);
      }
    },

    usageThisMonth(userId) {
      return q.usageSince.get(userId, new Date().toISOString().slice(0, 8) + '01').s;
    },

    async shutdown() {
      await Promise.all([...sessions.values()].map((s) => close(s)));
    },
  };
}
