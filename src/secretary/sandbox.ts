/**
 * Client for the sandbox runner (see sandbox/runner.mjs).
 *
 * The secretary's shell commands and file writes never run in the bot's own
 * container. They are sent over a unix socket to a second container that has
 * no network and no secrets, where each group runs as its own Linux user.
 */

import * as net from 'net';
import * as path from 'path';
import { config } from '../config.js';
import { groupDir } from './transcript.js';

export interface SandboxResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  overQuota?: boolean;
  /** The workspace was already full, so the command could delete but not write. */
  writeBlocked?: boolean;
  quotaBytes?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  usageBytes: number;
}

interface SandboxRequest {
  command: string;
  stdin?: string;
  stdinBase64?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Return stdout as base64 (for reading files back out of the sandbox). */
  binary?: boolean;
  /** "hook" requests run beside the secretary's own commands instead of queueing behind them. */
  lane?: 'main' | 'hook';
}

export const MAX_SEND_FILE_BYTES = 45_000_000;

export function sandboxEnabled(): boolean {
  return config.SANDBOX_SOCKET.length > 0;
}

function request(chatId: number, uid: number, body: SandboxRequest): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.SANDBOX_SOCKET);
    const chunks: Buffer[] = [];
    // The runner enforces the command timeout itself; this is only a backstop for a dead runner.
    const deadline = setTimeout(
      () => socket.destroy(new Error('The sandbox did not respond.')),
      (body.timeoutMs ?? 60_000) + 30_000,
    );

    socket.on('connect', () => {
      socket.write(JSON.stringify({ group: path.basename(groupDir(chatId)), uid, ...body }) + '\n');
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      clearTimeout(deadline);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new Error(code === 'ENOENT' || code === 'ECONNREFUSED' ? 'The sandbox is not running.' : error.message));
    });
    socket.on('end', () => {
      clearTimeout(deadline);
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SandboxResult & { ok: boolean; error?: string };
        if (!reply.ok) reject(new Error(reply.error ?? 'The sandbox refused the request.'));
        else resolve(reply);
      } catch {
        reject(new Error('The sandbox sent an unreadable reply.'));
      }
    });
  });
}

/** Run a shell command in the group's workspace. */
export function runInSandbox(
  chatId: number,
  uid: number,
  command: string,
  timeoutSeconds = 60,
  env?: Record<string, string>,
): Promise<SandboxResult> {
  return request(chatId, uid, { command, timeoutMs: Math.round(timeoutSeconds * 1000), env });
}

/**
 * Write a file in the group's workspace. The path is handed to the shell as data,
 * and the write happens as the group's own user, so a path that points outside
 * the workspace simply fails with "permission denied".
 */
export function writeSandboxFile(chatId: number, uid: number, filePath: string, content: string): Promise<SandboxResult> {
  return request(chatId, uid, {
    command: 'mkdir -p -- "$(dirname -- "$SANDBOX_FILE")" && cat > "$SANDBOX_FILE"',
    env: { SANDBOX_FILE: filePath },
    stdin: content,
    timeoutMs: 20_000,
  });
}

/** Put a file someone sent in the chat into the group's workspace. */
export async function uploadToSandbox(chatId: number, uid: number, filePath: string, data: Buffer): Promise<void> {
  const result = await request(chatId, uid, {
    command: 'mkdir -p -- "$(dirname -- "$SANDBOX_FILE")" && cat > "$SANDBOX_FILE"',
    env: { SANDBOX_FILE: filePath },
    stdin: data.toString('base64'),
    stdinBase64: true,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'could not save the file');
}

/** Empty a group's workspace (used when the group's record is erased). */
export async function clearSandbox(chatId: number, uid: number): Promise<void> {
  await request(chatId, uid, { command: 'find . -mindepth 1 -delete', timeoutMs: 60_000 });
}

/** Read a file out of the group's workspace (to post it in the chat). */
export async function readSandboxFile(chatId: number, uid: number, filePath: string): Promise<Buffer> {
  const result = await request(chatId, uid, {
    command:
      `test -f "$SANDBOX_FILE" || { echo "no such file" >&2; exit 2; }; ` +
      `test "$(stat -c %s -- "$SANDBOX_FILE")" -le ${MAX_SEND_FILE_BYTES} || { echo "file is larger than 45 MB" >&2; exit 3; }; ` +
      `cat -- "$SANDBOX_FILE"`,
    env: { SANDBOX_FILE: filePath },
    binary: true,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `could not read ${filePath}`);
  }
  return Buffer.from(result.stdout, 'base64');
}

export interface HookScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HOOK_TIMEOUT_SECONDS = 5;

// Runs every hook file named in $HOOK_FILES with the event JSON on stdin, each with its own
// time limit, and prints one tab-separated line per hook: file, exit code, stdout, stderr
// (the last two base64 encoded so anything a script prints survives the trip).
const HOOK_DISPATCHER = `
input=$(cat)
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    *.py) runner="python3" ;;
    *.js|*.mjs) runner="node" ;;
    *) runner="bash" ;;
  esac
  if [ -f "hooks/$file" ]; then
    out=$(printf '%s' "$input" | timeout ${HOOK_TIMEOUT_SECONDS} $runner "hooks/$file" 2>"$TMPDIR/hook.err")
    code=$?
  else
    out=""; code=127; echo "hooks/$file does not exist" > "$TMPDIR/hook.err"
  fi
  printf '%s\t%s\t%s\t%s\n' "$file" "$code" "$(printf '%s' "$out" | head -c 20000 | base64 -w0)" "$(head -c 600 "$TMPDIR/hook.err" 2>/dev/null | base64 -w0)"
done <<< "$HOOK_FILES"
`;

/** Run a group's hook scripts against one message. Returns each script's exit code and output. */
export async function runHookScripts(
  chatId: number,
  uid: number,
  files: string[],
  eventJson: string,
): Promise<Map<string, HookScriptResult>> {
  const result = await request(chatId, uid, {
    command: HOOK_DISPATCHER,
    env: { HOOK_FILES: files.join('\n') },
    stdin: eventJson,
    timeoutMs: (HOOK_TIMEOUT_SECONDS * files.length + 10) * 1000,
    lane: 'hook',
  });

  const results = new Map<string, HookScriptResult>();
  for (const line of result.stdout.split('\n')) {
    const [file, code, out, err] = line.split('\t');
    if (!file || code === undefined) continue;
    results.set(file, {
      code: Number(code),
      stdout: Buffer.from(out ?? '', 'base64').toString('utf8'),
      stderr: Buffer.from(err ?? '', 'base64').toString('utf8'),
    });
  }
  return results;
}

/** Render a command result the way the model should see it. */
export function describeResult(result: SandboxResult): string {
  const parts: string[] = [];
  if (result.timedOut) parts.push('The command was stopped because it ran past its time limit.');
  if (result.writeBlocked) {
    parts.push('The workspace is over its disk quota, so this command could not write any files. Delete what you no longer need (rm), then try again.');
  } else if (result.overQuota) {
    parts.push('The command was stopped because the workspace went over its disk quota. Delete files you no longer need before writing more.');
  }
  parts.push(`exit code: ${result.code ?? `killed by ${result.signal}`}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)');
  if (result.truncated) parts.push('(output was cut off; write large results to a file instead)');
  if (result.quotaBytes && result.usageBytes > result.quotaBytes * 0.8) {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    parts.push(`Workspace is using ${mb(result.usageBytes)} MB of its ${mb(result.quotaBytes)} MB quota. Delete files you no longer need.`);
  }
  return parts.join('\n');
}
