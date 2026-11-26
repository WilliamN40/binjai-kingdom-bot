/**
 * End-to-end check of the features Claude drives itself: writing a daily digest,
 * building and registering a hook, scheduling a script and a task with its own
 * effort level, plus the backup archive. Uses a throwaway data directory and a
 * stand-in for Telegram; nothing is posted anywhere.
 *
 *   sudo docker exec -i -e DATA_DIR=/tmp/features-data binjaibot node --input-type=module - < scripts/features-check.mjs
 */

import * as fs from 'node:fs';

const dataDir = process.env.DATA_DIR;
if (!dataDir || dataDir === '/data') throw new Error('Run this with DATA_DIR pointing at a throwaway directory.');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  `${dataDir}/state.json`,
  JSON.stringify({ ownerIds: [4242], groups: { '-1': { chatId: -1, title: 'placeholder', enabled: false, enabledAt: new Date().toISOString(), enabledBy: 0, sandboxUid: 29800 } } }),
);

const { askSecretary } = await import('/app/dist/secretary/agent.js');
const group = await import('/app/dist/secretary/group.js');
const state = await import('/app/dist/secretary/state.js');
const hooks = await import('/app/dist/secretary/hooks.js');
const schedule = await import('/app/dist/secretary/schedule.js');
const digest = await import('/app/dist/secretary/digest.js');
const backup = await import('/app/dist/secretary/backup.js');
const sandbox = await import('/app/dist/secretary/sandbox.js');
const transcript = await import('/app/dist/secretary/transcript.js');

const CHAT = -1009000000666;
const groupState = state.enableGroup(CHAT, { title: 'Features Test', enabledBy: 1, isForum: true });
const uid = state.sandboxUidFor(CHAT);

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).trim().split('\n').join('\n        ')}` : ''}`);
};

const calls = [];
const api = {
  sendMessage: async (chatId, text) => { calls.push({ method: 'sendMessage', chatId, text }); return { message_id: 900, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' } }; },
  sendDocument: async (chatId, file, options) => { calls.push({ method: 'sendDocument', chatId, caption: options?.caption }); return { message_id: 901, date: 0, chat: { id: chatId } }; },
  setMessageReaction: async (chatId, messageId, reaction) => { calls.push({ method: 'setMessageReaction', messageId, emoji: reaction?.[0]?.emoji }); return true; },
  sendChatAction: async () => true,
};
const me = { id: 9, is_bot: true, first_name: 'Test', username: 'testbot' };

async function ask(question, extra = {}) {
  const result = await askSecretary({ group: groupState, botName: 'Sekre Korporat', asker: 'William (@will)', question, topic: 'General', ...extra });
  console.log(`\nQ: ${question}\nA: ${result.text.replace(/\n/g, '\n   ')}\n   (${(result.durationMs / 1000).toFixed(1)}s, ${result.turns} turns, $${result.costUsd?.toFixed(4)}, tools: ${result.toolsUsed.join(', ') || 'none'})`);
  return result;
}

try {
  // ── Daily digest ─────────────────────────────────────────────────
  const yesterday = new Date(Date.now() - 86_400_000);
  const day = transcript.localTime(yesterday).day;
  const say = (minute, topic, body) => transcript.appendTranscript(CHAT, new Date(yesterday.getTime() + minute * 60_000), body, topic);
  say(0, 'Events', 'Alice Tan (@alice) [msg 101]: booked Sakura Hall for the year-end dinner, 14 Dec 7pm');
  say(1, 'Events', 'Bob Lee (@bob) [msg 102, reply to msg 101 by Alice Tan]: mantap. budget $35 per head ya');
  say(2, 'Events', 'Alice Tan (@alice) [msg 103]: yes, Chandra is collecting, PayNow him by 5 Dec');
  say(3, 'General', 'Dewi (@dewi) [msg 104]: careerhub deploy is broken again jir, the data model migration failed');
  say(4, 'General', 'Bob Lee (@bob) [msg 105, reply to msg 104 by Dewi]: I will fix the migration tonight');
  say(5, 'General', 'Dewi (@dewi) [msg 106]: PR is here https://github.com/example/careerhub/pull/42');
  transcript.appendTranscript(CHAT, new Date(), 'Alice Tan (@alice) [msg 200]: morning all', 'General');

  const written = await digest.writeMissingDigests();
  const digestText = fs.existsSync(transcript.digestPath(CHAT, day)) ? fs.readFileSync(transcript.digestPath(CHAT, day), 'utf8') : '';
  console.log(`\n--- digest for ${day} ---\n${digestText}---`);
  check('a digest is written for the finished day, and not for today', written === 1 && transcript.listDigestDays(CHAT).join() === day);
  check('it keeps the facts a later search needs', /Sakura Hall/.test(digestText) && /14 Dec/.test(digestText) && /careerhub/i.test(digestText) && /Chandra/.test(digestText) && /pull\/42/.test(digestText));
  check('a second pass writes nothing new', (await digest.writeMissingDigests()) === 0);

  let r = await ask('Where is the year-end dinner? Answer in one line.');
  check('the secretary answers from yesterday using the digest', /Sakura Hall/.test(r.text));

  // ── Claude builds a hook ─────────────────────────────────────────
  r = await ask('Make a hook that reacts with 👍 to any message containing the word "deploy" (whole word, any case). Name it deploy-thumbs.');
  const hook = hooks.listHooks(CHAT).find((h) => h.name === 'deploy-thumbs');
  check('it wrote, tested and registered the hook', Boolean(hook?.enabled) && r.toolsUsed.includes('write_file') && r.toolsUsed.includes('hook_save'), hook ? hooks.describeHook(hook) : 'no hook registered');

  const message = (id, text) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'supergroup', title: 'Features Test' }, from: { id: 1, is_bot: false, first_name: 'Tester' }, text });
  calls.length = 0;
  await group.runHooksOnMessage(api, me, groupState, message(301, 'can someone Deploy the fix?'), 'General', false);
  await group.runHooksOnMessage(api, me, groupState, message(302, 'redeployment is a different word'), 'General', false);
  await group.runHooksOnMessage(api, me, groupState, message(303, 'lunch?'), 'General', false);
  check('the hook it wrote behaves as asked on real messages', calls.length === 1 && calls[0].method === 'setMessageReaction' && calls[0].messageId === 301 && calls[0].emoji === '👍', JSON.stringify(calls));

  // ── Claude schedules a script and a task with its own effort ─────
  r = await ask('Write a script that prints how many files are in the workspace, and schedule it to run every 10 minutes without using Claude. Also schedule a task every day at 8am, at high effort, with the instruction "Post a short good-morning summary of yesterday".');
  const schedules = schedule.listSchedules(CHAT);
  const script = schedules.find((s) => s.kind === 'script');
  const task = schedules.find((s) => s.kind === 'task');
  check('it scheduled a script (no Claude) and a task that carries its own effort', Boolean(script) && task?.effort === 'high' && task?.cron === '0 8 * * *', schedules.map(schedule.describeSchedule).join('\n'));

  if (script) {
    calls.length = 0;
    await group.createScheduleDeliverer(api, me)(CHAT, script);
    check('the scheduled script it wrote runs and posts its output', calls.length === 1 && /\d/.test(calls[0].text), JSON.stringify(calls));
  }

  // ── Backup ───────────────────────────────────────────────────────
  calls.length = 0;
  const size = await backup.sendBackup(api, 'test');
  check('a backup archive of the records is sent to the owner', size > 200 && calls.length === 1 && calls[0].method === 'sendDocument' && calls[0].chatId === 4242, `${size} bytes`);
  check('and the time of the backup is remembered', Date.now() - (state.getLastBackupAt()?.getTime() ?? 0) < 60_000);
} catch (error) {
  failures++;
  console.log(`ERROR: ${error.stack || error.message}`);
} finally {
  await sandbox.clearSandbox(CHAT, uid).catch(() => {});
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All feature checks passed.' : `${failures} feature check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
