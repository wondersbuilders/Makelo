import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { parseListeningPorts } from '../src/sandbox/rc.js';
import { createApp } from '../src/server.js';

const APP = 'app.clickmyapp.test';
const apps = [];

after(async () => {
  for (const a of apps) await a.sandboxes?.shutdown();
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-sbx-'));
  const config = loadConfig({
    APP_HOST: APP,
    SITES_DOMAIN: 'clickmyapp.test',
    DATA_DIR: dataDir,
    SECURE_COOKIES: 'false',
    PUBLIC_SCHEME: 'http',
    SANDBOX_PROVIDER: 'local',
    SANDBOX_PORT_POLL_MS: '300',
  });
  const ctx = createApp(config);
  apps.push(ctx);

  const req = (url, { method = 'GET', cookie, body } = {}) => {
    const headers = { host: APP };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method === 'POST') headers.origin = `http://${APP}`;
    return ctx.app.request(`http://${APP}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };

  async function signup(email) {
    const res = await ctx.app.request(`http://${APP}/account/signup`, {
      method: 'POST',
      headers: { host: APP, origin: `http://${APP}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: 'supersecret1' }).toString(),
    });
    return res.headers.get('set-cookie').split(';')[0];
  }

  /** Open the SSE stream and collect events. */
  async function events(token, cookie) {
    const res = await req(`/api/platform/sandbox/${token}/events`, { cookie });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const got = [];
    let buf = '';
    let stopped = false;
    (async () => {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\w+)/.exec(block)?.[1];
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (ev === 'batch') got.push(...JSON.parse(data));
        }
      }
    })();
    const waitFor = async (pred, ms = 15000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const hit = got.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      const shell = got.filter((e) => e.t === 'out').map((e) => e.d).join('');
      throw new Error('timed out; shell tail: ' + JSON.stringify(shell.slice(-700)) + ' last events: ' + JSON.stringify(got.slice(-3)).slice(0, 300));
    };
    const output = (pid) => got.filter((e) => e.t === 'out' && e.pid === pid).map((e) => e.d).join('');
    return { got, waitFor, output, stop: () => { stopped = true; reader.cancel().catch(() => {}); } };
  }

  return { ctx, req, signup, events, config };
}

test('parses listening ports from /proc/net/tcp', () => {
  const sample = `  sl  local_address rem_address   st
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000
   1: 0100007F:14EB 00000000:0000 0A 00000000:00000000
   2: 0100007F:C350 00000000:0000 0A 00000000:00000000
   3: 0100007F:0016 00000000:0000 0A 00000000:00000000
   4: 0100007F:1F91 0100007F:9999 01 00000000:00000000`;
  assert.deepEqual(parseListeningPorts(sample), [5355, 8080]);
});

test('sandbox: files, shell with OSC markers, commands, ports and file watching', async () => {
  const { req, signup, events } = setup();
  const cookie = await signup('builder@example.com');

  const cfg = await (await req('/api/platform/sandbox/config', { cookie })).json();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.provider, 'local');

  const open = await req('/api/platform/sandbox', { method: 'POST', cookie, body: { project: 'chat-42' } });
  assert.equal(open.status, 200);
  const { token, workdir } = await open.json();
  assert.equal(workdir, '/home/project');

  const ev = await events(token, cookie);
  const fsop = async (body) => (await req(`/api/platform/sandbox/${token}/fs`, { method: 'POST', cookie, body })).json();

  // Files
  await fsop({ op: 'writeFile', path: '/home/project/src/hello.txt', data: 'hi there', encoding: 'utf-8' });
  assert.equal((await fsop({ op: 'readFile', path: 'src/hello.txt', encoding: 'utf-8' })).text, 'hi there');
  const bin = Buffer.from([0, 255, 1, 128]);
  await fsop({ op: 'writeFile', path: 'img.bin', data: bin.toString('base64') });
  assert.deepEqual(Buffer.from((await fsop({ op: 'readFile', path: 'img.bin' })).data, 'base64'), bin);
  await fsop({ op: 'mkdir', path: 'home/project' });
  await fsop({ op: 'mkdir', path: '/home/project/' });
  const listing = await fsop({ op: 'readdir', path: '.', withFileTypes: true });
  assert.deepEqual(listing.entries.map((e) => `${e.name}:${e.type}`).sort(), ['img.bin:file', 'src:dir']);

  // Path traversal stays inside the project folder
  const escape = await req(`/api/platform/sandbox/${token}/fs`, { method: 'POST', cookie, body: { op: 'readFile', path: '../../../../etc/passwd', encoding: 'utf-8' } });
  assert.equal(escape.status, 404);
  assert.doesNotMatch(await escape.text(), /root:/);

  // Watcher reports file changes made by commands, with content
  await ev.waitFor(() => true, 2000).catch(() => {});

  // Interactive shell speaks the WebContainer OSC protocol
  const { pid } = await (await req(`/api/platform/sandbox/${token}/spawn`, { method: 'POST', cookie, body: { command: '/bin/jsh', args: ['--osc'], terminal: { cols: 100, rows: 30 } } })).json();
  await ev.waitFor(() => ev.output(pid).includes('\x1b]654;interactive\x07'));
  await ev.waitFor(() => ev.output(pid).includes('\x1b]654;prompt\x07'));

  const send = (data) => req(`/api/platform/sandbox/${token}/input`, { method: 'POST', cookie, body: { pid, data } });
  await send('echo made-by-ai > generated.txt && false\n');
  await ev.waitFor(() => /\x1b\]654;exit=1:1\x07/.test(ev.output(pid)));

  // Ctrl+C immediately followed by a command must not lose characters
  await send('\x03echo first-char-ok\n');
  await ev.waitFor(() => /first-char-ok\r?\n/.test(ev.output(pid).replace(/echo first-char-ok/g, '')));
  assert.doesNotMatch(ev.output(pid), /cho: command not found/);

  const fsEvent = await ev.waitFor((e) => e.t === 'fs' && e.events.some((x) => x.path === '/home/project/generated.txt'));
  const gen = fsEvent.events.find((x) => x.path === '/home/project/generated.txt');
  assert.ok(['add_file', 'change'].includes(gen.type));
  assert.equal(Buffer.from(gen.content, 'base64').toString(), 'made-by-ai\n');

  // A dev server bound to localhost is detected and moved to all interfaces
  const PORT = 40000 + Math.floor(Math.random() * 8000);
  const HEX = PORT.toString(16).toUpperCase().padStart(4, '0');
  await fsop({
    op: 'writeFile',
    path: 'server.js',
    encoding: 'utf-8',
    data: `require('http').createServer((q,s)=>s.end('preview-ok')).listen(${PORT},'localhost',()=>console.log('listening'))`,
  });
  const srv = await (await req(`/api/platform/sandbox/${token}/spawn`, { method: 'POST', cookie, body: { command: 'node', args: ['server.js'] } })).json();
  await ev.waitFor(() => ev.output(srv.pid).includes('listening'));
  const port = await ev.waitFor((e) => e.t === 'port' && e.port === PORT && e.type === 'open');
  assert.equal(port.url, `http://127.0.0.1:${PORT}`);
  const tcp = fs.readFileSync('/proc/net/tcp', 'utf8');
  assert.match(tcp, new RegExp(`00000000:${HEX} 00000000:0000 0A`), 'server should listen on 0.0.0.0, not just localhost');
  assert.equal(await (await fetch(port.url)).text(), 'preview-ok');

  // Non-interactive command with exit code (like `npm run build`)
  const cmd = await (await req(`/api/platform/sandbox/${token}/spawn`, { method: 'POST', cookie, body: { command: 'bash', args: ['-c', 'echo building; exit 3'] } })).json();
  const exit = await ev.waitFor((e) => e.t === 'exit' && e.pid === cmd.pid);
  assert.equal(exit.code, 3);
  assert.match(ev.output(cmd.pid), /building/);

  // Killing the dev server closes the port
  await req(`/api/platform/sandbox/${token}/kill`, { method: 'POST', cookie, body: { pid: srv.pid } });
  await ev.waitFor((e) => e.t === 'port' && e.port === PORT && e.type === 'close');

  // Reopening the same project returns the same live session
  const again = await (await req('/api/platform/sandbox', { method: 'POST', cookie, body: { project: 'chat-42' } })).json();
  assert.equal(again.token, token);

  ev.stop();
});

test("sandbox sessions are private to their owner", async () => {
  const { req, signup } = setup();
  const a = await signup('a@example.com');
  const b = await signup('b@example.com');
  const { token } = await (await req('/api/platform/sandbox', { method: 'POST', cookie: a, body: { project: 'p1' } })).json();
  const steal = await req(`/api/platform/sandbox/${token}/fs`, { method: 'POST', cookie: b, body: { op: 'readdir', path: '.' } });
  assert.equal(steal.status, 410);
  const anon = await req('/api/platform/sandbox', { method: 'POST', body: { project: 'p1' } });
  assert.equal(anon.status, 401);
  const bad = await req('/api/platform/sandbox', { method: 'POST', cookie: a, body: { project: '../../x' } });
  assert.equal(bad.status, 400);
});

test('sandbox disabled by default', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-off-'));
  const ctx = createApp(loadConfig({ APP_HOST: APP, DATA_DIR: dataDir, SECURE_COOKIES: 'false' }));
  assert.equal(ctx.sandboxes, null);
});
