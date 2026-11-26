/**
 * End-to-end check of the deployed bot image: a real question goes to Claude,
 * which has to use the sandbox, the scheduler and the notes to answer it.
 * Runs inside the bot container against a throwaway data directory, so the
 * live bot's state and records are not touched.
 *
 *   sudo docker exec -i -e DATA_DIR=/tmp/e2e-data binjaibot node --input-type=module - < scripts/e2e-check.mjs
 */

import * as fs from 'node:fs';

const dataDir = process.env.DATA_DIR;
if (!dataDir || dataDir === '/data') throw new Error('Run this with DATA_DIR pointing at a throwaway directory.');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
// Start the test group's sandbox user high up, well away from real groups.
fs.writeFileSync(
  `${dataDir}/state.json`,
  JSON.stringify({ ownerIds: [], groups: { '-1': { chatId: -1, title: 'placeholder', enabled: false, enabledAt: new Date().toISOString(), enabledBy: 0, sandboxUid: 29500 } } }),
);

const { askSecretary } = await import('/app/dist/secretary/agent.js');
const state = await import('/app/dist/secretary/state.js');
const transcript = await import('/app/dist/secretary/transcript.js');
const schedule = await import('/app/dist/secretary/schedule.js');
const sandbox = await import('/app/dist/secretary/sandbox.js');

const CHAT = -1009000000777;
const group = state.enableGroup(CHAT, { title: 'E2E Test', enabledBy: 1, isForum: true });
const uid = state.sandboxUidFor(CHAT);

const now = Date.now();
const people = ['Alice Tan (@alice)', 'Bob Lee (@bob)', 'Chandra (@chan)'];
const counts = [7, 4, 2];
let id = 100;
people.forEach((person, p) => {
  for (let i = 0; i < counts[p]; i++) {
    transcript.appendTranscript(CHAT, new Date(now - 3600_000 + id * 1000), `${person} [msg ${id++}]: message number ${i} about the dinner`, p === 0 ? 'Events' : 'General');
  }
});

const sent = [];
let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).trim().split('\n').join('\n        ')}` : ''}`);
};

async function ask(question) {
  const result = await askSecretary({
    group,
    botName: 'Sekre Korporat',
    asker: 'William (@will)',
    question,
    topic: 'General',
    threadId: undefined,
    sendFile: async (data, name, caption) => {
      sent.push({ name, bytes: data.length, caption, head: data.subarray(0, 120).toString('utf8') });
    },
  });
  console.log(`\nQ: ${question}\nA: ${result.text.replace(/\n/g, '\n   ')}\n   (${(result.durationMs / 1000).toFixed(1)}s, ${result.turns} turns, $${result.costUsd?.toFixed(4)}, tools: ${result.toolsUsed.join(', ') || 'none'})`);
  return result;
}

try {
  let r = await ask('Make a CSV file called counts.csv with one row per person and how many messages each has sent (columns: name,messages), and send it to the chat.');
  check('it used the sandbox and sent a file back', r.toolsUsed.includes('send_file') && sent.length === 1 && sent[0].name === 'counts.csv', JSON.stringify(sent[0] ?? null));
  check('the file has the right numbers', sent[0] && /Alice[^\n]*7/.test(sent[0].head) && /Bob[^\n]*4/.test(sent[0].head) && /Chandra[^\n]*2/.test(sent[0].head));

  r = await ask('Use your workspace to download https://example.com and tell me the exact text inside its <h1> tag. Also tell me the Python version there.');
  check('it can use the internet from the sandbox', r.toolsUsed.includes('run_command') && /Example Domain/.test(r.text) && /3\.\d+/.test(r.text));

  r = await ask('Remind us every Monday at 9am to submit attendance, and also remind us once tomorrow at 8:30pm that dinner payment is due. Also remember that the treasurer is Chandra.');
  const schedules = schedule.listSchedules(CHAT);
  check('it created a recurring and a one-off reminder', schedules.length === 2 && schedules.some((s) => s.cron === '0 9 * * 1') && schedules.some((s) => s.at && /T20:30/.test(s.at)), schedules.map(schedule.describeSchedule).join('\n'));
  check('it saved the note', /Chandra/.test(transcript.readNotes(CHAT)), transcript.readNotes(CHAT));

  r = await ask('What reminders do we have, and who is the treasurer? Then cancel the Monday one.');
  check('it sees schedules and notes, and can cancel', /Chandra/.test(r.text) && schedule.listSchedules(CHAT).length === 1, schedule.listSchedules(CHAT).map(schedule.describeSchedule).join('\n'));
} catch (error) {
  failures++;
  console.log(`ERROR: ${error.message}`);
} finally {
  await sandbox.clearSandbox(CHAT, uid).catch(() => {});
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All end-to-end checks passed.' : `${failures} end-to-end check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
