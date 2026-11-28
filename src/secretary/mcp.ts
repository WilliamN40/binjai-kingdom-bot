/**
 * MCP servers a group adds from the chat.
 *
 * A server is a command that speaks MCP over stdio, run inside the group's
 * sandbox (an npm or pip package, a script in the workspace, or a proxy such
 * as mcp-remote for a server on the web). Nothing a group adds ever runs in
 * the bot's own container: Claude starts mcp-bridge.js, which only relays
 * bytes to the sandbox runner's stream mode, so the server has exactly the
 * group's network access, files and secrets and nothing more.
 *
 * Which servers exist is kept on the bot's side, in the group's mcp.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { runInSandbox } from './sandbox.js';
import { secretEnv } from './secrets.js';
import { groupDir } from './transcript.js';

export interface McpServer {
  name: string;
  /** Shell command, run in the workspace, that starts the server on stdio. */
  command: string;
  description: string;
  enabled: boolean;
  /** Tool names the server reported when it was added. */
  tools: string[];
  createdBy: string;
  createdAt: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,30}$/;
const RESERVED = new Set(['secretary']);
const MAX_SERVERS = 10;

const cache = new Map<number, McpServer[]>();

function filePath(chatId: number): string {
  return path.join(groupDir(chatId), 'mcp.json');
}

function load(chatId: number): McpServer[] {
  let servers = cache.get(chatId);
  if (!servers) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath(chatId), 'utf8'));
      servers = Array.isArray(raw) ? (raw as McpServer[]) : [];
    } catch {
      servers = [];
    }
    cache.set(chatId, servers);
  }
  return servers;
}

function save(chatId: number): void {
  fs.mkdirSync(groupDir(chatId), { recursive: true });
  atomicWriteFileSync(filePath(chatId), JSON.stringify(load(chatId), null, 2));
}

export function listMcpServers(chatId: number): McpServer[] {
  return [...load(chatId)];
}

/**
 * Servers that ship with this deployment and are on for every group, from
 * SECRETARY_BUILTIN_MCP ("name=command; other=command"). The commands are tools
 * installed in the sandbox image, so they survive a workspace or machine reset.
 * A group that adds its own server under the same name replaces the built-in one.
 */
export function builtinMcpServers(): McpServer[] {
  const servers: McpServer[] = [];
  for (const entry of config.SECRETARY_BUILTIN_MCP.split(';')) {
    const cut = entry.indexOf('=');
    if (cut === -1) continue;
    const name = entry.slice(0, cut).trim().toLowerCase();
    const command = entry.slice(cut + 1).trim();
    if (!command || mcpNameProblem(name) || servers.some((s) => s.name === name)) continue;
    servers.push({ name, command, description: 'built into this bot', enabled: true, tools: [], createdBy: 'the bot', createdAt: '' });
  }
  return servers;
}

/** What a group can actually use right now: the built-in servers plus its own enabled ones. */
export function activeMcpServers(chatId: number): McpServer[] {
  const own = load(chatId);
  const builtin = builtinMcpServers().filter((b) => !own.some((s) => s.name === b.name));
  return [...builtin, ...own.filter((s) => s.enabled)];
}

export function mcpNameProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) return 'A server name is 2-31 characters: lowercase letters, digits, "-" and "_", starting with a letter.';
  if (RESERVED.has(name)) return `"${name}" is taken by the bot's own tools.`;
  return undefined;
}

export function saveMcpServer(
  chatId: number,
  input: { name: string; command: string; description: string; tools: string[]; createdBy: string },
): McpServer {
  const name = input.name.trim().toLowerCase();
  const problem = mcpNameProblem(name);
  if (problem) throw new Error(problem);
  const command = input.command.trim();
  if (!command || command.length > 2000) throw new Error('The command must be 1-2000 characters.');
  const servers = load(chatId);
  const existing = servers.find((s) => s.name === name);
  if (!existing && servers.length >= MAX_SERVERS) throw new Error(`This group already has ${MAX_SERVERS} MCP servers. Remove one first.`);
  const server: McpServer = {
    name,
    command,
    description: input.description.trim().slice(0, 300),
    enabled: true,
    tools: input.tools.slice(0, 100),
    createdBy: input.createdBy,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  if (existing) Object.assign(existing, server);
  else servers.push(server);
  save(chatId);
  return server;
}

export function setMcpEnabled(chatId: number, name: string, enabled: boolean): McpServer | undefined {
  const server = load(chatId).find((s) => s.name === name.trim().toLowerCase());
  if (!server) return undefined;
  server.enabled = enabled;
  save(chatId);
  return server;
}

export function removeMcpServer(chatId: number, name: string): McpServer | undefined {
  const servers = load(chatId);
  const index = servers.findIndex((s) => s.name === name.trim().toLowerCase());
  if (index === -1) return undefined;
  const [removed] = servers.splice(index, 1);
  save(chatId);
  return removed;
}

export function forgetMcpServers(chatId: number): void {
  cache.delete(chatId);
}

export function describeMcpServer(server: McpServer): string {
  if (!server.createdAt) return `[${server.name}] on, built into this bot (its tools are mcp__${server.name}__*; it cannot be removed from the chat)`;
  const tools = server.tools.length ? server.tools.slice(0, 12).join(', ') + (server.tools.length > 12 ? ', …' : '') : 'no tools';
  return `[${server.name}] ${server.enabled ? 'on' : 'off'}, by ${server.createdBy}: ${server.description} (tools: ${tools})`;
}

/** The server's command as it runs in the sandbox: its stderr goes to a log the secretary can read. */
function wrappedCommand(server: { name: string; command: string }): string {
  return `( ${server.command} ) 2>>"$TMPDIR/mcp-${server.name}.log"`;
}

/** How Claude starts the bridge: compiled JavaScript in production, TypeScript through tsx in development. */
function bridgeLaunch(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, 'mcp-bridge.js');
  if (fs.existsSync(js)) return { command: process.execPath, args: [js] };
  return { command: process.execPath, args: ['--import', 'tsx', path.join(here, 'mcp-bridge.ts')] };
}

/** The group's enabled servers, as Claude Agent SDK stdio server configs (all going through the bridge). */
export function sdkMcpServers(chatId: number, uid: number): Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> {
  const launch = bridgeLaunch();
  const result: Record<string, { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }> = {};
  for (const server of activeMcpServers(chatId)) {
    result[server.name] = {
      type: 'stdio',
      command: launch.command,
      args: launch.args,
      env: {
        SANDBOX_SOCKET: config.SANDBOX_SOCKET,
        MCP_BRIDGE_GROUP: path.basename(groupDir(chatId)),
        MCP_BRIDGE_UID: String(uid),
        MCP_BRIDGE_COMMAND: wrappedCommand(server),
        // The group's own secrets, for the server's environment (never the bot's).
        MCP_BRIDGE_ENV: JSON.stringify(secretEnv(chatId)),
      },
    };
  }
  return result;
}

/**
 * Start a server once in the sandbox, ask for its tools, and stop it. Run with a small
 * Python driver so a server that never exits on its own still gives a quick answer.
 */
const PROBE = String.raw`
import json, os, subprocess, threading, time
err_path = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'mcp-probe.err')
p = subprocess.Popen(['bash', '-c', os.environ['MCP_CMD']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(err_path, 'wb'))
def send(o):
    p.stdin.write((json.dumps(o) + '\n').encode()); p.stdin.flush()
lines = []
def reader():
    for line in p.stdout: lines.append(line)
threading.Thread(target=reader, daemon=True).start()
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "secretary-probe", "version": "1"}}})
result = {"error": "the server did not answer"}
deadline = time.time() + int(os.environ.get('MCP_WAIT', '90'))
stage = 1
while time.time() < deadline and stage < 3:
    while lines and stage < 3:
        try: msg = json.loads(lines.pop(0))
        except Exception: continue
        if msg.get('id') == 1 and stage == 1:
            if 'error' in msg:
                result = {"error": json.dumps(msg['error'])[:500]}; stage = 3; break
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            stage = 2
        elif msg.get('id') == 2:
            result = {"tools": [t.get('name') for t in msg.get('result', {}).get('tools', [])]} if 'result' in msg else {"error": json.dumps(msg.get('error'))[:500]}
            stage = 3
    if p.poll() is not None and not lines:
        time.sleep(0.3)
        if not lines: break
    time.sleep(0.1)
p.kill()
if 'error' in result:
    try: result['stderr'] = open(err_path, errors='replace').read()[-1500:]
    except Exception: pass
print(json.dumps(result))
`;

export async function probeMcpServer(
  chatId: number,
  uid: number,
  server: { name: string; command: string },
): Promise<{ tools: string[] } | { error: string }> {
  const result = await runInSandbox(chatId, uid, 'python3 -c "$MCP_PROBE"', 120, {
    MCP_PROBE: PROBE,
    MCP_CMD: server.command,
  });
  const last = result.stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed = JSON.parse(last) as { tools?: string[]; error?: string; stderr?: string };
    if (parsed.tools) return { tools: parsed.tools.filter((t): t is string => typeof t === 'string') };
    return { error: `${parsed.error ?? 'no answer'}${parsed.stderr ? `\nIts error output:\n${parsed.stderr}` : ''}` };
  } catch {
    return { error: `The test did not finish: ${(result.stderr || result.stdout).slice(-800) || `exit ${result.code}`}` };
  }
}
