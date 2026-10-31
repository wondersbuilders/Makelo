/**
 * RemoteContainer — a drop-in stand-in for StackBlitz's WebContainer that runs the
 * user's project in a ClickMyApp cloud sandbox (e2b.dev microVM) instead of the browser.
 *
 * It implements the part of the WebContainer API the builder uses:
 *   workdir, fs.{readFile,writeFile,readdir,mkdir,rm}, spawn(), on('port'|'server-ready'|...),
 *   internal.watchPaths(), setPreviewScript()
 */
import { PLATFORM_URL, platformFetch } from '~/lib/clickmyapp/platform';

type Listener = (...args: any[]) => void;

export interface RemoteProcess {
  output: ReadableStream<string>;
  input: WritableStream<string>;
  exit: Promise<number>;
  kill(): void;
  resize(size: { cols: number; rows: number }): void;
}

interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

type SandboxEvent =
  | { t: 'out'; pid: number; d: string }
  | { t: 'exit'; pid: number; code: number }
  | { t: 'port'; port: number; type: 'open' | 'close'; url: string }
  | { t: 'fs'; events: { type: string; path: string; content?: string }[] }
  | { t: 'closed' };

const TOKEN_KEY = 'clickmyapp-access-token';

function authHeaders(): Record<string, string> {
  try {
    const token = PLATFORM_URL ? localStorage.getItem(TOKEN_KEY) : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(s);
}

function fsError(message: string, code?: string) {
  return Object.assign(new Error(message), { code: code || (/ENOENT/.test(message) ? 'ENOENT' : undefined) });
}

/** Project key: the chat being opened, or a per-tab key for a brand-new chat. */
export function projectKeyFromLocation(): string {
  const match = window.location.pathname.match(/\/chat\/([\w.:-]+)/);

  if (match) {
    return `chat-${match[1]}`;
  }

  try {
    let tab = sessionStorage.getItem('clickmyapp-tab');

    if (!tab) {
      tab = `new-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('clickmyapp-tab', tab);
    }

    return tab;
  } catch {
    return `new-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class RemoteContainer {
  readonly workdir: string;
  #token: string;
  #listeners = new Map<string, Set<Listener>>();
  #watchers = new Set<(events: any[]) => void>();
  #procs = new Map<number, { push(text: string): void; exited(code: number): void }>();
  #pending = new Map<number, SandboxEvent[]>();
  #closed = false;

  private constructor(token: string, workdir: string) {
    this.#token = token;
    this.workdir = workdir;
  }

  static async boot(projectKey: string): Promise<RemoteContainer> {
    const { token, workdir } = await platformFetch<{ token: string; workdir: string }>('/api/platform/sandbox', {
      method: 'POST',
      body: JSON.stringify({ project: projectKey }),
    });

    const container = new RemoteContainer(token, workdir);
    await container.#listen();

    return container;
  }

  // ---------- transport ----------
  #post<T = any>(action: string, body: unknown): Promise<T> {
    return platformFetch<T>(`/api/platform/sandbox/${this.#token}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Server-sent events over fetch (works with cookies on the web and tokens on desktop). */
  async #listen() {
    let ready: () => void;

    const firstConnect = new Promise<void>((r) => (ready = r));

    const connect = async (attempt = 0): Promise<void> => {
      try {
        const res = await fetch(`${PLATFORM_URL}/api/platform/sandbox/${this.#token}/events`, {
          headers: { Accept: 'text/event-stream', ...authHeaders() },
          credentials: PLATFORM_URL ? 'omit' : 'same-origin',
        });

        if (res.status === 410) {
          this.#emit('error', { message: 'Your cloud sandbox session expired. Reload the page to reconnect.' });
          ready();

          return;
        }

        if (!res.ok || !res.body) {
          throw new Error(`events ${res.status}`);
        }

        ready();
        attempt = 0;

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

        let buf = '';

        while (!this.#closed) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          buf += value;

          let idx;

          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);

            if (/^event: batch$/m.test(block)) {
              const data = block
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('\n');

              for (const ev of JSON.parse(data) as SandboxEvent[]) {
                this.#dispatch(ev);
              }
            }
          }
        }
      } catch {
        /* network blip — reconnect below */
      }

      if (!this.#closed) {
        setTimeout(() => connect(attempt + 1), Math.min(10_000, 500 * 2 ** attempt));
      }
    };

    connect();
    await firstConnect;
  }

  #dispatch(ev: SandboxEvent) {
    switch (ev.t) {
      case 'out':
      case 'exit': {
        const proc = this.#procs.get(ev.pid);

        if (!proc) {
          // Output can beat the spawn() response; hold it until the process is registered.
          const list = this.#pending.get(ev.pid) ?? [];
          list.push(ev);
          this.#pending.set(ev.pid, list);

          return;
        }

        if (ev.t === 'out') {
          proc.push(ev.d);
        } else {
          proc.exited(ev.code);
        }

        return;
      }
      case 'port':
        this.#emit('port', ev.port, ev.type, ev.url);

        if (ev.type === 'open') {
          this.#emit('server-ready', ev.port, ev.url);
        }

        return;
      case 'fs': {
        const events = ev.events.map((e) => ({
          type: e.type,
          path: e.path,
          buffer: e.content !== undefined ? base64ToBytes(e.content) : undefined,
        }));

        for (const cb of this.#watchers) {
          cb(events);
        }

        return;
      }
      case 'closed':
        this.#emit('error', { message: 'Your cloud sandbox went to sleep. Reload the page to wake it.' });
    }
  }

  #emit(event: string, ...args: unknown[]) {
    for (const cb of this.#listeners.get(event) ?? []) {
      try {
        cb(...args);
      } catch (err) {
        console.error('[sandbox] listener failed', err);
      }
    }
  }

  // ---------- WebContainer-compatible API ----------
  on(event: string, listener: Listener): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);

    return () => set.delete(listener);
  }

  async setPreviewScript(_script: string): Promise<void> {
    // Previews run on their own domain; the inspector script is not injected in cloud sandboxes.
  }

  internal = {
    watchPaths: (_options: unknown, callback: (events: any[]) => void) => {
      this.#watchers.add(callback);
      return () => this.#watchers.delete(callback);
    },
  };

  fs = {
    readFile: async (path: string, encoding?: string | null): Promise<any> => {
      try {
        const r = await this.#post<{ text?: string; data?: string }>('fs', {
          op: 'readFile',
          path,
          encoding: encoding || undefined,
        });
        return encoding ? r.text : base64ToBytes(r.data || '');
      } catch (err: any) {
        throw fsError(err.message);
      }
    },

    writeFile: async (path: string, data: string | Uint8Array, _options?: unknown): Promise<void> => {
      const body =
        typeof data === 'string'
          ? { op: 'writeFile', path, data, encoding: 'utf-8' }
          : { op: 'writeFile', path, data: bytesToBase64(data) };

      try {
        await this.#post('fs', body);
      } catch (err: any) {
        throw fsError(err.message);
      }
    },

    readdir: async (path: string, options?: { withFileTypes?: boolean; encoding?: string }): Promise<any> => {
      try {
        const r = await this.#post<{ entries: any[] }>('fs', {
          op: 'readdir',
          path,
          withFileTypes: Boolean(options?.withFileTypes),
        });

        if (!options?.withFileTypes) {
          return r.entries as string[];
        }

        return (r.entries as { name: string; type: string }[]).map<Dirent>((e) => ({
          name: e.name,
          isFile: () => e.type === 'file',
          isDirectory: () => e.type === 'dir',
        }));
      } catch (err: any) {
        throw fsError(err.message);
      }
    },

    mkdir: async (path: string, _options?: { recursive?: boolean }): Promise<any> => {
      await this.#post('fs', { op: 'mkdir', path });
      return undefined;
    },

    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> => {
      try {
        await this.#post('fs', { op: 'rm', path, recursive: Boolean(options?.recursive) });
      } catch (err: any) {
        if (options?.force && /ENOENT/.test(err.message)) {
          return;
        }

        throw fsError(err.message);
      }
    },
  };

  async spawn(command: string, args: string[] | object = [], options?: { terminal?: { cols: number; rows: number } }) {
    const argv = Array.isArray(args) ? args : [];
    const opts = (Array.isArray(args) ? options : (args as typeof options)) ?? {};

    let controller!: ReadableStreamDefaultController<string>;
    let resolveExit!: (code: number) => void;

    const exit = new Promise<number>((r) => (resolveExit = r));
    const output = new ReadableStream<string>({ start: (c) => (controller = c) });

    const { pid } = await this.#post<{ pid: number }>('spawn', { command, args: argv, terminal: opts.terminal });

    let done = false;
    this.#procs.set(pid, {
      push: (text) => {
        if (!done) {
          controller.enqueue(text);
        }
      },
      exited: (code) => {
        if (done) {
          return;
        }

        done = true;
        this.#procs.delete(pid);

        try {
          controller.close();
        } catch {
          /* already closed */
        }

        resolveExit(code);
      },
    });

    for (const ev of this.#pending.get(pid) ?? []) {
      this.#dispatch(ev);
    }

    this.#pending.delete(pid);

    // Keystrokes are sent in order, batched while a request is in flight.
    let queue = '';
    let sending: Promise<void> | null = null;

    const flush = async () => {
      while (queue) {
        const data = queue;
        queue = '';
        await this.#post('input', { pid, data }).catch(() => undefined);
      }

      sending = null;
    };

    const input = new WritableStream<string>({
      write: (chunk) => {
        queue += chunk;
        sending ??= flush();
      },
    });

    const proc: RemoteProcess = {
      output,
      input,
      exit,
      kill: () => {
        this.#post('kill', { pid }).catch(() => undefined);
      },
      resize: ({ cols, rows }) => {
        this.#post('resize', { pid, cols, rows }).catch(() => undefined);
      },
    };

    return proc;
  }
}
