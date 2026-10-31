/**
 * Files installed into every sandbox.
 *
 * rc.sh makes bash emit the same OSC 654 markers as WebContainer's `jsh --osc`
 * (interactive / prompt / exit=<code>), so the builder's terminal and the AI's
 * command runner work unchanged.
 *
 * listen-all.cjs is preloaded into every Node process: dev servers that bind to
 * localhost are moved to 0.0.0.0 so the sandbox's public preview URL can reach them.
 */
export function rcScript({ root, extraAllowedHosts = '' }) {
  return `# Makelo sandbox shell setup
export PS1='\\[\\e[1;35m\\]~/project\\[\\e[0m\\] \\[\\e[1;36m\\]❯\\[\\e[0m\\] '
__cma_first=1
__cma_prompt() {
  local c=$?
  if [ -n "$__cma_first" ]; then
    unset __cma_first
    printf '\\033]654;interactive\\007'
  else
    printf '\\033]654;exit=%s:%s\\007' "$c" "$c"
  fi
  printf '\\033]654;prompt\\007'
}
PROMPT_COMMAND=__cma_prompt
# Keep typed-ahead input when Ctrl+C is pressed (the builder sends Ctrl+C right before each command).
stty noflsh 2>/dev/null || true
${envExports({ root, extraAllowedHosts })}
cd "${root}" 2>/dev/null || true
`;
}

export function sandboxEnv({ root, extraAllowedHosts = '' }) {
  const cmaDir = `${root}/../.cma`;

  return {
    NODE_OPTIONS: `--require ${cmaDir}/listen-all.cjs`,
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ['.e2b.app', '.e2b.dev', extraAllowedHosts].filter(Boolean).join(','),
    BROWSER: 'none',
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
  };
}

function envExports(opts) {
  return Object.entries(sandboxEnv(opts))
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
}

export const LISTEN_ALL = `// Makelo: expose dev servers bound to localhost on all interfaces.
const net = require('net');
const LOOPBACK = /^(localhost|127\\.0\\.0\\.1|::1|\\[::1\\])$/i;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  try {
    const first = args[0];
    if (first && typeof first === 'object' && !Array.isArray(first) && first.port !== undefined) {
      if (typeof first.host === 'string' && LOOPBACK.test(first.host)) args[0] = { ...first, host: '0.0.0.0' };
    } else if (typeof args[1] === 'string' && LOOPBACK.test(args[1])) {
      args[1] = '0.0.0.0';
    }
  } catch {}
  return listen.apply(this, args);
};
`;

/** Shell-quote one argument. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Parse /proc/net/tcp{,6} and return listening ports. */
export function parseListeningPorts(text) {
  const ports = new Set();

  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);

    // sl local_address rem_address st ...
    if (cols.length > 3 && cols[3] === '0A') {
      const port = parseInt(cols[1].split(':').pop(), 16);

      if (port >= 1024 && port < 49000) {
        ports.add(port);
      }
    }
  }

  return [...ports].sort((a, b) => a - b);
}
