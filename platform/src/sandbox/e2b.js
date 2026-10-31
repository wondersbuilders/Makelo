import { Sandbox } from 'e2b';
import { LISTEN_ALL, parseListeningPorts, rcScript, sandboxEnv, shq } from './rc.js';

const HOME = '/home/user';
const ROOT = `${HOME}/project`;

/**
 * e2b.dev provider: one Firecracker microVM per project.
 * Sandboxes auto-pause when idle and auto-resume on the next request, so files
 * (including node_modules) survive between visits without paying for idle time.
 */
export function createE2bProvider(config) {
  const base = { apiKey: config.e2bApiKey };
  const idleMs = config.sandboxIdleMs;

  async function setup(sbx) {
    await sbx.files.makeDir(ROOT);
    await sbx.files.makeDir(`${HOME}/.cma`);
    await sbx.files.write(`${HOME}/.cma/listen-all.cjs`, LISTEN_ALL);
    await sbx.files.write(`${HOME}/.cma/rc.sh`, rcScript({ root: ROOT }));
    await sbx.commands.run(`grep -q '.cma/rc.sh' ${HOME}/.bashrc || echo '[ -f ~/.cma/rc.sh ] && . ~/.cma/rc.sh' >> ${HOME}/.bashrc`);
  }

  function wrap(sbx) {
    const ptys = new Set();
    const enc = new TextEncoder();
    const env = sandboxEnv({ root: ROOT });

    return {
      id: sbx.sandboxId,
      root: ROOT,

      readFile: async (abs) => Buffer.from(await sbx.files.read(abs, { format: 'bytes' })),
      writeFile: async (abs, buf) => {
        await sbx.files.write(abs, new Uint8Array(buf));
      },
      list: async (abs) => (await sbx.files.list(abs)).map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' : 'file' })),
      mkdir: async (abs) => {
        await sbx.files.makeDir(abs);
      },
      remove: async (abs) => {
        await sbx.files.remove(abs);
      },
      stat: async (abs) => {
        try {
          const info = await sbx.files.getInfo(abs);
          return { type: info.type === 'dir' ? 'dir' : 'file', size: info.size };
        } catch {
          return null;
        }
      },

      async startPty({ cols, rows, onData, onExit }) {
        const handle = await sbx.pty.create({ cols, rows, cwd: ROOT, envs: env, timeoutMs: 0, onData: (d) => onData(Buffer.from(d)) });
        ptys.add(handle.pid);
        handle.wait().then(
          (r) => onExit(r.exitCode ?? 0),
          (e) => onExit(typeof e?.exitCode === 'number' ? e.exitCode : 1),
        ).finally(() => ptys.delete(handle.pid));

        return { pid: handle.pid };
      },

      async startCommand({ cmd, onData, onExit }) {
        const handle = await sbx.commands.run(cmd, {
          background: true,
          cwd: ROOT,
          envs: env,
          stdin: true,
          timeoutMs: 0,
          onStdout: (d) => onData(d),
          onStderr: (d) => onData(d),
        });
        handle.wait().then(
          (r) => onExit(r.exitCode ?? 0),
          (e) => onExit(typeof e?.exitCode === 'number' ? e.exitCode : 1),
        );

        return { pid: handle.pid };
      },

      async sendInput(pid, data) {
        if (ptys.has(pid)) {
          await sbx.pty.sendInput(pid, enc.encode(data));
        } else {
          await sbx.commands.sendStdin(pid, data);
        }
      },
      async resize(pid, cols, rows) {
        if (ptys.has(pid)) {
          await sbx.pty.resize(pid, { cols, rows });
        }
      },
      async kill(pid) {
        await (ptys.has(pid) ? sbx.pty.kill(pid) : sbx.commands.kill(pid)).catch(() => {});
      },

      async watch(abs, onEvent) {
        const handle = await sbx.files.watchDir(
          abs,
          (ev) => onEvent({ type: ev.type, path: `${abs}/${ev.name}` }),
          { recursive: true, timeoutMs: 0 },
        );

        return () => handle.stop();
      },

      async listPorts() {
        const r = await sbx.commands.run('cat /proc/net/tcp /proc/net/tcp6 2>/dev/null', { timeoutMs: 10_000 });
        return parseListeningPorts(r.stdout);
      },

      previewUrl: (port) => `https://${sbx.getHost(port)}`,
      keepAlive: () => sbx.setTimeout(idleMs),
      shellQuote: shq,
    };
  }

  return {
    name: 'e2b',

    async create({ userId, projectKey }) {
      const opts = {
        ...base,
        timeoutMs: idleMs,
        metadata: { app: 'makelo', userId: String(userId), project: projectKey.slice(0, 64) },
        lifecycle: { onTimeout: 'pause', autoResume: true },
      };
      const sbx = config.e2bTemplate ? await Sandbox.create(config.e2bTemplate, opts) : await Sandbox.create(opts);
      await setup(sbx);

      return wrap(sbx);
    },

    async connect(id) {
      const sbx = await Sandbox.connect(id, { ...base, timeoutMs: idleMs });

      return wrap(sbx);
    },

    async destroy(id) {
      await Sandbox.kill(id, base).catch(() => {});
    },
  };
}
