/**
 * Sandbox runner.
 *
 * Runs inside its own container that holds no secrets, and executes shell
 * commands on behalf of the bot. The bot talks to it over a unix socket in a
 * shared volume; nothing else can reach it.
 *
 * There are two backends, chosen with SANDBOX_BACKEND:
 *
 * local (default)
 *   Commands run inside this container. Every group has its own Linux user; a
 *   command for a group runs as that user, in that group's workspace
 *   (/work/<group>), with a read-only view of that group's record
 *   (/record/<group>). File permissions keep groups apart: a workspace is mode
 *   0700, and a record folder is readable only by the bot and by the owning
 *   group's user. Commands never run as root, hold no capabilities, and cannot
 *   gain privileges back. Anything a command leaves running is killed when it
 *   returns.
 *
 * workbench
 *   Every group gets its own long-lived machine: a container named
 *   binjai-wb-<group digits> from the binjaibot-workbench image, run under gVisor
 *   (runsc), so it has its own kernel. Commands run there as root through
 *   `docker exec`: they may apt-get install anything and leave services running
 *   between commands. The workspace is bind-mounted at /work (it survives the
 *   container being recreated) and the record read-only at /record. The
 *   workbench network may reach the public internet only; that is enforced on
 *   the host by deploy/workbench-firewall.sh, and the runner checks it from
 *   inside each workbench before use and refuses to run anything when private
 *   addresses or the cloud metadata service are reachable. This backend needs
 *   the host's docker socket, which makes the runner root-equivalent on the
 *   host; that is acceptable because only the bot can reach the runner's socket
 *   and the runner never runs group commands itself in this mode.
 *
 * Network (both backends): this container may reach the public internet, but a
 * firewall set up here at startup rejects every private and link-local address.
 * If the firewall cannot be installed the runner refuses to start.
 *
 * The runner itself starts as root with just enough capabilities to switch
 * user, hand folders over, measure workspaces and set its firewall (SETUID,
 * SETGID, CHOWN, KILL, DAC_READ_SEARCH, NET_ADMIN).
 *
 * Protocol: one JSON object per connection, newline terminated, answered
 * with one JSON object.
 *   -> { group, uid, command, stdin?, stdinBase64?, env?, timeoutMs?, binary?, lane? }
 *   <- { ok, code, signal, timedOut, overQuota, writeBlocked, quotaBytes, stdout, stderr, truncated, usageBytes }
 *      | { ok:false, error }
 *   -> { group, uid, action: "status" }
 *   <- { ok, backend, usageBytes, quotaBytes, ... } (workbench: container, state, image, created, ...)
 *   -> { group, uid, action: "reset" }
 *   <- { ok, backend, ... } (workbench: removes the container, keeps /work; local: kills the
 *      group's processes)
 *
 * Stream mode, for long-lived stdio processes such as MCP servers:
 *   -> { group, uid, command, env?, stream: true }\n<raw bytes...>
 * After the newline the connection is a raw byte pipe: bytes from the client
 * go to the process's stdin, the process's stdout comes back. stderr is
 * discarded (redirect it yourself). If the process cannot be started, the
 * runner instead answers one JSON line { ok:false, error } and closes. A client
 * half-close closes stdin (the process is killed 5 s later if still alive);
 * the socket is ended when the process exits; a dropped connection kills the
 * process. A stream lives at most one hour and does not wait in a lane.
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const BACKEND = process.env.SANDBOX_BACKEND || 'local';
const SOCKET_PATH = process.env.SANDBOX_SOCKET || '/run/sandbox/runner.sock';
const WORK_ROOT = process.env.SANDBOX_WORK_ROOT || '/work';
const RECORD_ROOT = process.env.SANDBOX_RECORD_ROOT || '/record';
const BOT_UID = Number(process.env.SANDBOX_BOT_UID || 1000);
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

// Stream mode: an open stream lives at most this long, and gets this long to exit on its own
// once the client has closed its end.
const STREAM_MAX_MS = 60 * 60 * 1000;
const STREAM_GRACE_MS = 5000;

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
    `ulimit -f ${fileBlocks}; ulimit -u 512; ulimit -n 512; ulimit -c 0; umask 077;`
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

/**
 * Bytes and file count of a workspace, measured without blocking the runner. Without a uid
 * the measuring runs as the runner's root (which needs DAC_READ_SEARCH to see everything).
 */
function measure(work, uid) {
  const asUser = uid === undefined ? {} : { uid, gid: uid };
  const du = (args) =>
    new Promise((resolve) => {
      execFile('du', [...args, work], { encoding: 'utf8', timeout: 15_000, ...asUser }, (_error, stdout) => {
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

/** Requests (and open streams) currently running per user, across lanes. */
const activeByUid = new Map();
const markActive = (uid) => activeByUid.set(uid, (activeByUid.get(uid) ?? 0) + 1);
const markDone = (uid) => activeByUid.set(uid, Math.max(0, (activeByUid.get(uid) ?? 1) - 1));

function clampTimeout(request) {
  return Math.min(Math.max(Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
}

function stdinOf(request) {
  return typeof request.stdin === 'string' ? Buffer.from(request.stdin, request.stdinBase64 ? 'base64' : 'utf8') : undefined;
}

/** Collects a command's stdout and stderr up to `limit` bytes each. */
function outputCollector(limit) {
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const state = { truncated: false };
  return {
    state,
    collect: (name) => (data) => {
      const room = limit - sizes[name];
      if (room <= 0) {
        state.truncated = true;
        return;
      }
      const piece = data.length > room ? data.subarray(0, room) : data;
      if (piece.length < data.length) state.truncated = true;
      chunks[name].push(piece);
      sizes[name] += piece.length;
    },
    encode: (name, binary) => Buffer.concat(chunks[name]).toString(binary && name === 'stdout' ? 'base64' : 'utf8'),
  };
}

/**
 * The environment a command sees. The deployment-wide GitHub token comes first so a group
 * secret of the same name wins; the fixed variables come last so nothing overrides them.
 */
function commandEnv(request, { work, record, pathVar }) {
  return {
    ...(GITHUB_TOKEN ? { GH_TOKEN: GITHUB_TOKEN, GITHUB_TOKEN } : {}),
    ...(request.env && typeof request.env === 'object' ? request.env : {}),
    PATH: pathVar,
    HOME: work,
    // Debian marks the system Python as externally managed; installs go to ~/.local instead.
    PIP_BREAK_SYSTEM_PACKAGES: '1',
    PIP_NO_WARN_SCRIPT_LOCATION: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: path.join(work, '.tmp'),
    RECORD: record,
    LANG: 'C.UTF-8',
    TZ,
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: path.join(work, '.tmp', 'matplotlib'),
    XDG_CACHE_HOME: path.join(work, '.tmp', 'cache'),
    PYTHONDONTWRITEBYTECODE: '1',
    // Debian's Chromium, for pages that need a real browser (see the Dockerfile).
    CHROMIUM: '/usr/bin/chromium',
    SANDBOX_CMD: String(request.command ?? ''),
  };
}

// ---------------------------------------------------------------------------------------------
// Local backend: commands run in this container, as the group's own unprivileged user.
// ---------------------------------------------------------------------------------------------

function localEnv(request, work, record) {
  return commandEnv(request, { work, record, pathVar: `${work}/.local/bin:/usr/local/bin:/usr/bin:/bin` });
}

/** Start the group's command as its own user. No `cwd` option: the switch to the workspace happens after the switch of user. */
function spawnLocal(request, startBytes, work, record) {
  return spawn('/bin/bash', ['-c', `${limitsFor(startBytes)} mkdir -p "$TMPDIR" && cd "$HOME" && eval "$SANDBOX_CMD"`], {
    uid: request.uid,
    gid: request.uid,
    env: localEnv(request, work, record),
    detached: true, // own process group, so a timeout can take the whole tree down
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function execute(request) {
  return new Promise((resolve) => {
    const { group, uid } = request;
    markActive(uid);
    const { work, record } = prepareGroup(group, uid);
    const timeoutMs = clampTimeout(request);
    const limit = request.binary ? MAX_BINARY_OUTPUT : MAX_TEXT_OUTPUT;
    const startBytes = usageBytes(work, uid);

    const child = spawnLocal(request, startBytes, work, record);

    const output = outputCollector(limit);
    let timedOut = false;
    let overQuota = false;
    child.stdout.on('data', output.collect('stdout'));
    child.stderr.on('data', output.collect('stderr'));

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
    child.stdin.end(stdinOf(request));

    let exit = { code: null, signal: null };
    let done = false;

    // The command is over when its shell exits. Anything it left running is killed right
    // away; that also closes the output pipes, which is what lets `close` fire below.
    const stop = () => {
      clearTimeout(timer);
      clearInterval(quotaWatch);
      // This command's own process tree always goes. Everything else the user owns is swept
      // only when nothing else of theirs is running (a hook or an open stream must not be
      // killed by another command ending).
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
      markDone(uid);
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
        stdout: output.encode('stdout', request.binary),
        stderr: output.encode('stderr', request.binary),
        truncated: output.state.truncated,
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

const localBackend = {
  name: 'local',
  execute,

  /** A long-lived process as the group's user; killed (with everything it started) when the stream ends. */
  async openStream(request) {
    const { group, uid } = request;
    const { work, record } = prepareGroup(group, uid);
    const child = spawnLocal(request, usageBytes(work, uid), work, record);
    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    return {
      child,
      kill: killTree,
      // Like execute(): leftovers go once the process exits, unless the user has something else running.
      onExit: () => {
        killTree();
        if ((activeByUid.get(uid) ?? 0) <= 1) killUser(uid);
      },
    };
  },

  async status(request) {
    const work = path.join(WORK_ROOT, request.group);
    return { ok: true, backend: 'local', usageBytes: fs.existsSync(work) ? usageBytes(work, request.uid) : 0, quotaBytes: QUOTA_BYTES };
  },

  async reset(request) {
    return { ok: true, backend: 'local', killed: killUser(request.uid) };
  },
};

// ---------------------------------------------------------------------------------------------
// Workbench backend: one gVisor container per group, managed through the host's docker daemon.
// ---------------------------------------------------------------------------------------------

const DOCKER = process.env.DOCKER_BIN || '/usr/local/bin/docker';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/run/docker.sock';
// The docker CLI's own environment. Nothing from a request ever lands in it except under the
// WBV_ prefix (see dockerExec), so a group cannot steer the CLI with DOCKER_HOST and the like.
const DOCKER_ENV = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  DOCKER_HOST: `unix://${DOCKER_SOCKET}`,
  DOCKER_CONFIG: '/run/docker-config',
};

// Paths as the docker daemon sees them: bind mounts are resolved on the host, not here.
const HOST_DATA_DIR = process.env.HOST_DATA_DIR || '';
const WB_IMAGE = process.env.WORKBENCH_IMAGE || 'binjaibot-workbench:latest';
const WB_RUNTIME = process.env.WORKBENCH_RUNTIME || 'runsc';
const WB_NETWORK = 'binjaibot-workbench';
const WB_SUBNET = '172.30.240.0/24';
const WB_BRIDGE = 'br-binjai-wb'; // the host firewall matches on this name
const WB_MEMORY = process.env.WORKBENCH_MEMORY || '4g';
const WB_CPUS = process.env.WORKBENCH_CPUS || '2';
const WB_PIDS = process.env.WORKBENCH_PIDS || '4096';
// Docker's embedded DNS (127.0.0.11) does not work under gVisor, and the cloud's own resolver
// sits on a link-local address the firewall blocks, so workbenches use public resolvers.
const WB_DNS = (process.env.WORKBENCH_DNS || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean);
// A root machine installs packages and builds things: allow big single files, while the
// total stays under the group's quota.
const WB_MAX_FILE_BLOCKS = Number(process.env.WORKBENCH_MAX_FILE_MB || 2048) * 1024;
const WB_PATH = '/work/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
// Re-check a workbench's network isolation this often while it is in use.
const WB_PROBE_EVERY_MS = 10 * 60 * 1000;
const WB_VERIFIED_TTL_MS = 10_000;
const FIREWALL_HINT = 'workbench firewall is not installed: run deploy/workbench-firewall.sh';

/** Run the docker CLI. Resolves with its exit code and output; never rejects. */
function docker(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(DOCKER, args, { env: DOCKER_ENV, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') || (error ? error.message : '') });
    });
  });
}

async function dockerOk(args, options) {
  const result = await docker(args, options);
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

const workbenchName = (group) => `binjai-wb-${group.replace(/\D/g, '')}`;

function workbenchEnv(request) {
  return commandEnv(request, { work: '/work', record: '/record', pathVar: WB_PATH });
}

/**
 * The wrapper every workbench process starts with. Variable values travel as WBV_<NAME> (so
 * secrets never appear in a process's arguments and never steer the docker CLI); the wrapper
 * moves them to their real names before anything else runs.
 */
function workbenchScript(startBytes) {
  const remainingBlocks = Math.max(0, Math.floor((QUOTA_BYTES - startBytes) / 1024));
  const fileBlocks = Math.min(WB_MAX_FILE_BLOCKS, remainingBlocks);
  return (
    'for __v in ${!WBV_@}; do export "${__v#WBV_}=${!__v}"; unset "$__v"; done; unset __v; ' +
    `ulimit -f ${fileBlocks}; ulimit -c 0; ` +
    'mkdir -p "$TMPDIR" && cd /work && eval "$SANDBOX_CMD"'
  );
}

/**
 * `docker exec -i` into a workbench as root. Values go through the CLI's environment and only
 * `-e WBV_NAME` flags go in its arguments. SANDBOX_EXEC_ID tags every process the command
 * starts, so they can be found and killed later (killing the CLI does not stop them).
 */
function execArgs(env) {
  const cliEnv = { ...DOCKER_ENV };
  const flags = [];
  for (const [key, value] of Object.entries(env)) {
    cliEnv[`WBV_${key}`] = value;
    flags.push('-e', `WBV_${key}`);
  }
  return { cliEnv, flags };
}

function dockerExec(name, env, argv) {
  const { cliEnv, flags } = execArgs(env);
  return spawn(DOCKER, ['exec', '-i', '-u', '0', '-w', '/work', ...flags, name, ...argv], {
    env: cliEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// /proc/<pid>/environ shows a process's environment as it started: the wrapper shell and
// `timeout` still carry the WBV_ form, everything the command started carries the real name.
const KILL_EXEC_SCRIPT =
  'for p in /proc/[0-9]*; do ' +
  'tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qxF -e "SANDBOX_EXEC_ID=$1" -e "WBV_SANDBOX_EXEC_ID=$1" && kill -9 "${p#/proc/}" 2>/dev/null; ' +
  'done; true';

/** Kill every process (including background ones) a workbench command started. */
function killExec(name, execId) {
  return docker(['exec', name, 'bash', '-c', KILL_EXEC_SCRIPT, 'kill', execId], { timeoutMs: 30_000 });
}

// Connects from inside a workbench to addresses that must be unreachable. Only a successful
// connection counts: "refused" looks the same with and without a firewall.
const PROBE_SCRIPT = `
leaks=""
curl -s -o /dev/null -m 3 http://169.254.169.254/ && leaks="$leaks 169.254.169.254:80"
for target in "$@"; do
  timeout 3 bash -c "exec 3<>/dev/tcp/\${target%:*}/\${target##*:}" 2>/dev/null && leaks="$leaks $target"
done
echo "leaks:$leaks"
`;

let networkGateway = '172.30.240.1';
let networkReady = false;

/** Create the workbench network if missing: IPv4 only, fixed subnet and bridge name, no inter-container traffic. */
async function ensureNetwork() {
  if (networkReady) return;
  let found = await docker(['network', 'inspect', WB_NETWORK, '--format', '{{json .IPAM.Config}}|{{json .Options}}']);
  if (found.code !== 0) {
    const created = await docker([
      'network', 'create', '--driver', 'bridge', '--subnet', WB_SUBNET,
      '-o', `com.docker.network.bridge.name=${WB_BRIDGE}`,
      '-o', 'com.docker.network.bridge.enable_icc=false',
      WB_NETWORK,
    ]);
    // Another request may have created it in the meantime.
    if (created.code !== 0 && !/already exists/.test(created.stderr)) throw new Error(`could not create the workbench network: ${created.stderr.trim()}`);
    found = await docker(['network', 'inspect', WB_NETWORK, '--format', '{{json .IPAM.Config}}|{{json .Options}}']);
  }
  const [ipam, options] = found.stdout.trim().split('|');
  const config = JSON.parse(ipam || '[]')[0] ?? {};
  // The host firewall is written for this subnet and bridge; anything else would leave it open.
  if (config.Subnet !== WB_SUBNET || !String(options).includes(WB_BRIDGE)) {
    throw new Error(`network ${WB_NETWORK} exists with the wrong subnet or bridge (want ${WB_SUBNET} on ${WB_BRIDGE}); remove it`);
  }
  networkGateway = config.Gateway || networkGateway;
  networkReady = true;
}

/** The resolv.conf every workbench mounts read-only. Returns its host path. */
function ensureResolvConf() {
  const dir = path.join(WORK_ROOT, '.workbench');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, 'resolv.conf');
  const content = WB_DNS.map((server) => `nameserver ${server}`).join('\n') + '\noptions edns0\n';
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content, { mode: 0o644 });
  return path.join(HOST_DATA_DIR, 'sandbox', '.workbench', 'resolv.conf');
}

let imageCache = { id: null, at: 0 };
async function currentImageId() {
  if (imageCache.id && Date.now() - imageCache.at < 30_000) return imageCache.id;
  const result = await docker(['image', 'inspect', '--format', '{{.Id}}', WB_IMAGE]);
  if (result.code !== 0) {
    throw new Error(`the workbench image ${WB_IMAGE} is missing; build it with: docker compose --profile image build workbench-image`);
  }
  imageCache = { id: result.stdout.trim(), at: Date.now() };
  return imageCache.id;
}

async function inspectWorkbench(name) {
  const result = await docker(['container', 'inspect', name]);
  if (result.code !== 0) return null;
  const [info] = JSON.parse(result.stdout);
  return {
    state: info.State?.Status,
    running: Boolean(info.State?.Running),
    image: info.Config?.Image,
    imageId: info.Image,
    created: info.Created,
    startedAt: info.State?.StartedAt,
  };
}

/** Workspace and record must exist before the daemon binds them, or it would create them as root. */
function prepareWorkbenchFolders(group, uid) {
  const work = path.join(WORK_ROOT, group);
  if (!fs.existsSync(work)) {
    fs.mkdirSync(work, { mode: 0o700 });
    fs.chownSync(work, uid, uid); // as in local mode, so the workspace still works if the backend is switched back
  }
  // Created as the bot, which owns the records folder and writes into this one later (the
  // runner's root has no permission-override capability, so it could not create it itself).
  const record = path.join(RECORD_ROOT, group);
  if (!fs.existsSync(record)) {
    execFileSync('mkdir', ['-p', '-m', '0750', record], { uid: BOT_UID, gid: BOT_GID, stdio: 'ignore' });
  }
  return work;
}

async function createWorkbench(group, uid, name) {
  prepareWorkbenchFolders(group, uid);
  await ensureNetwork();
  const resolv = ensureResolvConf();
  const bind = (src, dst, readonly) => `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`;
  await dockerOk([
    'run', '-d',
    '--name', name,
    '--hostname', group,
    '--runtime', WB_RUNTIME,
    '--network', WB_NETWORK,
    '--memory', WB_MEMORY, '--memory-swap', WB_MEMORY,
    '--cpus', WB_CPUS,
    '--pids-limit', WB_PIDS,
    '--restart', 'unless-stopped',
    '--label', `binjaibot.workbench=${group}`,
    '--env', `TZ=${TZ}`,
    '--log-opt', 'max-size=1m',
    '--mount', bind(path.join(HOST_DATA_DIR, 'sandbox', group), '/work'),
    '--mount', bind(path.join(HOST_DATA_DIR, 'groups', group), '/record', true),
    '--mount', bind(resolv, '/etc/resolv.conf', true),
    WB_IMAGE,
  ]);
}

/** Runs the group's own /work/.setup.sh in the background, so its installs come back after a rebuild. */
async function startSetupScript(name, request) {
  const env = workbenchEnv({ ...request, command: 'test -f /work/.setup.sh && exec bash /work/.setup.sh >/work/.tmp/setup.log 2>&1' });
  const work = path.join(WORK_ROOT, request.group);
  const { bytes } = await measure(work);
  const { cliEnv, flags } = execArgs(env);
  await new Promise((resolve) => {
    execFile(DOCKER, ['exec', '-d', '-u', '0', '-w', '/work', ...flags, name, 'bash', '-c', workbenchScript(bytes)], { env: cliEnv, timeout: 30_000 }, () => resolve());
  });
}

/** Isolation state per container, and for the backend as a whole. */
const probedAt = new Map();
let unsafeReason = null;

/** Check from inside a workbench that private addresses are unreachable. Throws (and stops the container) if not. */
async function probeWorkbench(name) {
  const targets = [`${networkGateway}:22`, '172.17.0.1:22', ...(process.env.WORKBENCH_PROBE_TARGETS || '').split(',').filter(Boolean)];
  const result = await docker(['exec', name, 'bash', '-c', PROBE_SCRIPT, 'probe', ...targets], { timeoutMs: 60_000 });
  const line = result.stdout.split('\n').find((l) => l.startsWith('leaks:'));
  if (result.code !== 0 || line === undefined) {
    throw new Error(`could not check the workbench network: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const leaks = line.slice('leaks:'.length).trim();
  if (leaks) {
    unsafeReason = `${FIREWALL_HINT} (reachable from a workbench: ${leaks})`;
    console.error(`[sandbox] ${unsafeReason}; stopping ${name}`);
    await docker(['stop', '-t', '1', name]);
    throw new Error(unsafeReason);
  }
  if (unsafeReason) console.log('[sandbox] workbench firewall is in place now');
  unsafeReason = null;
  probedAt.set(name, Date.now());
}

const verifiedAt = new Map();
const needsSetup = new Set();
const groupLocks = new Map();
function withGroupLock(group, task) {
  const previous = groupLocks.get(group) ?? Promise.resolve();
  const next = previous.then(task, task);
  groupLocks.set(group, next.catch(() => {}));
  return next;
}

/**
 * Make sure the group's workbench exists, runs the current image and is isolated. The caller
 * has already counted its own request as active, so "idle" means nothing but this request.
 */
function ensureWorkbench(request) {
  const { group, uid } = request;
  const name = workbenchName(group);
  return withGroupLock(group, async () => {
    if (!unsafeReason && Date.now() - (verifiedAt.get(name) ?? 0) < WB_VERIFIED_TTL_MS) return name;
    verifiedAt.delete(name);
    const imageId = await currentImageId();
    let info = await inspectWorkbench(name);
    const idle = (activeByUid.get(uid) ?? 0) <= 1;
    if (info && info.imageId !== imageId && idle) {
      console.log(`[sandbox] ${name}: new workbench image, recreating`);
      await dockerOk(['rm', '-f', name]);
      info = null;
    }
    if (!info) {
      await createWorkbench(group, uid, name);
      needsSetup.add(name);
      probedAt.delete(name);
    } else if (!info.running) {
      await dockerOk(['start', name]);
    }
    // Checked on first use after every start of the runner, after every (re)creation, every
    // few minutes while in use, and on every request while the backend is unsafe.
    if (unsafeReason || Date.now() - (probedAt.get(name) ?? 0) > WB_PROBE_EVERY_MS) await probeWorkbench(name);
    // Only once the machine is known to be isolated.
    if (needsSetup.delete(name)) await startSetupScript(name, request);
    verifiedAt.set(name, Date.now());
    return name;
  });
}

/** Retry once when the container vanished or stopped between the check and the exec. */
function isContainerGone(stderr) {
  return /No such container|is not running|is restarting/.test(stderr);
}

async function executeWorkbench(request) {
  const { uid } = request;
  markActive(uid);
  try {
    let result = await runWorkbenchCommand(await ensureWorkbench(request), request);
    if (result.code !== 0 && !result.stdout && isContainerGone(result.stderr)) {
      verifiedAt.delete(workbenchName(request.group));
      result = await runWorkbenchCommand(await ensureWorkbench(request), request);
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    markDone(uid);
  }
}

async function runWorkbenchCommand(name, request) {
  const work = path.join(WORK_ROOT, request.group);
  const timeoutMs = clampTimeout(request);
  const seconds = Math.ceil(timeoutMs / 1000);
  const limit = request.binary ? MAX_BINARY_OUTPUT : MAX_TEXT_OUTPUT;
  const startBytes = (await measure(work)).bytes;
  const execId = randomBytes(12).toString('hex');
  const env = { ...workbenchEnv(request), SANDBOX_EXEC_ID: execId };

  return new Promise((resolve) => {
    // The command's own time limit is enforced inside the workbench; the timer here is only a
    // backstop for a hung docker CLI.
    const child = dockerExec(name, env, ['timeout', '-k', '5', String(seconds), 'bash', '-c', workbenchScript(startBytes)]);
    const started = Date.now();
    const output = outputCollector(limit);
    let timedOut = false;
    let overQuota = false;
    let done = false;
    child.stdout.on('data', output.collect('stdout'));
    child.stderr.on('data', output.collect('stderr'));

    // Killing the CLI does not stop the command inside; that takes killExec.
    let killing = null;
    const kill = () => {
      child.kill('SIGKILL');
      killing ??= killExec(name, execId);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs + 10_000);

    let measuring = false;
    const quotaWatch = setInterval(async () => {
      if (measuring || overQuota) return;
      measuring = true;
      const { bytes, files } = await measure(work);
      measuring = false;
      const grew = bytes > startBytes + QUOTA_SLACK_BYTES;
      if ((bytes > QUOTA_BYTES && grew) || files > QUOTA_FILES) {
        overQuota = true;
        kill();
      }
    }, QUOTA_POLL_MS);

    child.stdin.on('error', () => {});
    child.stdin.end(stdinOf(request));

    // Background processes the command started keep running: that is the point of a workbench.
    const finish = async (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(quotaWatch);
      // Report only once the command is really gone, so the usage below is final.
      if (killing) await killing;
      // `timeout` exits 124 (TERM) or 137 (KILL after the grace period) when the limit hit.
      if ((code === 124 || code === 137) && Date.now() - started >= seconds * 1000 - 250) timedOut = true;
      resolve({
        ok: !error,
        ...(error ? { error } : {}),
        code,
        signal,
        timedOut,
        overQuota,
        writeBlocked: startBytes >= QUOTA_BYTES,
        quotaBytes: QUOTA_BYTES,
        stdout: output.encode('stdout', request.binary),
        stderr: output.encode('stderr', request.binary),
        truncated: output.state.truncated,
        usageBytes: (await measure(work)).bytes,
      });
    };

    child.on('error', (err) => finish(null, null, `could not start command: ${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

const workbenchBackend = {
  name: 'workbench',
  execute: executeWorkbench,

  /** `docker exec -i` with stdin/stdout as the pipe; the whole process tree is killed when the stream ends. */
  async openStream(request) {
    const name = await ensureWorkbench(request);
    const startBytes = (await measure(path.join(WORK_ROOT, request.group))).bytes;
    const execId = randomBytes(12).toString('hex');
    const env = { ...workbenchEnv(request), SANDBOX_EXEC_ID: execId };
    const seconds = String(STREAM_MAX_MS / 1000);
    const child = dockerExec(name, env, ['timeout', '-k', '5', seconds, 'bash', '-c', workbenchScript(startBytes)]);
    return {
      child,
      kill: () => {
        child.kill('SIGKILL');
        void killExec(name, execId);
      },
      onExit: () => {},
    };
  },

  async status(request) {
    const name = workbenchName(request.group);
    const [info, imageId, usage] = await Promise.all([
      inspectWorkbench(name),
      currentImageId().catch(() => null),
      measure(path.join(WORK_ROOT, request.group)),
    ]);
    return {
      ok: true,
      backend: 'workbench',
      container: name,
      exists: Boolean(info),
      state: info?.state ?? 'missing',
      image: info?.image ?? null,
      imageId: info?.imageId ?? null,
      imageCurrent: info && imageId ? info.imageId === imageId : null,
      created: info?.created ?? null,
      startedAt: info?.startedAt ?? null,
      usageBytes: usage.bytes,
      quotaBytes: QUOTA_BYTES,
      firewall: unsafeReason ?? (probedAt.has(name) ? 'ok' : 'not checked yet'),
    };
  },

  /** Throw the machine away; the workspace stays, and the next request builds a fresh one. */
  async reset(request) {
    const name = workbenchName(request.group);
    return withGroupLock(request.group, async () => {
      const result = await docker(['rm', '-f', name]);
      verifiedAt.delete(name);
      probedAt.delete(name);
      const removed = result.code === 0;
      if (!removed && !/No such container/.test(result.stderr)) return { ok: false, error: `could not remove the workbench: ${result.stderr.trim()}` };
      return { ok: true, backend: 'workbench', container: name, removed };
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const backend = BACKEND === 'workbench' ? workbenchBackend : localBackend;

function validate(request) {
  if (!request || typeof request !== 'object') return 'request must be an object';
  if (typeof request.group !== 'string' || !/^group_\d{1,20}$/.test(request.group)) return 'invalid group';
  if (!Number.isInteger(request.uid) || request.uid < UID_MIN || request.uid > UID_MAX) return 'invalid uid';
  if (request.action !== undefined) {
    if (request.action !== 'status' && request.action !== 'reset') return 'invalid action';
    if (request.stream) return 'an action cannot be a stream';
    return null;
  }
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

/**
 * Turn the connection into a pipe to a long-lived process. Bypasses the lanes; counts as
 * active for the user while open, so a command ending elsewhere does not sweep it away.
 */
async function openStream(socket, request, initial, reply) {
  const { uid } = request;
  markActive(uid);
  let handle;
  try {
    handle = await backend.openStream(request);
  } catch (error) {
    markDone(uid);
    return reply({ ok: false, error: error.message });
  }
  const { child } = handle;
  let exited = false;
  const kill = () => {
    if (!exited) handle.kill();
  };
  const lifetime = setTimeout(kill, STREAM_MAX_MS);
  let grace = null;

  child.stdin.on('error', () => {});
  child.stderr.resume(); // discarded
  if (initial.length) child.stdin.write(initial);
  socket.pipe(child.stdin); // a client half-close ends stdin
  child.stdout.pipe(socket, { end: false });

  socket.on('end', () => {
    grace = setTimeout(kill, STREAM_GRACE_MS);
  });
  socket.on('close', kill);
  socket.on('error', kill);

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    exited = true;
    clearTimeout(lifetime);
    clearTimeout(grace);
    markDone(uid);
    socket.end();
  };
  child.on('exit', () => handle.onExit());
  child.on('error', () => {
    finish();
    socket.destroy();
  });
  child.on('close', finish);
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  const parts = [];
  let size = 0;
  let handled = false;

  const reply = (payload) => {
    if (socket.destroyed) return;
    socket.end(JSON.stringify(payload) + '\n');
  };

  const respond = async (request) => {
    try {
      if (request.action) return reply(await backend[request.action](request));
      const lane = request.lane === 'hook' ? 'hook' : 'main';
      reply(await enqueue(`${request.uid}:${lane}`, () => backend.execute(request)));
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  };

  const onData = (data) => {
    if (handled) return;
    size += data.length;
    if (size > MAX_REQUEST_BYTES) {
      handled = true;
      return reply({ ok: false, error: 'request too large' });
    }
    parts.push(data);
    if (data.indexOf(10) === -1) return;
    handled = true;
    const all = Buffer.concat(parts);
    const newline = all.indexOf(10);
    let request;
    try {
      request = JSON.parse(all.subarray(0, newline).toString('utf8'));
    } catch {
      return reply({ ok: false, error: 'invalid JSON' });
    }
    const problem = validate(request);
    if (problem) return reply({ ok: false, error: problem });
    if (request.stream) {
      // Everything after the header belongs to the process's stdin. Hold further bytes
      // until the process exists (starting a workbench can take a moment).
      socket.off('data', onData);
      socket.pause();
      void openStream(socket, request, all.subarray(newline + 1), reply);
      return;
    }
    void respond(request);
  };

  socket.on('data', onData);
  socket.on('error', () => {});
});

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

if (BACKEND !== 'local' && BACKEND !== 'workbench') {
  console.error(`[sandbox] unknown SANDBOX_BACKEND "${BACKEND}" (use local or workbench), refusing to start`);
  process.exit(1);
}

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

if (BACKEND === 'workbench') {
  if (!HOST_DATA_DIR) {
    console.error('[sandbox] SANDBOX_BACKEND=workbench needs HOST_DATA_DIR (the host path of the data folder), refusing to start');
    process.exit(1);
  }
  fs.mkdirSync(DOCKER_ENV.DOCKER_CONFIG, { recursive: true, mode: 0o700 });
  const version = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
  if (version.code !== 0) {
    console.error(`[sandbox] SANDBOX_BACKEND=workbench but the docker daemon is not reachable at ${DOCKER_SOCKET}: ${version.stderr.trim()}`);
    process.exit(1);
  }
  try {
    await ensureNetwork();
  } catch (error) {
    console.error(`[sandbox] ${error.message}`);
    process.exit(1);
  }
  await currentImageId().catch((error) => console.error(`[sandbox] ${error.message}`));
  console.log(`[sandbox] workbench backend: docker ${version.stdout.trim()}, image ${WB_IMAGE}, runtime ${WB_RUNTIME}, network ${WB_NETWORK} (${WB_SUBNET})`);
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
  console.log(`[sandbox] listening on ${SOCKET_PATH} (backend ${BACKEND}, tz ${TZ}, network: ${network}, quota ${QUOTA_BYTES / 1024 / 1024} MB per group, github token: ${GITHUB_TOKEN ? 'set' : 'none'})`);
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
