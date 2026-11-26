/**
 * Sandbox runner.
 *
 * Runs inside its own container that holds no secrets, and executes shell
 * commands on behalf of the bot. The bot talks to it over a unix socket in a
 * shared volume; nothing else can reach it.
 *
 * Network: the container may reach the public internet, but a firewall set
 * up here at startup rejects every private and link-local address, so
 * commands cannot reach the host, other containers, the local network or the
 * cloud metadata service. If the firewall cannot be installed the runner
 * refuses to start.
 *
 * Every group has its own Linux user. A command for a group runs as that
 * user, in that group's workspace (/work/<group>), with a read-only view of
 * that group's record (/record/<group>). File permissions keep groups apart:
 * a workspace is mode 0700, and a record folder is readable only by the bot
 * and by the owning group's user.
 *
 * The runner itself starts as root with just enough capabilities to switch
 * user, hand folders over and set the firewall (SETUID, SETGID, CHOWN, KILL,
 * NET_ADMIN). Commands never run as root, hold no capabilities, and cannot
 * gain privileges back, so they cannot change the firewall.
 *
 * Protocol: one JSON object per connection, newline terminated, answered
 * with one JSON object.
 *   -> { group, uid, command, stdin?, env?, timeoutMs?, binary? }
 *   <- { ok, code, signal, timedOut, stdout, stderr, truncated, usageBytes } | { ok:false, error }
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const SOCKET_PATH = process.env.SANDBOX_SOCKET || '/run/sandbox/runner.sock';
const WORK_ROOT = process.env.SANDBOX_WORK_ROOT || '/work';
const RECORD_ROOT = process.env.SANDBOX_RECORD_ROOT || '/record';
const BOT_GID = Number(process.env.SANDBOX_BOT_GID || 1000);
const TZ = process.env.TZ || 'UTC';
// Optional GitHub token for the groups' own repositories. It is handed to commands on
// purpose, so everyone who can run commands here can use it: scope it accordingly.
const GITHUB_TOKEN = process.env.SANDBOX_GITHUB_TOKEN || '';

// Disk quota per group. The workspace lives on the host's disk, so it is watched while a
// command runs and the command is killed if it pushes the workspace over either limit.
const QUOTA_BYTES = Number(process.env.SANDBOX_QUOTA_MB || 1024) * 1024 * 1024;
const QUOTA_FILES = Number(process.env.SANDBOX_QUOTA_FILES || 200_000);
const QUOTA_POLL_MS = 500;
const QUOTA_SLACK_BYTES = 20 * 1024 * 1024;

const UID_MIN = 20000;

// Addresses that are never the public internet: private ranges (the host, other containers,
// the cloud network), link-local (the cloud metadata service), carrier NAT, multicast, reserved.
const BLOCKED_NETWORKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
// Outbound mail, so the sandbox cannot be used to send spam.
const BLOCKED_TCP_PORTS = '25,465,587';

function hasNetwork() {
  try {
    return fs.readdirSync('/sys/class/net').some((name) => name !== 'lo');
  } catch {
    return false;
  }
}

/** Install the egress firewall. Throws if any rule cannot be applied. */
function installFirewall() {
  const run = (tool, args) => execFileSync(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  run('iptables', ['-F', 'OUTPUT']);
  run('iptables', ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']); // includes Docker's DNS at 127.0.0.11
  for (const network of BLOCKED_NETWORKS) {
    run('iptables', ['-A', 'OUTPUT', '-d', network, '-j', 'REJECT']);
  }
  run('iptables', ['-A', 'OUTPUT', '-p', 'tcp', '-m', 'multiport', '--dports', BLOCKED_TCP_PORTS, '-j', 'REJECT']);

  // No IPv6 at all except loopback.
  run('ip6tables', ['-F', 'OUTPUT']);
  run('ip6tables', ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
  run('ip6tables', ['-A', 'OUTPUT', '-j', 'REJECT']);

  // Read the rules back: a firewall that silently did not apply is worse than none.
  const rules = execFileSync('iptables', ['-S', 'OUTPUT'], { encoding: 'utf8' });
  for (const network of BLOCKED_NETWORKS) {
    if (!rules.includes(`-d ${network} -j REJECT`)) throw new Error(`rule for ${network} is missing`);
  }
}
const UID_MAX = 29999;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TEXT_OUTPUT = 200_000;
const MAX_BINARY_OUTPUT = 48_000_000;
const MAX_REQUEST_BYTES = 30_000_000; // room for a 20 MB file, base64 encoded

// Per-process limits applied in the wrapper shell before the command starts.
// -f is in 1024-byte blocks: no single file larger than 200 MB.
const MAX_FILE_BLOCKS = 204800; // 200 MB, in the 1024-byte blocks `ulimit -f` counts

/**
 * Limits applied in the wrapper shell before the command starts.
 *
 * The first step marks the command (and everything it starts) as the first thing to go when
 * the container runs out of memory, so a runaway script is killed instead of the runner.
 *
 * The file size limit is the hard part of the disk quota: no file may grow beyond what the
 * group has left, and a workspace that is already over quota gets a limit of zero, which
 * still allows deleting but not writing. The watcher in execute() covers many-small-files.
 */
function limitsFor(startBytes) {
  const remainingBlocks = Math.max(0, Math.floor((QUOTA_BYTES - startBytes) / 1024));
  const fileBlocks = Math.min(MAX_FILE_BLOCKS, remainingBlocks);
  return (
    'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; ' +
    `ulimit -f ${fileBlocks}; ulimit -u 128; ulimit -n 512; ulimit -c 0; umask 077;`
  );
}

/** Kill everything a group's user still has running (background jobs, stragglers). */
function killUser(uid) {
  let killed = 0;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.statSync(`/proc/${entry}`).uid === uid) {
        process.kill(Number(entry), 'SIGKILL');
        killed++;
      }
    } catch {
      // process already gone
    }
  }
  return killed;
}

function prepareGroup(group, uid) {
  // Root here has no permission-override capability, so once a workspace belongs
  // to its group the runner itself can no longer look inside it. That is intended.
  const work = path.join(WORK_ROOT, group);
  if (!fs.existsSync(work)) {
    fs.mkdirSync(work, { mode: 0o700 });
    fs.chownSync(work, uid, uid);
  }

  // Let this group's user (and only it) read this group's record. The bot stays
  // the owner; the folder is created 0750 by the bot, so "other" users get nothing.
  const record = path.join(RECORD_ROOT, group);
  if (fs.existsSync(record)) {
    const stat = fs.statSync(record);
    if (stat.gid !== uid) fs.chownSync(record, stat.uid, uid);
  }
  return { work, record };
}

/** Bytes and file count of a workspace, measured without blocking the runner. */
function measure(work, uid) {
  const du = (args) =>
    new Promise((resolve) => {
      execFile('du', [...args, work], { encoding: 'utf8', timeout: 15_000, uid, gid: uid }, (_error, stdout) => {
        resolve(Number(String(stdout || '').split('\t')[0]) || 0);
      });
    });
  return Promise.all([du(['-sb']), du(['-s', '--inodes'])]).then(([bytes, files]) => ({ bytes, files }));
}

// Measured as the group's own user: the runner's root cannot look inside a workspace.
function usageBytes(work, uid) {
  try {
    const out = execFileSync('du', ['-sb', work], { encoding: 'utf8', timeout: 10_000, uid, gid: uid });
    return Number(out.split('\t')[0]) || 0;
  } catch {
    return 0;
  }
}

/** Requests currently running per user, across lanes. */
const activeByUid = new Map();

function execute(request) {
  return new Promise((resolve) => {
    const { group, uid } = request;
    activeByUid.set(uid, (activeByUid.get(uid) ?? 0) + 1);
    const { work, record } = prepareGroup(group, uid);
    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const limit = request.binary ? MAX_BINARY_OUTPUT : MAX_TEXT_OUTPUT;
    const startBytes = usageBytes(work, uid);

    const env = {
      ...(request.env && typeof request.env === 'object' ? request.env : {}),
      PATH: `${work}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: work,
      // Debian marks the system Python as externally managed; installs go to ~/.local instead.
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      PIP_NO_WARN_SCRIPT_LOCATION: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...(GITHUB_TOKEN ? { GH_TOKEN: GITHUB_TOKEN, GITHUB_TOKEN } : {}),
      GIT_TERMINAL_PROMPT: '0',
      TMPDIR: path.join(work, '.tmp'),
      RECORD: record,
      LANG: 'C.UTF-8',
      TZ,
      MPLBACKEND: 'Agg',
      MPLCONFIGDIR: path.join(work, '.tmp', 'matplotlib'),
      XDG_CACHE_HOME: path.join(work, '.tmp', 'cache'),
      PYTHONDONTWRITEBYTECODE: '1',
      SANDBOX_CMD: String(request.command),
    };

    // No `cwd` option: the switch to the workspace happens after the switch of user.
    const child = spawn('/bin/bash', ['-c', `${limitsFor(startBytes)} mkdir -p "$TMPDIR" && cd "$HOME" && eval "$SANDBOX_CMD"`], {
      uid,
      gid: uid,
      env,
      detached: true, // own process group, so a timeout can take the whole tree down
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let overQuota = false;

    const collect = (name) => (data) => {
      const room = limit - sizes[name];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = data.length > room ? data.subarray(0, room) : data;
      if (piece.length < data.length) truncated = true;
      chunks[name].push(piece);
      sizes[name] += piece.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already exited
      }
    }, timeoutMs);

    // A workspace already over quota may still run commands (to delete things), but may not grow.
    let measuring = false;
    const quotaWatch = setInterval(async () => {
      if (measuring || overQuota) return;
      measuring = true;
      const { bytes, files } = await measure(work, uid);
      measuring = false;
      const grew = bytes > startBytes + QUOTA_SLACK_BYTES;
      if ((bytes > QUOTA_BYTES && grew) || files > QUOTA_FILES) {
        overQuota = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
    }, QUOTA_POLL_MS);

    child.stdin.on('error', () => {});
    child.stdin.end(typeof request.stdin === 'string' ? Buffer.from(request.stdin, request.stdinBase64 ? 'base64' : 'utf8') : undefined);

    let exit = { code: null, signal: null };
    let done = false;

    // The command is over when its shell exits. Anything it left running is killed right
    // away; that also closes the output pipes, which is what lets `close` fire below.
    const stop = () => {
      clearTimeout(timer);
      clearInterval(quotaWatch);
      // This command's own process tree always goes. Everything else the user owns is swept
      // only when nothing else of theirs is running (a hook must not kill a long command).
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      if ((activeByUid.get(uid) ?? 0) <= 1) killUser(uid);
    };

    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      stop();
      activeByUid.set(uid, Math.max(0, (activeByUid.get(uid) ?? 1) - 1));
      const encode = (name) => Buffer.concat(chunks[name]).toString(request.binary && name === 'stdout' ? 'base64' : 'utf8');
      resolve({
        ok: !error,
        ...(error ? { error } : {}),
        code,
        signal,
        timedOut,
        overQuota,
        // True when the workspace was already full, so this command could delete but not write.
        writeBlocked: startBytes >= QUOTA_BYTES,
        quotaBytes: QUOTA_BYTES,
        stdout: encode('stdout'),
        stderr: encode('stderr'),
        truncated,
        usageBytes: usageBytes(work, uid),
      });
    };

    child.on('error', (err) => finish(null, null, `could not start command: ${err.message}`));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      stop();
    });
    child.on('close', () => finish(exit.code, exit.signal));
  });
}

function validate(request) {
  if (!request || typeof request !== 'object') return 'request must be an object';
  if (typeof request.group !== 'string' || !/^group_\d{1,20}$/.test(request.group)) return 'invalid group';
  if (!Number.isInteger(request.uid) || request.uid < UID_MIN || request.uid > UID_MAX) return 'invalid uid';
  if (typeof request.command !== 'string' || !request.command.trim()) return 'missing command';
  if (request.env) {
    for (const [key, value] of Object.entries(request.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string') return 'invalid env';
    }
  }
  return null;
}

// Two lanes per group, each running one request at a time: "main" for the secretary's
// commands (which may take minutes) and "hook" for the quick scripts that react to
// messages, so a long command never holds up the hooks.
const queues = new Map();
function enqueue(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  const parts = [];
  let size = 0;
  let handled = false;

  const reply = (payload) => {
    if (socket.destroyed) return;
    socket.end(JSON.stringify(payload) + '\n');
  };

  const handle = async (raw) => {
    handled = true;
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      return reply({ ok: false, error: 'invalid JSON' });
    }
    const problem = validate(request);
    if (problem) return reply({ ok: false, error: problem });
    try {
      const lane = request.lane === 'hook' ? 'hook' : 'main';
      reply(await enqueue(`${request.uid}:${lane}`, () => execute(request)));
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  };

  socket.on('data', (data) => {
    if (handled) return;
    size += data.length;
    if (size > MAX_REQUEST_BYTES) {
      handled = true;
      return reply({ ok: false, error: 'request too large' });
    }
    parts.push(data);
    const newline = data.indexOf(10);
    if (newline !== -1) {
      const all = Buffer.concat(parts);
      void handle(all.subarray(0, all.indexOf(10)).toString('utf8'));
    }
  });
  socket.on('error', () => {});
});

let network = 'none';
if (hasNetwork()) {
  try {
    installFirewall();
    network = 'public internet only (private addresses and mail ports blocked)';
  } catch (error) {
    console.error(`[sandbox] could not install the firewall, refusing to start: ${error.stderr?.toString().trim() || error.message}`);
    process.exit(1);
  }
}

// The socket folder is readable by the bot's group only, so sandboxed commands
// (which run as other users) cannot connect back and impersonate the bot.
const socketDir = path.dirname(SOCKET_PATH);
fs.mkdirSync(socketDir, { recursive: true });
fs.chownSync(socketDir, 0, BOT_GID);
fs.chmodSync(socketDir, 0o750);
fs.rmSync(SOCKET_PATH, { force: true });

server.listen(SOCKET_PATH, () => {
  fs.chownSync(SOCKET_PATH, 0, BOT_GID);
  fs.chmodSync(SOCKET_PATH, 0o660);
  fs.chmodSync(WORK_ROOT, 0o711);
  console.log(`[sandbox] listening on ${SOCKET_PATH} (tz ${TZ}, network: ${network}, quota ${QUOTA_BYTES / 1024 / 1024} MB per group, github token: ${GITHUB_TOKEN ? 'set' : 'none'})`);
});

// One misbehaving request must not take the runner (and every group's sandbox) down with it.
process.on('uncaughtException', (error) => console.error('[sandbox] uncaught error:', error));
process.on('unhandledRejection', (error) => console.error('[sandbox] unhandled rejection:', error));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
