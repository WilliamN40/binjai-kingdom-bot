/**
 * stdio MCP bridge: Claude starts this as an MCP server; it relays bytes to a
 * server running inside the group's sandbox, through the runner's stream mode.
 *
 * Deliberately tiny and standalone: it imports nothing from the bot (no config,
 * no secrets), gets everything it needs from its environment, and only copies
 * stdin to the socket and the socket to stdout.
 *
 * Environment: SANDBOX_SOCKET, MCP_BRIDGE_GROUP, MCP_BRIDGE_UID, MCP_BRIDGE_COMMAND,
 * MCP_BRIDGE_ENV (JSON object of the group's own variables).
 */

import * as net from 'net';

const socketPath = process.env.SANDBOX_SOCKET ?? '';
const group = process.env.MCP_BRIDGE_GROUP ?? '';
const uid = Number(process.env.MCP_BRIDGE_UID);
const command = process.env.MCP_BRIDGE_COMMAND ?? '';
let env: Record<string, string> = {};
try {
  env = JSON.parse(process.env.MCP_BRIDGE_ENV || '{}') as Record<string, string>;
} catch {
  env = {};
}

if (!socketPath || !group || !Number.isInteger(uid) || !command) {
  process.stderr.write('mcp-bridge: missing configuration\n');
  process.exit(1);
}

const socket = net.createConnection(socketPath);
socket.on('connect', () => {
  socket.write(JSON.stringify({ group, uid, command, env, stream: true }) + '\n');
  process.stdin.pipe(socket);
});
socket.pipe(process.stdout);
socket.on('error', (error) => {
  process.stderr.write(`mcp-bridge: ${error.message}\n`);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
