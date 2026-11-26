/**
 * Checks that a question interrupted by a restart is answered on the next start.
 * Runs inside the bot container with a throwaway data directory and a stand-in
 * for Telegram, so nothing is posted to any real chat.
 *
 *   sudo docker exec -i -e DATA_DIR=/tmp/resume-data binjaibot node --input-type=module - < scripts/resume-check.mjs
 */

import * as fs from 'node:fs';

const dataDir = process.env.DATA_DIR;
if (!dataDir || dataDir === '/data') throw new Error('Run this with DATA_DIR pointing at a throwaway directory.');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(`${dataDir}/pending`, { recursive: true });
fs.writeFileSync(
  `${dataDir}/state.json`,
  JSON.stringify({ ownerIds: [], groups: { '-1': { chatId: -1, title: 'placeholder', enabled: false, enabledAt: new Date().toISOString(), enabledBy: 0, sandboxUid: 29600 } } }),
);

const group = await import('/app/dist/secretary/group.js');
const state = await import('/app/dist/secretary/state.js');
const transcript = await import('/app/dist/secretary/transcript.js');

const CHAT = -1009000000888;
const OTHER = -1009000000889;
state.enableGroup(CHAT, { title: 'Resume Test', enabledBy: 1 });

const now = Math.floor(Date.now() / 1000);
const pending = (chatId, messageId, extra = {}) => ({
  msg: {
    message_id: messageId,
    date: now,
    chat: { id: chatId, type: 'supergroup', title: 'Resume Test' },
    from: { id: 1, is_bot: false, first_name: 'Tester', username: 'tester' },
    text: '@bot what is 17 times 3? Reply with just the number.',
  },
  ask: { question: 'What is 17 times 3? Reply with just the number.' },
  startedAt: new Date().toISOString(),
  attempts: 1,
  ...extra,
});
const write = (name, value) => fs.writeFileSync(`${dataDir}/pending/${name}.json`, JSON.stringify(value));

write(`${CHAT}_5`, pending(CHAT, 5)); // interrupted a moment ago: must be answered
write(`${CHAT}_6`, pending(CHAT, 6, { startedAt: new Date(Date.now() - 3600_000).toISOString() })); // an hour old: dropped
write(`${CHAT}_7`, pending(CHAT, 7, { attempts: 2 })); // already retried once: dropped
write(`${OTHER}_8`, pending(OTHER, 8)); // group not enabled: dropped
fs.writeFileSync(`${dataDir}/pending/broken.json`, '{not json'); // unreadable: dropped

// Stand-in for Telegram: records what the bot would have sent.
const sent = [];
let nextId = 100;
const api = {
  sendMessage: async (chatId, text, options) => {
    sent.push({ chatId, text, replyTo: options?.reply_parameters?.message_id });
    return { message_id: nextId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' } };
  },
  sendChatAction: async () => true,
  setMessageReaction: async () => true,
  sendDocument: async () => ({ message_id: nextId++, date: now, chat: { id: CHAT, type: 'supergroup' } }),
};
const me = { id: 9, is_bot: true, first_name: 'Test', username: 'testbot' };

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const resumed = group.resumePendingAnswers(api, me);
check('only the recent, not-yet-retried question for an enabled group is resumed', resumed === 1, `resumed ${resumed}`);
check('it counts as an answer in progress', group.answersInFlight() === 1);
check('the others are discarded', fs.readdirSync(`${dataDir}/pending`).join(',') === `${CHAT}_5.json`, fs.readdirSync(`${dataDir}/pending`).join(','));

const started = Date.now();
while (group.answersInFlight() > 0 && Date.now() - started < 150_000) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

check('the resumed question was answered', sent.length === 1 && /\b51\b/.test(sent[0].text), JSON.stringify(sent).slice(0, 300));
check('as a reply to the original message', sent[0]?.replyTo === 5 && sent[0]?.chatId === CHAT);
check('nothing is left pending afterwards', fs.readdirSync(`${dataDir}/pending`).length === 0 && group.answersInFlight() === 0);
const recorded = fs.readFileSync(`${transcript.groupDir(CHAT)}/transcript/${transcript.localTime(new Date()).day}.txt`, 'utf8');
check('and the answer went into the record', /reply to msg 5 by Tester\]: .*51/.test(recorded));

transcript.flushMembers();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'All resume checks passed.' : `${failures} resume check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
