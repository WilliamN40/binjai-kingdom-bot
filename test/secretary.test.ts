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
  assert.throws(make({ every_seconds: 2, everySeconds: 2 }), /at most every 10 seconds/);
  assert.throws(make({ cron: '0 0 9 * * 1' }), /five fields/);
  assert.throws(make({ cron: 'x y z a b' }), /Not a valid cron pattern/);
  assert.throws(make({}), /exactly one of/);
  assert.throws(make({ at: '2099-01-01T09:00', cron: '0 9 * * 1' }), /exactly one of/);
  assert.throws(make({ cron: '0 9 * * *', until: '2020-01-01T00:00' }), /already in the past/);
  assert.equal(schedule.listSchedules(chatId).length, 0);
});

test('a script schedule takes a workspace path, may repeat often, and tasks can carry an effort level', () => {
  const chatId = -1009990014;
  const script = schedule.createSchedule(chatId, { kind: 'script', text: 'scripts/check_prs.py', cron: '*/5 * * * *', createdBy: 'Alice' });
  assert.equal(script.kind, 'script');
  assert.match(schedule.describeSchedule(script), /script.*scripts\/check_prs\.py/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'script', text: '../other/x.py', cron: '*/5 * * * *', createdBy: 'A' }), /path of a script/);
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'script', text: 'rm -rf x; y.py', cron: '*/5 * * * *', createdBy: 'A' }), /path of a script/);
  assert.equal(schedule.createSchedule(chatId, { kind: 'script', text: 'a.py', cron: '* * * * *', createdBy: 'A' }).cron, '* * * * *', 'scripts may run every minute');
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

// ── Capabilities added after the first week in a real group ──────────

test('hooks can post a photo from https or the workspace, and delete an earlier message by id', () => {
  assert.deepEqual(hooks.parseActions('{"do":"photo","url":"https://example.com/a.jpg","caption":"hi"}'), [
    { do: 'photo', url: 'https://example.com/a.jpg', caption: 'hi', reply: true },
  ]);
  assert.deepEqual(hooks.parseActions('{"do":"photo","file":"./pics/a.png","reply":false}'), [
    { do: 'photo', file: 'pics/a.png', reply: false },
  ]);
  // Plain http, absolute paths, ".." and hidden folders are refused.
  for (const bad of ['{"url":"http://169.254.169.254/x"}', '{"file":"/etc/passwd"}', '{"file":"../x.jpg"}', '{"file":".ssh/id"}', '{"file":"a/.git/x"}']) {
    assert.deepEqual(hooks.parseActions(`{"do":"photo",${bad.slice(1)}`), [], bad);
  }
  assert.deepEqual(hooks.parseActions('[{"do":"delete"},{"do":"delete","message_id":29508},{"do":"delete","message_id":"x"}]'), [
    { do: 'delete' },
    { do: 'delete', message_id: 29508 },
    { do: 'delete' },
  ]);
});

test('pictures are indexed by message number so the secretary can look at them later', () => {
  const chatId = -1009990040;
  assert.equal(transcript.findMedia(chatId, 5), undefined);
  transcript.recordMedia(chatId, { msg: 5, fileId: 'old', mediaType: 'image/jpeg' });
  transcript.recordMedia(chatId, { msg: 51, fileId: 'other', mediaType: 'image/png' });
  transcript.recordMedia(chatId, { msg: 5, fileId: 'edited', mediaType: 'image/jpeg' });
  assert.equal(transcript.findMedia(chatId, 5)?.fileId, 'edited', 'the latest version wins');
  assert.equal(transcript.findMedia(chatId, 51)?.mediaType, 'image/png');
  assert.equal(transcript.findMedia(chatId, 6), undefined);
});

test('group settings change from the chat, survive re-enabling, and only owners or managers may change them', () => {
  const chatId = -1007770010;
  state.enableGroup(chatId, { title: 'Settings', enabledBy: 111, isForum: true });
  const group = () => state.getGroup(chatId)!;

  assert.equal(state.resolveModel('Sonnet'), 'claude-sonnet-5-5');
  assert.equal(state.resolveModel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(state.resolveModel('kimi'), undefined);
  assert.equal(state.resolveModel('toString'), undefined);

  state.updateGroupSettings(chatId, { model: 'claude-sonnet-5-5', answerTopic: 4242, houseRules: 'Answer in English.', managers: [222, 222] });
  state.enableGroup(chatId, { title: 'Settings renamed', enabledBy: 111, isForum: true });
  assert.equal(group().model, 'claude-sonnet-5-5');
  assert.equal(group().answerTopic, 4242);
  assert.equal(group().houseRules, 'Answer in English.');
  assert.deepEqual(group().managers, [222]);

  // Rights come from user ids only: the owner (claimed below) and listed managers.
  assert.equal(state.canManage(group(), 222), true);
  assert.equal(state.canManage(group(), 333), false);
  assert.equal(state.canManage(group(), undefined), false, 'a hook-originated run has no rights');

  state.updateGroupSettings(chatId, { model: null, answerTopic: null, houseRules: null, managers: [] });
  assert.equal(group().model, undefined);
  assert.equal(group().answerTopic, undefined);
  assert.equal(group().houseRules, undefined);
  assert.equal(group().managers, undefined);
});

test('topics and members are found by name for settings changes', () => {
  const chatId = -1009990050;
  transcript.setTopicName(chatId, 4242, 'Off topic');
  assert.equal(transcript.findTopicId(chatId, '#off TOPIC'), 4242);
  assert.equal(transcript.findTopicId(chatId, 'General'), 0);
  assert.equal(transcript.findTopicId(chatId, 'nope'), undefined);
  transcript.noteMember(chatId, { id: 555000111, name: 'Dana', username: 'dana_k' }, new Date());
  assert.equal(transcript.findMember(chatId, '@Dana_K')?.id, 555000111);
  assert.equal(transcript.findMember(chatId, 'dana')?.id, 555000111);
  assert.equal(transcript.findMember(chatId, 'someone'), undefined);
  assert.equal(transcript.memberName(chatId, 555000111), 'Dana (@dana_k)');
});

test('the system prompt tells the secretary to try its tools before saying it cannot, and who decides', () => {
  const group = { chatId: -1001234567890, title: 'Binjai Kingdom', enabled: true, enabledAt: '2026-11-26T00:00:00Z', enabledBy: 1 };
  const prompt = buildSystemPrompt(group, 'Sekre');
  assert.match(prompt, /Before saying you can't do something/);
  assert.match(prompt, /say plainly that you won't and why/);
  assert.match(prompt, /## Who decides/);
  assert.match(prompt, /group_settings tool changes on the spot/);
  assert.doesNotMatch(prompt, /## House rules for this group/);
  assert.match(buildSystemPrompt({ ...group, houseRules: 'Answer in English.' }, 'Sekre'), /## House rules for this group[\s\S]*Answer in English\./);
  assert.match(prompt, /view_image/);
  assert.doesNotMatch(prompt, /moderate the group/, 'hooks can delete and pin, so it is not told it cannot moderate');
});

test('secrets are kept per group, never listed with their values, and become sandbox variables', async () => {
  const secrets = await import('../src/secretary/secrets.js');
  const chatId = -1009990060;
  secrets.setSecret(chatId, 'AGENTMAIL_API_KEY', 'am_us_123', 'Alice (@alice)');
  secrets.setSecret(chatId, 'GH_TOKEN', 'github_pat_x', 'Alice (@alice)');
  assert.deepEqual(secrets.listSecrets(chatId).map((s) => s.name), ['AGENTMAIL_API_KEY', 'GH_TOKEN']);
  assert.doesNotMatch(JSON.stringify(secrets.listSecrets(chatId)), /am_us_123/);
  assert.deepEqual(secrets.secretEnv(chatId), { AGENTMAIL_API_KEY: 'am_us_123', GH_TOKEN: 'github_pat_x' });
  assert.deepEqual(secrets.secretEnv(-1), {}, 'other groups see nothing');

  assert.throws(() => secrets.setSecret(chatId, 'lowercase', 'v', 'A'), /secret name/);
  assert.throws(() => secrets.setSecret(chatId, 'PATH', 'v', 'A'), /set by the workspace/);
  assert.throws(() => secrets.setSecret(chatId, 'EMPTY', '', 'A'), /value/);

  const stat = fs.statSync(path.join(dataDir, 'secrets.json'));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0, 'readable by the bot only');
  assert.ok(!fs.existsSync(path.join(transcript.groupDir(chatId), 'secrets.json')), 'not inside the folder the sandbox can read');

  secrets.resetSecretsCache(); // as after a restart
  assert.equal(secrets.removeSecret(chatId, 'GH_TOKEN'), true);
  assert.equal(secrets.removeSecret(chatId, 'GH_TOKEN'), false);
  secrets.forgetSecrets(chatId);
  assert.deepEqual(secrets.listSecrets(chatId), []);
});

test('MCP servers are registered per group, validated, and their tools pass the guard', async () => {
  const mcp = await import('../src/secretary/mcp.js');
  const chatId = -1009990070;
  assert.match(mcp.mcpNameProblem('secretary') ?? '', /taken/);
  assert.match(mcp.mcpNameProblem('Bad Name') ?? '', /lowercase/);
  const server = mcp.saveMcpServer(chatId, { name: 'agentmail', command: 'npx -y agentmail-mcp', description: 'Email inbox', tools: ['send_message', 'list_threads'], createdBy: 'William' });
  assert.equal(server.enabled, true);
  assert.match(mcp.describeMcpServer(server), /send_message, list_threads/);
  mcp.setMcpEnabled(chatId, 'agentmail', false);
  mcp.forgetMcpServers(chatId); // as after a restart
  assert.equal(mcp.listMcpServers(chatId)[0].enabled, false);
  assert.deepEqual(Object.keys(mcp.sdkMcpServers(chatId, 20001)), [], 'switched-off servers are not started');
  mcp.setMcpEnabled(chatId, 'agentmail', true);
  const config = mcp.sdkMcpServers(chatId, 20001).agentmail;
  assert.equal(config.env.MCP_BRIDGE_GROUP, 'group_1009990070');
  assert.match(config.env.MCP_BRIDGE_COMMAND, /npx -y agentmail-mcp.*mcp-agentmail\.log/);

  const root = path.join(dataDir, 'groups', 'group_1009990070');
  const options = { webSearch: true, ownTools: [], mcpServers: ['agentmail'] };
  assert.equal(checkToolUse('mcp__agentmail__send_message', {}, root, options).allowed, true);
  assert.equal(checkToolUse('mcp__other__send_message', {}, root, options).allowed, false);
  assert.equal(checkToolUse('mcp__agentmail_evil__x', {}, root, options).allowed, false);
  assert.equal(mcp.removeMcpServer(chatId, 'agentmail')?.name, 'agentmail');
});

test('scripts and hooks can pin or delete an earlier message by id', () => {
  assert.deepEqual(hooks.parseActions('{"actions":[{"do":"pin","message_id":42},{"do":"pin"}]}'), [{ do: 'pin', message_id: 42 }, { do: 'pin' }]);
});

test('a deploy plan lists the commits and flags changes to containers and the sandbox', async () => {
  const { describePlan } = await import('../src/secretary/deploy.js');
  const text = describePlan({
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    ref: 'main',
    current: '1111111222222233333334444444555555566666',
    commits: [{ sha: 'abcdef1', title: 'Add workbench', author: 'Dana' }],
    files: ['src/secretary/group.ts', 'sandbox/runner.mjs', 'docker-compose.yml'],
    sensitive: ['sandbox/runner.mjs', 'docker-compose.yml'],
    behind: false,
  });
  assert.match(text, /abcdef1 Add workbench \(Dana\)/);
  assert.match(text, /sandbox\/runner\.mjs, docker-compose\.yml/);
  assert.match(text, /\/deploy confirm abcdef1/);
  assert.match(describePlan({ sha: 'a'.repeat(40), ref: 'main', current: 'a'.repeat(40), commits: [], files: [], sensitive: [], behind: false }), /already running/);
});

test('any Bot API method can be called, always in this group, with rights by method', async () => {
  const tg = await import('../src/secretary/telegram-api.js');
  assert.equal(tg.methodLevel('sendPoll'), 'open');
  assert.equal(tg.methodLevel('banChatMember'), 'managed');
  assert.equal(tg.methodLevel('setMyCommands'), 'owner');
  assert.equal(tg.methodLevel('someFutureMethod'), 'owner', 'unknown methods are for the owner');
  assert.equal(tg.methodLevel('logOut'), 'forbidden');

  const where = { chatId: -1001234500000, threadId: 4242 };
  const read = async (file: string) => Buffer.from(`contents of ${file}`);
  const poll = await tg.prepareCall('sendPoll', { chat_id: -999, question: 'Dinner?', options: [{ text: 'A' }] }, where, read);
  assert.equal(poll.chat_id, -1001234500000, 'another chat id is overwritten');
  assert.equal(poll.message_thread_id, 4242, 'sends go to the current topic by default');
  const copy = await tg.prepareCall('copyMessage', { from_chat_id: -42, message_id: 5 }, where, read);
  assert.equal(copy.from_chat_id, -1001234500000, 'nothing is copied out of another chat');
  const album = await tg.prepareCall('sendMediaGroup', { media: [{ type: 'photo', media: 'workspace:pics/a.jpg' }] }, where, read);
  const { InputFile } = await import('grammy');
  assert.ok((album.media as Array<{ media: unknown }>)[0].media instanceof InputFile, 'workspace files are uploaded');
  const me = await tg.prepareCall('getMe', {}, where, read);
  assert.equal(me.chat_id, undefined);
  await assert.rejects(tg.prepareCall('getUpdates', {}, where, read), /not available/);
  await assert.rejects(tg.prepareCall('editMessageText', { inline_message_id: 'x', text: 'y' }, where, read), /Only messages in this group/);
  await assert.rejects(tg.prepareCall('send poll', {}, where, read), /not a Telegram method/);

  assert.deepEqual(hooks.parseActions('{"do":"api","method":"sendDice","params":{"emoji":"🎲"}}'), [{ do: 'api', method: 'sendDice', params: { emoji: '🎲' } }]);
});

test('hooks only get the events they ask for, and risky Telegram calls stay closed', async () => {
  const chatId = -1009990080;
  hooks.saveHook(chatId, { name: 'old', file: 'old.py', description: 'messages only', createdBy: 'A' });
  assert.equal(hooks.hasActiveHooks(chatId, 'callback'), false, 'existing hooks never see button presses');
  hooks.saveHook(chatId, { name: 'menu', file: 'menu.py', description: 'buttons', createdBy: 'A', events: ['callback'] });
  assert.equal(hooks.hasActiveHooks(chatId, 'callback'), true);
  assert.match(hooks.describeHook(hooks.listHooks(chatId)[1]), /on callback/);

  const tg = await import('../src/secretary/telegram-api.js');
  assert.equal(tg.methodLevel('leaveChat'), 'forbidden');
  assert.equal(tg.methodLevel('promoteChatMember'), 'forbidden');
  const reply = await tg.prepareCall('sendMessage', { text: 'hi', reply_parameters: { message_id: 1, chat_id: -42 } }, { chatId: -100777 }, async () => Buffer.alloc(0));
  assert.equal((reply.reply_parameters as { chat_id: number }).chat_id, -100777);
});

test('notes are numbered and can be edited or removed', () => {
  const chatId = -1009990090;
  transcript.appendNote(chatId, 'Answer sean in Chinese', 'sean (@sean)');
  transcript.appendNote(chatId, 'Dinner on Friday', 'Alice (@alice)');
  transcript.appendNote(chatId, 'Answer Alice in Javanese', 'Alice (@alice)');
  assert.match(transcript.readNotes(chatId), /^#1 - \[.*\(asked by sean \(@sean\)\) Answer sean in Chinese/);
  assert.deepEqual(transcript.listNotes(chatId).map((n) => n.askedBy), ['sean (@sean)', 'Alice (@alice)', 'Alice (@alice)']);

  const edited = transcript.editNote(chatId, 2, 'Dinner moved to Saturday', 'Alice (@alice)');
  assert.equal(edited?.text, 'Dinner moved to Saturday');
  assert.match(transcript.listNotes(chatId)[1].line, /asked by Alice \(@alice\)\) Dinner moved to Saturday \(edited by Alice/);

  assert.deepEqual(transcript.removeNotes(chatId, [1, 3]).map((n) => n.text), ['Answer sean in Chinese', 'Answer Alice in Javanese']);
  assert.deepEqual(transcript.listNotes(chatId).map((n) => [n.number, n.text]), [[1, 'Dinner moved to Saturday (edited by Alice (@alice))']]);
  assert.equal(transcript.editNote(chatId, 9, 'x', 'A'), undefined);
});

test('votes in the bot\'s polls are described for the record', async () => {
  const polls = await import('../src/secretary/polls.js');
  polls.rememberPoll('p1', { chatId: -1009990091, messageId: 120, question: 'Dinner?', options: ['Song Fa', 'Hai Di Lao'], anonymous: false, at: new Date().toISOString() });
  polls.resetPollCache(); // survives a restart
  const poll = polls.findPoll('p1')!;
  assert.equal(polls.describeVote(poll, 'Dana (@dana_k)', [1]), '* Dana (@dana_k) voted for "Hai Di Lao" in the poll "Dinner?" (msg 120)');
  assert.match(polls.describeVote(poll, 'Dana', []), /took back their vote/);
  assert.equal(
    polls.describeResult(poll, [{ text: 'Song Fa', voter_count: 3 }, { text: 'Hai Di Lao', voter_count: 1 }], 4),
    '* The poll "Dinner?" (msg 120) closed: Song Fa 3, Hai Di Lao 1 (4 voters)',
  );
  assert.equal(polls.findPoll('nope'), undefined);
});

test('schedules can repeat every few seconds until a set time, within limits the group can change', () => {
  const chatId = -1007770020;
  state.enableGroup(chatId, { title: 'Pings', enabledBy: 111 });
  const ping = schedule.createSchedule(chatId, { kind: 'message', text: 'turun!', everySeconds: 30, until: '2099-01-01T19:30', createdBy: 'A' });
  assert.match(schedule.describeSchedule(ping), /every 30 s until 2099-01-01 19:30/);
  const first = new Date(ping.nextRun).getTime();
  assert.equal(schedule.takeDue(chatId, new Date(first)).length, 1);
  assert.equal(new Date(schedule.listSchedules(chatId)[0].nextRun).getTime(), first + 30_000, 'keeps its rhythm');
  schedule.takeDue(chatId, new Date(first + 3_600_000));
  assert.ok(new Date(schedule.listSchedules(chatId)[0].nextRun).getTime() > first + 3_600_000, 'no catching up after downtime');
  assert.equal(schedule.takeDue(chatId, new Date('2099-01-01T11:31:00Z')).length, 1);
  assert.equal(schedule.listSchedules(chatId).length, 0, 'gone after "until"');

  assert.throws(() => schedule.createSchedule(chatId, { kind: 'task', text: 'x', everySeconds: 60, createdBy: 'A' }), /at most every 15 minutes/);
  state.updateGroupSettings(chatId, { minRepeatSeconds: 60, minTaskRepeatMinutes: 1 });
  assert.throws(() => schedule.createSchedule(chatId, { kind: 'message', text: 'x', everySeconds: 30, createdBy: 'A' }), /at most every 60 seconds/);
  assert.equal(schedule.createSchedule(chatId, { kind: 'task', text: 'x', everySeconds: 60, createdBy: 'A' }).everySeconds, 60);
});
