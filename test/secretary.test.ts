import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from 'grammy/types';

// Configuration is read from the environment at import time, so set it up first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-test-'));
process.env.CLAUDEGRAM_ENV_PATH = path.join(dataDir, 'no-such.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATA_DIR = dataDir;
process.env.SECRETARY_TIMEZONE = 'Asia/Singapore';
process.env.OWNER_CLAIM_CODE = 'let-me-in';
process.env.ALLOWED_USER_IDS = '';

const { formatMessageBody, describeContent } = await import('../src/secretary/format.js');
const { detectTrigger } = await import('../src/secretary/trigger.js');
const { checkToolUse } = await import('../src/secretary/guard.js');
const schedule = await import('../src/secretary/schedule.js');
const hooks = await import('../src/secretary/hooks.js');
const usage = await import('../src/secretary/usage.js');
const NOTE_TOOL = 'mcp__secretary__save_note';
const transcript = await import('../src/secretary/transcript.js');
const state = await import('../src/secretary/state.js');
const { buildSystemPrompt, messageLinkBase } = await import('../src/secretary/agent.js');

const CHAT = { id: -1001234567890, type: 'supergroup', title: 'Binjai Kingdom', is_forum: true } as const;
const ALICE = { id: 111, is_bot: false, first_name: 'Alice', last_name: 'Tan', username: 'alice' };
const BOB = { id: 222, is_bot: false, first_name: 'Bob' };
const BOT = { id: 999, username: 'binjai_kingdom_bot' };

function message(fields: Record<string, unknown>): Message {
  return { message_id: 1, date: 1795700000, chat: CHAT, from: ALICE, ...fields } as unknown as Message;
}

after(() => {
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── Formatting ───────────────────────────────────────────────────────

test('a plain message records who said what, with its message number', () => {
  const body = formatMessageBody(message({ message_id: 4521, text: 'lunch at 1?' }));
  assert.equal(body, 'Alice Tan (@alice) [msg 4521]: lunch at 1?');
});

test('a reply names the message and person replied to', () => {
  const body = formatMessageBody(
    message({
      message_id: 10,
      text: 'ok',
      reply_to_message: { message_id: 9, date: 1, chat: CHAT, from: BOB, text: 'meet at 5' },
    }),
  );
  assert.equal(body, 'Alice Tan (@alice) [msg 10, reply to msg 9 by Bob]: ok');
});

test('the topic-creation message Telegram attaches inside a topic is not treated as a reply', () => {
  const body = formatMessageBody(
    message({
      message_id: 10,
      text: 'hello',
      is_topic_message: true,
      message_thread_id: 5,
      reply_to_message: { message_id: 5, date: 1, chat: CHAT, from: BOB, forum_topic_created: { name: 'Events', icon_color: 1 } },
    }),
  );
  assert.equal(body, 'Alice Tan (@alice) [msg 10]: hello');
});

test('edits are marked', () => {
  const body = formatMessageBody(message({ message_id: 7, text: 'fixed typo' }), { edited: true });
  assert.equal(body, 'Alice Tan (@alice) [msg 7, EDITED]: fixed typo');
});

test('media, captions, forwards and hidden links are described in text', () => {
  assert.equal(describeContent(message({ photo: [{ file_id: 'x' }], caption: 'the receipt' })), '[photo] the receipt');
  assert.equal(describeContent(message({ document: { file_id: 'x', file_name: 'budget.xlsx' } })), '[file: budget.xlsx]');
  assert.equal(describeContent(message({ voice: { file_id: 'x', duration: 75 } })), '[voice message 1:15]');
  assert.equal(
    describeContent(message({ poll: { question: 'Dinner?', options: [{ text: 'Yes' }, { text: 'No' }] } })),
    '[poll: "Dinner?" options: Yes | No]',
  );
  assert.equal(
    describeContent(message({ text: 'news', forward_origin: { type: 'hidden_user', sender_user_name: 'Carol' } })),
    '[forwarded from Carol] news',
  );
  assert.equal(
    describeContent(
      message({ text: 'sign up here', entities: [{ type: 'text_link', offset: 8, length: 4, url: 'https://example.com/form' }] }),
    ),
    'sign up here (links: https://example.com/form)',
  );
});

test('group events become sentences', () => {
  assert.equal(formatMessageBody(message({ new_chat_members: [ALICE] })), '* Alice Tan joined the group');
  assert.equal(formatMessageBody(message({ from: BOB, new_chat_members: [ALICE] })), '* Bob added Alice Tan to the group');
  assert.equal(formatMessageBody(message({ left_chat_member: ALICE })), '* Alice Tan left the group');
  assert.equal(
    formatMessageBody(message({ forum_topic_created: { name: 'Events', icon_color: 1 } })),
    '* Alice Tan created the topic "Events"',
  );
});

test('anonymous admins and channels are named by their chat', () => {
  const anon = formatMessageBody(message({ from: { id: 1087968824, is_bot: true, first_name: 'Group' }, sender_chat: CHAT, text: 'notice' }));
  assert.equal(anon, 'Anonymous admin [msg 1]: notice');
});

// ── Triggers ─────────────────────────────────────────────────────────

test('ordinary chatter does not trigger the bot', () => {
  assert.equal(detectTrigger(message({ text: 'anyone up for lunch?' }), BOT), null);
});

test('a mention triggers a question with the mention removed', () => {
  const trigger = detectTrigger(
    message({ text: '@Binjai_Kingdom_Bot what did Bob say?', entities: [{ type: 'mention', offset: 0, length: 19 }] }),
    BOT,
  );
  assert.deepEqual(trigger, { kind: 'ask', question: 'what did Bob say?', via: 'mention' });
});

test('mentioning somebody else does not trigger the bot', () => {
  const trigger = detectTrigger(message({ text: '@bob what time?', entities: [{ type: 'mention', offset: 0, length: 4 }] }), BOT);
  assert.equal(trigger, null);
});

test('replying to the bot triggers a question', () => {
  const trigger = detectTrigger(
    message({ text: 'and yesterday?', reply_to_message: { message_id: 3, date: 1, chat: CHAT, from: { id: 999, is_bot: true, first_name: 'S' } } }),
    BOT,
  );
  assert.deepEqual(trigger, { kind: 'ask', question: 'and yesterday?', via: 'reply' });
});

test('commands are parsed, and commands for other bots are ignored', () => {
  assert.deepEqual(
    detectTrigger(message({ text: '/ask who is coming?', entities: [{ type: 'bot_command', offset: 0, length: 4 }] }), BOT),
    { kind: 'command', command: 'ask', args: 'who is coming?' },
  );
  assert.deepEqual(
    detectTrigger(message({ text: '/summary@binjai_kingdom_bot this week', entities: [{ type: 'bot_command', offset: 0, length: 27 }] }), BOT),
    { kind: 'command', command: 'summary', args: 'this week' },
  );
  assert.equal(
    detectTrigger(message({ text: '/ask@other_bot hi', entities: [{ type: 'bot_command', offset: 0, length: 14 }] }), BOT),
    null,
  );
});

// ── Tool guard ───────────────────────────────────────────────────────

test('the agent can read inside its group folder and nowhere else', () => {
  const root = path.join(dataDir, 'guard-root');
  fs.mkdirSync(path.join(root, 'transcript'), { recursive: true });
  const options = { webSearch: true, ownTools: [NOTE_TOOL] };
  const check = (tool: string, input: Record<string, unknown>) => checkToolUse(tool, input, root, options).allowed;

  assert.equal(check('Read', { file_path: 'transcript/2026-11-26.txt' }), true);
  assert.equal(check('Read', { file_path: path.join(root, 'notes.md') }), true);
  assert.equal(check('Grep', { pattern: 'lunch' }), true);
  assert.equal(check('Grep', { pattern: 'lunch', path: 'transcript', glob: '*.txt' }), true);
  assert.equal(check('Glob', { pattern: 'transcript/*.txt' }), true);
  assert.equal(check('WebSearch', { query: 'weather' }), true);
  assert.equal(check(NOTE_TOOL, { note: 'x' }), true);

  assert.equal(check('Read', { file_path: '../group_2/transcript/2026-11-26.txt' }), false);
  assert.equal(check('Read', { file_path: path.join(dataDir, 'state.json') }), false);
  assert.equal(check('Read', { file_path: '/proc/self/environ' }), false);
  assert.equal(check('Read', { file_path: '~/.claude/.credentials.json' }), false);
  assert.equal(check('Read', {}), false);
  assert.equal(check('Grep', { pattern: 'token', path: '/app' }), false);
  assert.equal(check('Grep', { pattern: 'x', glob: '../../**' }), false);
  assert.equal(check('Glob', { pattern: '/etc/**' }), false);
  assert.equal(check('Glob', { pattern: '../**/*.txt' }), false);
  assert.equal(check('Bash', { command: 'cat /etc/passwd' }), false);
  assert.equal(check('Write', { file_path: 'notes.md', content: 'x' }), false);
  assert.equal(check('Edit', { file_path: 'notes.md' }), false);
  assert.equal(check('WebFetch', { url: 'https://example.com' }), false);
  assert.equal(check('mcp__secretary__run_command', { command: 'ls' }), false, 'tools not offered in this run are refused');
  assert.equal(check('mcp__other__anything', {}), false);
  assert.equal(checkToolUse('WebSearch', { query: 'x' }, root, { webSearch: false, ownTools: [] }).allowed, false);
});

// ── Transcript store ─────────────────────────────────────────────────

test('messages land in one daily file per group, in local time, tagged by topic', () => {
  const chatId = -1009990001;
  // 2026-11-26 16:30 UTC is 00:30 on the 27th in Singapore.
  transcript.appendTranscript(chatId, new Date('2026-11-26T15:00:00Z'), 'Alice [msg 1]: before midnight', 'General');
  transcript.appendTranscript(chatId, new Date('2026-11-26T16:30:00Z'), 'Bob [msg 2]: line one\nline two', 'Events');

  const dir = path.join(transcript.groupDir(chatId), 'transcript');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-11-26.txt', '2026-11-27.txt']);
  assert.equal(fs.readFileSync(path.join(dir, '2026-11-26.txt'), 'utf8'), '[2026-11-26 23:00] [#General] Alice [msg 1]: before midnight\n');
  assert.equal(fs.readFileSync(path.join(dir, '2026-11-27.txt'), 'utf8'), '[2026-11-27 00:30] [#Events] Bob [msg 2]: line one ⏎ line two\n');
});

test('recent context spans topics and days, oldest first', () => {
  const context = transcript.recentContext(-1009990001, 10_000, 'Events');
  const lines = context.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[#General\] Alice/);
  assert.match(lines[1], /\[#Events\] Bob/);
});

test('when the budget is tight, the asking topic reaches further back than other topics', () => {
  const chatId = -1009990002;
  const base = Date.parse('2026-11-20T02:00:00Z');
  transcript.appendTranscript(chatId, new Date(base), 'Alice [msg 1]: venue is the hall', 'Events');
  for (let i = 0; i < 40; i++) {
    transcript.appendTranscript(chatId, new Date(base + (i + 1) * 60_000), `Bob [msg ${i + 2}]: unrelated chatter number ${i}`, 'Random');
  }
  const context = transcript.recentContext(chatId, 1200, 'Events');
  assert.match(context, /venue is the hall/);
  assert.match(context, /unrelated chatter number 39/);
  assert.doesNotMatch(context, /unrelated chatter number 0\b/);
});

test('topic names are remembered and cleaned for use in tags', () => {
  const chatId = -1009990003;
  transcript.setTopicName(chatId, 5, 'Events [2026]\n');
  assert.equal(transcript.getTopicName(chatId, 5), 'Events 2026');
  assert.deepEqual(transcript.listTopicNames(chatId), ['Events 2026']);
});

test('notes are appended and read back', () => {
  const chatId = -1009990004;
  transcript.appendNote(chatId, 'AGM is on 12 Dec', 'Alice Tan (@alice)');
  assert.match(transcript.readNotes(chatId), /\(asked by Alice Tan \(@alice\)\) AGM is on 12 Dec$/);
});

test('a group upgraded to a supergroup keeps its record under the new id', () => {
  transcript.appendTranscript(-555, new Date(), 'Alice [msg 1]: hi');
  transcript.migrateGroupData(-555, -1005550000);
  assert.equal(fs.existsSync(transcript.groupDir(-555)), false);
  assert.equal(transcript.transcriptStats(-1005550000).days, 1);
});

// ── Schedules ────────────────────────────────────────────────────────

test('a one-off reminder fires once and is then gone', () => {
  const chatId = -1009990010;
  const created = schedule.createSchedule(chatId, { kind: 'message', text: 'AGM in one hour', at: '2099-01-05T09:00', createdBy: 'Alice' });
  assert.equal(created.nextRun, '2099-01-05T01:00:00.000Z', '09:00 in Singapore is 01:00 UTC');
  assert.equal(schedule.takeDue(chatId, new Date('2099-01-05T00:59:00Z')).length, 0);
  const due = schedule.takeDue(chatId, new Date('2099-01-05T01:00:30Z'));
  assert.deepEqual(due.map((s) => s.text), ['AGM in one hour']);
  assert.equal(schedule.listSchedules(chatId).length, 0);
});

test('a recurring task moves on to its next occurrence after firing', () => {
  const chatId = -1009990011;
  const created = schedule.createSchedule(chatId, { kind: 'task', text: 'Post a weekly recap', cron: '0 9 * * 1', createdBy: 'Alice', topic: 'General' });
  const firstRun = new Date(created.nextRun);
  const due = schedule.takeDue(chatId, new Date(firstRun.getTime() + 5_000));
  assert.equal(due.length, 1);
  const [remaining] = schedule.listSchedules(chatId);
  assert.equal(new Date(remaining.nextRun).getTime() - firstRun.getTime(), 7 * 86_400_000);
  assert.equal(schedule.cancelSchedule(chatId, remaining.id)?.id, remaining.id);
  assert.equal(schedule.listSchedules(chatId).length, 0);
});

test('schedules survive a restart', () => {
  const chatId = -1009990012;
  schedule.createSchedule(chatId, { kind: 'message', text: 'persisted', at: '2099-06-01T10:00', createdBy: 'Bob' });
  schedule.forgetSchedules(chatId);
  assert.deepEqual(schedule.listSchedules(chatId).map((s) => s.text), ['persisted']);
});

test('bad schedules are refused with a reason', () => {
  const chatId = -1009990013;
  const make = (input: Record<string, unknown>) => () =>
    schedule.createSchedule(chatId, { kind: 'message', text: 'x', createdBy: 'Alice', ...input } as never);
  assert.throws(make({ at: '2020-01-01T09:00' }), /already in the past/);
  assert.throws(make({ at: 'tomorrow at nine' }), /must look like/);
  assert.throws(make({ cron: '* * * * *' }), /at most every 15 minutes/);
  assert.throws(make({ cron: '0 0 9 * * 1' }), /five fields/);
  assert.throws(make({ cron: 'x y z a b' }), /Not a valid cron pattern/);
  assert.throws(make({}), /either "at"/);
  assert.throws(make({ at: '2099-01-01T09:00', cron: '0 9 * * 1' }), /either "at"/);
  assert.equal(schedule.listSchedules(chatId).length, 0);
});

test('a script schedule takes a workspace path, may repeat often, and tasks can carry an effort level', () => {
  const chatId = -1009990014;
  const script = schedule.createSchedule(chatId, { kind: 'script', text: 'scripts/check_prs.py', cron: '*/5 * * * *', createdBy: 'Alice' });
  assert.equal(script.kind, 'script');
  assert.match(schedule.describeSchedule(script), /script.*scripts\/check_prs\.py/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'script', text: '../other/x.py', cron: '*/5 * * * *', createdBy: 'A' }), /path of a script/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'script', text: 'rm -rf x; y.py', cron: '*/5 * * * *', createdBy: 'A' }), /path of a script/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'script', text: 'a.py', cron: '* * * * *', createdBy: 'A' }), /at most every 5 minutes/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'task', text: 'recap', cron: '*/5 * * * *', createdBy: 'A' }), /at most every 15 minutes/);

  const task = schedule.createSchedule(chatId, { kind: 'task', text: 'Deep research', cron: '0 8 * * *', effort: 'high', createdBy: 'Alice' });
  assert.equal(task.effort, 'high');
  assert.match(schedule.describeSchedule(task), /task \(effort high\)/);
  assert.equal(schedule.createSchedule(chatId, { kind: 'message', text: 'hi', cron: '0 9 * * *', effort: 'high', createdBy: 'A' }).effort, undefined);
});

// ── Hooks ────────────────────────────────────────────────────────────

test('hooks are registered by name, can be switched off, updated and removed', () => {
  const chatId = -1009990030;
  const hook = hooks.saveHook(chatId, { name: 'No-Emma', file: 'hooks/no_emma.py', description: 'Deletes messages containing emma', createdBy: 'Alice' });
  assert.deepEqual([hook.name, hook.file, hook.enabled], ['no-emma', 'no_emma.py', true]);
  assert.equal(hooks.hasActiveHooks(chatId), true);

  hooks.setHookEnabled(chatId, 'no-emma', false);
  assert.equal(hooks.hasActiveHooks(chatId), false);
  hooks.forgetHooks(chatId); // as after a restart
  assert.equal(hooks.listHooks(chatId)[0].enabled, false);

  hooks.saveHook(chatId, { name: 'no-emma', file: 'no_emma_v2.py', description: 'v2', createdBy: 'Bob' });
  assert.equal(hooks.listHooks(chatId).length, 1, 'same name updates in place');
  assert.equal(hooks.listHooks(chatId)[0].file, 'no_emma_v2.py');
  assert.equal(hooks.listHooks(chatId)[0].enabled, true);

  assert.throws(() => hooks.saveHook(chatId, { name: 'x', file: '../escape.py', description: 'd', createdBy: 'A' }), /directly inside hooks/);
  assert.throws(() => hooks.saveHook(chatId, { name: 'x', file: 'sub/dir.py', description: 'd', createdBy: 'A' }), /directly inside hooks/);
  assert.throws(() => hooks.saveHook(chatId, { name: 'x', file: 'thing.exe', description: 'd', createdBy: 'A' }), /directly inside hooks/);
  assert.throws(() => hooks.saveHook(chatId, { name: 'Bad Name!', file: 'a.py', description: 'd', createdBy: 'A' }), /hook name/);

  assert.equal(hooks.removeHook(chatId, 'no-emma')?.name, 'no-emma');
  assert.equal(hooks.listHooks(chatId).length, 0);
});

test('a hook is given a compact description of the message', () => {
  const event = hooks.buildHookEvent(
    message({
      message_id: 77,
      text: 'see https://github.com/a/b and the docs',
      entities: [{ type: 'text_link', offset: 31, length: 4, url: 'https://example.com/docs' }],
      reply_to_message: { message_id: 70, date: 1, chat: CHAT, from: BOB, text: 'where is it?' },
    }),
    'Events',
    false,
  ) as Record<string, any>;
  assert.equal(event.event, 'message');
  assert.equal(event.topic, 'Events');
  assert.equal(event.kind, 'text');
  assert.deepEqual(event.from, { id: 111, name: 'Alice Tan', username: 'alice', is_bot: false });
  assert.deepEqual(event.links, ['https://github.com/a/b', 'https://example.com/docs']);
  assert.deepEqual(event.reply_to, { message_id: 70, from_name: 'Bob', text: 'where is it?' });
  assert.equal(event.raw.message_id, 77);
  assert.equal(hooks.buildHookEvent(message({ photo: [{ file_id: 'x' }], caption: 'c' }), undefined, true).event, 'edit');
});

// ── Usage ────────────────────────────────────────────────────────────

test('usage is totalled per person over a period', () => {
  const chatId = -1009990040;
  const now = new Date('2026-11-26T12:00:00Z');
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString();
  usage.logUsage(chatId, { t: at(1), kind: 'ask', userId: 1, name: 'Alice', costUsd: 0.1, seconds: 30, turns: 3 });
  usage.logUsage(chatId, { t: at(2), kind: 'ask', userId: 1, name: 'Alice', costUsd: 0.2, seconds: 60, turns: 5 });
  usage.logUsage(chatId, { t: at(3), kind: 'ask', userId: 2, name: 'Bob', costUsd: 0.05, seconds: 10, turns: 1 });
  usage.logUsage(chatId, { t: at(4), kind: 'digest', name: '2026-11-25', costUsd: 0.01, seconds: 5, turns: 1 });
  usage.logUsage(chatId, { t: at(24 * 10), kind: 'ask', userId: 2, name: 'Bob', costUsd: 9, seconds: 10, turns: 1 });

  const week = usage.summarizeUsage(chatId, 7, now);
  assert.equal(week.total.runs, 4);
  assert.equal(week.total.costUsd.toFixed(2), '0.36');
  assert.deepEqual(week.rows.map((r) => [r.name, r.runs]), [['Alice', 2], ['Bob', 1], ['Daily digest', 1]]);
  assert.equal(usage.summarizeUsage(chatId, 30, now).total.runs, 5);
});

// ── Digests ──────────────────────────────────────────────────────────

test('recent digests are offered newest-last and within a size budget', () => {
  const chatId = -1009990050;
  for (const [day, text] of [['2026-11-20', 'A'.repeat(100)], ['2026-11-21', 'B'.repeat(100)], ['2026-11-22', 'C'.repeat(100)]] as const) {
    fs.mkdirSync(path.dirname(transcript.digestPath(chatId, day)), { recursive: true });
    fs.writeFileSync(transcript.digestPath(chatId, day), text);
  }
  assert.deepEqual(transcript.listDigestDays(chatId), ['2026-11-20', '2026-11-21', '2026-11-22']);
  const two = transcript.readRecentDigests(chatId, 250);
  assert.equal(two, `${'B'.repeat(100)}\n\n${'C'.repeat(100)}`);
  assert.equal(transcript.readRecentDigests(chatId, 50), '');
});

// ── Ownership and groups ─────────────────────────────────────────────

test('the claim code makes exactly one owner', () => {
  state.resetStateCache();
  assert.equal(state.isOwner(111), false);
  assert.equal(state.claimOwnership(222, 'wrong'), 'wrong-code');
  assert.equal(state.claimOwnership(111, 'let-me-in'), 'claimed');
  assert.equal(state.isOwner(111), true);
  assert.equal(state.claimOwnership(222, 'let-me-in'), 'already-owned');
  assert.equal(state.isOwner(222), false);

  // Survives a restart.
  state.resetStateCache();
  assert.equal(state.isOwner(111), true);
});

test('groups are off until enabled, and stay known after being disabled', () => {
  const chatId = -1007770001;
  assert.equal(state.isGroupEnabled(chatId), false);
  state.enableGroup(chatId, { title: 'Test', enabledBy: 111, isForum: true });
  assert.equal(state.isGroupEnabled(chatId), true);
  state.disableGroup(chatId);
  assert.equal(state.isGroupEnabled(chatId), false);
  assert.equal(state.getGroup(chatId)?.title, 'Test');
});

test('a group’s effort level is remembered, and can go back to the default', () => {
  const chatId = -1007770010;
  state.enableGroup(chatId, { title: 'Effort', enabledBy: 111 });
  assert.equal(state.getGroup(chatId)?.effort, undefined);
  state.setGroupEffort(chatId, 'high');
  state.resetStateCache();
  assert.equal(state.getGroup(chatId)?.effort, 'high');
  state.enableGroup(chatId, { title: 'Effort renamed', enabledBy: 111 });
  assert.equal(state.getGroup(chatId)?.effort, 'high', 're-enabling keeps the setting');
  state.setGroupEffort(chatId, undefined);
  assert.equal(state.getGroup(chatId)?.effort, undefined);
});

test('each group gets its own stable sandbox user', () => {
  state.enableGroup(-1007770002, { title: 'A', enabledBy: 111 });
  state.enableGroup(-1007770003, { title: 'B', enabledBy: 111 });
  const a = state.sandboxUidFor(-1007770002);
  const b = state.sandboxUidFor(-1007770003);
  assert.notEqual(a, b);
  assert.ok(a >= 20001 && b >= 20001);
  state.resetStateCache();
  assert.equal(state.sandboxUidFor(-1007770002), a);
  state.enableGroup(-1007770002, { title: 'A renamed', enabledBy: 111 });
  assert.equal(state.sandboxUidFor(-1007770002), a, 're-enabling keeps the same user');
});

test('the previous message time of a member is reported for catch-up', () => {
  const chatId = -1009990020;
  const first = new Date('2026-11-20T02:00:00Z');
  const second = new Date('2026-11-26T05:00:00Z');
  assert.equal(transcript.noteMember(chatId, { id: 1, name: 'Alice' }, first), undefined);
  assert.equal(transcript.noteMember(chatId, { id: 1, name: 'Alice' }, second)?.toISOString(), first.toISOString());
});

// ── Prompt ───────────────────────────────────────────────────────────

test('message links use the right form for private and public supergroups', () => {
  const group = { chatId: -1001234567890, title: 'T', enabled: true, enabledAt: new Date().toISOString(), enabledBy: 1 };
  assert.equal(messageLinkBase(group), 'https://t.me/c/1234567890');
  assert.equal(messageLinkBase({ ...group, username: 'binjai' }), 'https://t.me/binjai');
  assert.equal(messageLinkBase({ ...group, chatId: -555 }), undefined);
});

test('the system prompt names the group and explains forum topics only for forums', () => {
  const group = { chatId: -1001234567890, title: 'Binjai Kingdom', enabled: true, enabledAt: '2026-11-26T00:00:00Z', enabledBy: 1 };
  const plain = buildSystemPrompt(group, 'Sekre');
  const forum = buildSystemPrompt({ ...group, isForum: true }, 'Sekre');
  assert.match(plain, /secretary of the Telegram group "Binjai Kingdom"/);
  assert.doesNotMatch(plain, /forum split into topics/);
  assert.match(forum, /forum split into topics/);
});
