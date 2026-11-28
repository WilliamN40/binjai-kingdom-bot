import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-mcp-test-'));
process.env.CLAUDEGRAM_ENV_PATH = path.join(dataDir, 'no-such.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATA_DIR = dataDir;
process.env.SANDBOX_SOCKET = '/run/sandbox/runner.sock';
// Two good entries, then ones that must be ignored: a duplicate, a bad name, the bot's own name, no command.
process.env.SECRETARY_BUILTIN_MCP = 'ntubus=ntubus mcp; weather = npx -y some-weather-mcp --units=metric ;ntubus=other; Bad Name=x; secretary=nope; empty=';

const mcp = await import('../src/secretary/mcp.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('built-in MCP servers come from the deployment setting, and bad entries are skipped', () => {
  const servers = mcp.builtinMcpServers();
  assert.deepEqual(
    servers.map((s) => [s.name, s.command]),
    [
      ['ntubus', 'ntubus mcp'],
      ['weather', 'npx -y some-weather-mcp --units=metric'],
    ],
  );
  assert.match(mcp.describeMcpServer(servers[0]), /\[ntubus\] on, built into this bot/);
});

test('every group gets the built-in servers without adding them', () => {
  const chatId = -1008880001;
  assert.deepEqual(mcp.listMcpServers(chatId), [], 'nothing was added by the group');
  assert.deepEqual(mcp.activeMcpServers(chatId).map((s) => s.name), ['ntubus', 'weather']);

  const configs = mcp.sdkMcpServers(chatId, 20001);
  assert.deepEqual(Object.keys(configs), ['ntubus', 'weather']);
  assert.equal(configs.ntubus.type, 'stdio');
  // Like any group server, it is started inside the sandbox through the bridge, never in the bot.
  assert.match(configs.ntubus.env.MCP_BRIDGE_COMMAND, /^\( ntubus mcp \) 2>>/);
  assert.equal(configs.ntubus.env.MCP_BRIDGE_UID, '20001');
});

test("a group's own server replaces the built-in of the same name, and its own servers come after", () => {
  const chatId = -1008880002;
  mcp.saveMcpServer(chatId, { name: 'ntubus', command: 'node my-own-bus.js', description: 'our fork', tools: ['arrivals'], createdBy: 'Alice' });
  mcp.saveMcpServer(chatId, { name: 'sggov', command: 'npx sggov', description: 'gov data', tools: [], createdBy: 'Alice' });
  const active = mcp.activeMcpServers(chatId);
  assert.deepEqual(active.map((s) => [s.name, s.command]), [
    ['weather', 'npx -y some-weather-mcp --units=metric'],
    ['ntubus', 'node my-own-bus.js'],
    ['sggov', 'npx sggov'],
  ]);

  // Switching the group's own copy off does not bring the built-in back behind its back.
  mcp.setMcpEnabled(chatId, 'ntubus', false);
  assert.deepEqual(mcp.activeMcpServers(chatId).map((s) => s.name), ['weather', 'sggov']);
});
