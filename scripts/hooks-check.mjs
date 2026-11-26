/**
 * Checks hooks and scheduled scripts against the real sandbox, with a stand-in
 * for Telegram and a throwaway data directory. Nothing is posted anywhere.
 *
 *   sudo docker exec -i -e DATA_DIR=/tmp/hooks-data binjaibot node --input-type=module - < scripts/hooks-check.mjs
 */

import * as fs from 'node:fs';

const dataDir = process.env.DATA_DIR;
if (!dataDir || dataDir === '/data') throw new Error('Run this with DATA_DIR pointing at a throwaway directory.');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  `${dataDir}/state.json`,
  JSON.stringify({ ownerIds: [], groups: { '-1': { chatId: -1, title: 'placeholder', enabled: false, enabledAt: new Date().toISOString(), enabledBy: 0, sandboxUid: 29700 } } }),
);

const group = await import('/app/dist/secretary/group.js');
const state = await import('/app/dist/secretary/state.js');
const hooks = await import('/app/dist/secretary/hooks.js');
const sandbox = await import('/app/dist/secretary/sandbox.js');
const transcript = await import('/app/dist/secretary/transcript.js');

const CHAT = -1009000000999;
const groupState = state.enableGroup(CHAT, { title: 'Hooks Test', enabledBy: 1 });
const uid = state.sandboxUidFor(CHAT);

// Stand-in for Telegram: records every call the bot would have made.
const calls = [];
let nextId = 500;
const sentMessage = (chatId) => ({ message_id: nextId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'supergroup' } });
const api = {
  sendMessage: async (chatId, text, options) => { calls.push({ method: 'sendMessage', text, replyTo: options?.reply_parameters?.message_id }); return sentMessage(chatId); },
  deleteMessage: async (chatId, messageId) => { calls.push({ method: 'deleteMessage', messageId }); return true; },
  setMessageReaction: async (chatId, messageId, reaction) => { calls.push({ method: 'setMessageReaction', messageId, emoji: reaction?.[0]?.emoji }); return true; },
  pinChatMessage: async (chatId, messageId) => { calls.push({ method: 'pinChatMessage', messageId }); return true; },
  sendChatAction: async () => true,
};
const me = { id: 9, is_bot: true, first_name: 'Test', username: 'testbot' };

let id = 10;
const message = (text) => ({
  message_id: id++,
  date: Math.floor(Date.now() / 1000),
  chat: { id: CHAT, type: 'supergroup', title: 'Hooks Test' },
  from: { id: 1, is_bot: false, first_name: 'Tester', username: 'tester' },
  text,
});

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
};
const write = (file, content) => sandbox.writeSandboxFile(CHAT, uid, file, content);

try {
  // ── Tools ────────────────────────────────────────────────────────
  let r = await sandbox.runInSandbox(CHAT, uid, 'gh --version | head -1 && git --version && gh auth status 2>&1 | head -3; true');
  check('git and the GitHub CLI are installed', /gh version/.test(r.stdout) && /git version/.test(r.stdout), r.stdout.trim());

  // ── Hook scripts ─────────────────────────────────────────────────
  await write('hooks/no_emma.py', `import sys, json, re
event = json.load(sys.stdin)
if re.search(r"\\bemma\\b", event["text"], re.I):
    print(json.dumps({"actions": [{"do": "delete"}, {"do": "send", "text": "Removed a message from " + event["from"]["name"] + "."}]}))
`);
  await write('hooks/gh_fire.js', `let s = ''; process.stdin.on('data', d => s += d).on('end', () => {
  const event = JSON.parse(s);
  if (event.links.some(l => l.includes('github.com'))) console.log(JSON.stringify({ do: 'react', emoji: '🔥' }));
});
`);
  await write('hooks/slow.sh', 'sleep 20\necho \'{"do":"pin"}\'\n');
  await write('hooks/broken.py', 'print("this is not json")\n');
  await write('hooks/quiet.py', 'import sys; sys.stdin.read()\n');

  for (const [name, file] of [['no-emma', 'no_emma.py'], ['gh-fire', 'gh_fire.js'], ['slow', 'slow.sh'], ['broken', 'broken.py'], ['quiet', 'quiet.py']]) {
    hooks.saveHook(CHAT, { name, file, description: `test hook ${name}`, createdBy: 'Tester' });
  }

  // A long command of the secretary's, started first: hooks must neither wait for it nor kill it.
  const longCommand = sandbox.runInSandbox(CHAT, uid, 'sleep 12; echo long-command-survived', 60);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const started = Date.now();
  const emma = message('has anyone seen Emma today?');
  let acted = await group.runHooksOnMessage(api, me, groupState, emma, undefined, false);
  const elapsed = Date.now() - started;
  check('hooks run beside a long command instead of waiting behind it', elapsed < 11_000, `${elapsed} ms for five hooks, one of which times out after 5s`);
  check('a matching hook deletes the message and posts a notice', acted === 1 && calls.some((c) => c.method === 'deleteMessage' && c.messageId === emma.message_id) && calls.some((c) => c.method === 'sendMessage' && /Removed a message from Tester/.test(c.text)), JSON.stringify(calls));
  check('the removal is noted in the record', /was removed by the hook "no-emma"/.test(fs.readFileSync(`${transcript.groupDir(CHAT)}/transcript/${transcript.localTime(new Date()).day}.txt`, 'utf8')));

  const listed = Object.fromEntries(hooks.listHooks(CHAT).map((h) => [h.name, h.lastError ?? null]));
  check('a hook that runs too long is cut off and marked', listed.slow === 'timed out', JSON.stringify(listed));
  check('a hook that prints something unreadable is marked', /not JSON/.test(listed.broken ?? ''));
  check('working hooks carry no error', listed['no-emma'] === null && listed['gh-fire'] === null && listed.quiet === null);

  calls.length = 0;
  hooks.setHookEnabled(CHAT, 'slow', false);
  hooks.setHookEnabled(CHAT, 'broken', false);
  const link = message('check https://github.com/WilliamN40/binjai-kingdom-bot');
  acted = await group.runHooksOnMessage(api, me, groupState, link, undefined, false);
  check('a second hook reacts to a GitHub link', acted === 1 && calls.length === 1 && calls[0].method === 'setMessageReaction' && calls[0].emoji === '🔥' && calls[0].messageId === link.message_id, JSON.stringify(calls));

  calls.length = 0;
  acted = await group.runHooksOnMessage(api, me, groupState, message('anyone up for lunch?'), undefined, false);
  check('an ordinary message triggers nothing', acted === 0 && calls.length === 0, JSON.stringify(calls));

  calls.length = 0;
  for (const hook of hooks.listHooks(CHAT)) hooks.setHookEnabled(CHAT, hook.name, false);
  acted = await group.runHooksOnMessage(api, me, groupState, message('emma again'), undefined, false);
  check('hooks that are switched off do nothing', acted === 0 && calls.length === 0);

  r = await longCommand;
  check('the long command was not killed by the hooks finishing', r.stdout.includes('long-command-survived'), `exit ${r.code}, ${r.stdout.trim()}`);

  // ── Scheduled scripts ────────────────────────────────────────────
  await write('scripts/hello.py', 'print("3 new pull requests today")\n');
  await write('scripts/nothing.py', 'pass\n');
  await write('scripts/fails.py', 'import sys\nsys.stderr.write("could not reach the API\\n")\nsys.exit(3)\n');
  const deliver = group.createScheduleDeliverer(api, me);
  const scheduled = (text) => ({ id: 'ab12', kind: 'script', text, nextRun: new Date().toISOString(), createdBy: 'Tester', createdAt: new Date().toISOString() });

  calls.length = 0;
  await deliver(CHAT, scheduled('scripts/hello.py'));
  check('a scheduled script posts what it prints', calls.length === 1 && calls[0].text.trim() === '3 new pull requests today', JSON.stringify(calls));

  calls.length = 0;
  await deliver(CHAT, scheduled('scripts/nothing.py'));
  check('a scheduled script that prints nothing posts nothing', calls.length === 0, JSON.stringify(calls));

  calls.length = 0;
  await deliver(CHAT, scheduled('scripts/fails.py'));
  check('a failing scheduled script reports why', calls.length === 1 && /failed: could not reach the API/.test(calls[0].text), JSON.stringify(calls));
} catch (error) {
  failures++;
  console.log(`ERROR: ${error.stack || error.message}`);
} finally {
  await sandbox.clearSandbox(CHAT, uid).catch(() => {});
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All hook and scheduled-script checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
