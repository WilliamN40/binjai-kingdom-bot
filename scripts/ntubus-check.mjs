/**
 * Live check of the NTU bus integration on a deployed bot: the tool inside the
 * sandbox, the MCP connection through the bot's bridge, and the secretary using
 * it to answer and to set an arrival alert. Uses a throwaway data directory and
 * a made-up group; nothing is posted anywhere. Talks to NTU's real bus API.
 *
 *   sudo docker exec -i -e DATA_DIR=/tmp/ntubus-data binjaibot node --input-type=module - < scripts/ntubus-check.mjs
 *
 * With SANDBOX_BACKEND=workbench this creates a machine for the made-up group
 * (binjai-wb-1009000000555); remove it afterwards with docker rm -f.
 */

import * as fs from 'node:fs';

const dataDir = process.env.DATA_DIR;
if (!dataDir || dataDir === '/data') throw new Error('Run this with DATA_DIR pointing at a throwaway directory.');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  `${dataDir}/state.json`,
  JSON.stringify({ ownerIds: [4242], groups: { '-1': { chatId: -1, title: 'placeholder', enabled: false, enabledAt: new Date().toISOString(), enabledBy: 0, sandboxUid: 29900 } } }),
);

const { askSecretary } = await import('/app/dist/secretary/agent.js');
const state = await import('/app/dist/secretary/state.js');
const mcp = await import('/app/dist/secretary/mcp.js');
const schedule = await import('/app/dist/secretary/schedule.js');
const sandbox = await import('/app/dist/secretary/sandbox.js');
const transcript = await import('/app/dist/secretary/transcript.js');

const CHAT = -1009000000555;
const group = state.enableGroup(CHAT, { title: 'Bus Test', enabledBy: 4242 });
const uid = state.sandboxUidFor(CHAT);
transcript.appendTranscript(CHAT, new Date(), 'Tester (@tester) [msg 1]: hello');

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).trim().split('\n').join('\n        ')}` : ''}`);
};

try {
  // ── The tool, inside the sandbox ─────────────────────────────────
  let r = await sandbox.runInSandbox(CHAT, uid, 'ntubus help | head -1 && ntubus routes | cut -c1-90 && ntubus arrivals "Hall 1"', 60);
  check('ntubus is installed in the sandbox and reaches NTU from there', r.code === 0 && /ntubus \d/.test(r.stdout) && /Arrivals at \d\d:\d\d/.test(r.stdout), (r.stdout + r.stderr).slice(0, 900));

  r = await sandbox.runInSandbox(CHAT, uid, 'ntubus plan "Hall 2" "NIE" && ntubus arrivals lwn --json | head -c 300', 60);
  check('trip planning and --json output work there', r.code === 0 && /From Hall 2/.test(r.stdout) && /"found": true/.test(r.stdout), (r.stdout + r.stderr).slice(0, 900));

  // ── The MCP server, through the bot's own bridge ─────────────────
  check('the deployment lists ntubus as a built-in server', mcp.builtinMcpServers().some((s) => s.name === 'ntubus'), JSON.stringify(mcp.builtinMcpServers()));
  check('this group has it without adding anything', mcp.activeMcpServers(CHAT).some((s) => s.name === 'ntubus') && mcp.listMcpServers(CHAT).length === 0);
  const probe = await mcp.probeMcpServer(CHAT, uid, { name: 'ntubus', command: 'ntubus mcp' });
  check('it starts in the sandbox and reports its tools', Array.isArray(probe.tools) && ['arrivals', 'plan_trip', 'live_buses', 'routes', 'notices', 'arrival_alert'].every((t) => probe.tools.includes(t)), JSON.stringify(probe).slice(0, 400));

  // ── The secretary using it ───────────────────────────────────────
  const ask = async (question) => {
    const result = await askSecretary({ group, botName: 'Sekre Korporat', asker: 'William (@will)', askerId: 4242, question });
    console.log(`\nQ: ${question}\nA: ${result.text.replace(/\n/g, '\n   ')}\n   (${(result.durationMs / 1000).toFixed(1)}s, ${result.turns} turns, $${result.costUsd?.toFixed(4)}, tools: ${result.toolsUsed.join(', ') || 'none'})\n`);
    return result;
  };

  let a = await ask('When is the next campus bus at Hall 1, and what is the quickest way from Hall 2 to NIE right now?');
  check('a bus question is answered from the live tools', a.toolsUsed.some((t) => /ntubus__arrivals/.test(t)) && a.toolsUsed.some((t) => /ntubus__plan_trip/.test(t)) && /min/.test(a.text), a.toolsUsed.join(', '));

  a = await ask('Tell me when a Red bus is 4 minutes away from Hall 2. Keep watching for the next 30 minutes.');
  const schedules = schedule.listSchedules(CHAT);
  const alert = schedules.find((s) => s.kind === 'script');
  check('"tell me when the bus is close" becomes a script on a 20-second schedule with an end time', a.toolsUsed.some((t) => /ntubus__arrival_alert/.test(t)) && Boolean(alert) && alert.everySeconds >= 10 && alert.everySeconds <= 30 && Boolean(alert.until), schedules.map(schedule.describeSchedule).join('\n') || 'no schedule was created');

  if (alert) {
    r = await sandbox.runInSandbox(CHAT, uid, `cat "${alert.text}" && echo "--- run:" && bash "${alert.text}"; echo "exit=$?"`, 60);
    check('the alert script runs cleanly (silent unless the bus is close)', /exec ntubus alert --stop 'Hall 2' --within 4/.test(r.stdout) && /exit=0/.test(r.stdout), (r.stdout + r.stderr).slice(0, 600));
  }
} catch (error) {
  failures++;
  console.log(`ERROR: ${error.stack || error.message}`);
} finally {
  await sandbox.clearSandbox(CHAT, uid).catch(() => {});
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All NTU bus checks passed.' : `${failures} NTU bus check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
