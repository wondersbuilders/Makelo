import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LISTEN_ALL, parseListeningPorts, rcScript, sandboxEnv, shq } from './rc.js';

/**
 * Local provider — runs projects in folders on this machine with no isolation.
 * FOR DEVELOPMENT AND TESTS ONLY. Never enable it on a server that strangers can sign up to.
 */
export function createLocalProvider(config) {
  const base = path.join(config.dataDir, 'sandboxes');
  fs.mkdirSync(base, { recursive: true });

  function wrap(id) {
    const dir = path.join(base, id);
    const root = path.join(dir, 'project');
    const procs = new Map();
    const env = { ...process.env, ...sandboxEnv({ root }), HOME: dir };

    const track = (child, onData, onExit) => {
      child.stdout.on('data', (d) => onData(d));
      child.stderr?.on('data', (d) => onData(d));
      child.on('exit', (code, signal) => {
        procs.delete(child.pid);
        onExit(code ?? (signal ? 130 : 1));
      });
      child.on('error', () => onExit(127));
      procs.set(child.pid, child);

      return { pid: child.pid };
    };

    return {
      id,
      root,
      readFile: (abs) => fsp.readFile(abs),
      writeFile: (abs, buf) => fsp.writeFile(abs, buf),
      list: async (abs) =>
        (await fsp.readdir(abs, { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })),
      mkdir: (abs) => fsp.mkdir(abs, { recursive: true }),
      remove: (abs) => fsp.rm(abs, { recursive: true, force: true }),
      stat: async (abs) => {
        try {
          const s = await fsp.stat(abs);
          return { type: s.isDirectory() ? 'dir' : 'file', size: s.size };
        } catch {
          return null;
        }
      },

      // `script` gives bash a real terminal without native modules.
      startPty: async ({ onData, onExit }) =>
        track(
          spawn('script', ['-qfec', `bash --rcfile ${shq(path.join(dir, '.cma', 'rc.sh'))} -i`, '/dev/null'], { cwd: root, env }),
          (d) => onData(Buffer.from(d)),
          onExit,
        ),

      startCommand: async ({ cmd, onData, onExit }) =>
        track(spawn('bash', ['-lc', cmd], { cwd: root, env, detached: true }), (d) => onData(d.toString()), onExit),

      sendInput: async (pid, data) => {
        procs.get(pid)?.stdin.write(data);
      },
      resize: async () => {},
      kill: async (pid) => {
        const child = procs.get(pid);

        if (child) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
      },

      watch: async (abs, onEvent) => {
        const watcher = fs.watch(abs, { recursive: true }, async (_kind, name) => {
          if (!name) return;
          const full = path.join(abs, name);
          const exists = fs.existsSync(full);
          onEvent({ type: exists ? (_kind === 'rename' ? 'create' : 'write') : 'remove', path: full });
        });

        return () => watcher.close();
      },

      listPorts: async () => {
        const text = ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')).join('\n');
        return parseListeningPorts(text);
      },

      previewUrl: (port) => `http://127.0.0.1:${port}`,
      keepAlive: async () => {},
      shellQuote: shq,
      closeAll: () => {
        for (const pid of procs.keys()) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            procs.get(pid)?.kill('SIGTERM');
          }
        }
      },
    };
  }

  return {
    name: 'local',
    sharedNetwork: true,

    async create() {
      const id = `local-${crypto.randomBytes(6).toString('hex')}`;
      const dir = path.join(base, id);
      await fsp.mkdir(path.join(dir, 'project'), { recursive: true });
      await fsp.mkdir(path.join(dir, '.cma'), { recursive: true });
      await fsp.writeFile(path.join(dir, '.cma', 'listen-all.cjs'), LISTEN_ALL);
      await fsp.writeFile(path.join(dir, '.cma', 'rc.sh'), rcScript({ root: path.join(dir, 'project') }));

      return wrap(id);
    },

    async connect(id) {
      if (!/^local-[0-9a-f]{12}$/.test(id) || !fs.existsSync(path.join(base, id))) {
        throw new Error('Sandbox not found');
      }

      return wrap(id);
    },

    async destroy(id) {
      if (/^local-[0-9a-f]{12}$/.test(id)) {
        await fsp.rm(path.join(base, id), { recursive: true, force: true });
      }
    },
  };
}
