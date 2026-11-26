import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Configuration is read from the environment at import time, so set it up first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'));
process.env.CLAUDEGRAM_ENV_PATH = path.join(dataDir, 'no-such.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.DATA_DIR = dataDir;
process.env.SECRETARY_TIMEZONE = 'Asia/Singapore';
process.env.ALLOWED_USER_IDS = '';

const transcript = await import('../src/secretary/transcript.js');
const { importTelegramExport, ImportError } = await import('../src/secretary/import.js');

after(() => {
  transcript.flushMembers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── A synthetic Telegram Desktop export ──────────────────────────────

type Fields = Record<string, unknown>;

const EXPORT_ID = 1234567890;
/** The chat id the bot sees for a supergroup whose export id is `exportId`. */
const chatIdOf = (exportId: number) => -(1_000_000_000_000 + exportId);

function exportOf(exportId: number, messages: unknown[]): Fields {
  return { name: 'Binjai Kingdom', type: 'private_supergroup', id: exportId, messages };
}

/** Singapore wall-clock time on 20 Nov 2026 ("10:05" or "10:05:30") as the export's date_unixtime. */
function unix(time: string, day = '2026-11-20'): string {
  return String(Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}+08:00`) / 1000);
}

// `date` is the exporting computer's wall clock. It is deliberately wrong here: only date_unixtime counts.
const WRONG_LOCAL_DATE = '2020-01-01T03:04:05';

function message(id: number, time: string, fields: Fields = {}): Fields {
  return {
    id,
    type: 'message',
    date: WRONG_LOCAL_DATE,
    date_unixtime: unix(time),
    from: 'Alice Tan',
    from_id: 'user111',
    text: '',
    text_entities: [],
    ...fields,
  };
}

function service(id: number, time: string, action: string, fields: Fields = {}): Fields {
  return {
    id,
    type: 'service',
    date: WRONG_LOCAL_DATE,
    date_unixtime: unix(time),
    actor: 'Alice Tan',
    actor_id: 'user111',
    action,
    text: '',
    text_entities: [],
    ...fields,
  };
}

const BOB = { from: 'Bob', from_id: 'user222' };

function readDay(chatId: number, day: string): string[] {
  const content = fs.readFileSync(path.join(transcript.groupDir(chatId), 'transcript', `${day}.txt`), 'utf8');
  assert.ok(content.endsWith('\n'), 'a day file ends with a newline');
  return content.slice(0, -1).split('\n');
}

/** Every file under a folder with its content, to prove that nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

// ── Messages ─────────────────────────────────────────────────────────

test('messages, replies, media and events are written the way the live recorder writes them', () => {
  const exportId = EXPORT_ID;
  const chatId = chatIdOf(exportId);
  const result = importTelegramExport(
    exportOf(exportId, [
      service(1, '09:00', 'create_group', { title: 'Binjai Kingdom', members: ['Alice Tan', 'Bob'] }),
      message(2, '10:00', { text: 'lunch at 1?' }),
      message(3, '10:01', {
        ...BOB,
        reply_to_message_id: 2,
        text: ['sign up ', { type: 'text_link', text: 'here', href: 'https://example.com/form' }, ' by ', { type: 'bold', text: 'Friday' }],
      }),
      message(4, '10:02', { photo: 'photos/photo_1.jpg', width: 800, height: 600, text: 'the receipt\nfor lunch' }),
      message(5, '10:03', { ...BOB, file: 'files/budget.xlsx', file_name: 'budget.xlsx', mime_type: 'application/vnd.ms-excel' }),
      message(6, '10:04', {
        file: '(File not included. Change data exporting settings to download.)',
        media_type: 'voice_message',
        duration_seconds: 75,
      }),
      message(7, '10:05', { ...BOB, file: 'stickers/s.webp', media_type: 'sticker', sticker_emoji: '😀' }),
      message(8, '10:06', { poll: { question: 'Dinner?', closed: false, total_voters: 2, answers: [{ text: 'Yes', voters: 2 }, { text: 'No', voters: 0 }] } }),
      message(9, '10:07', { ...BOB, forwarded_from: 'Carol', text: 'news' }),
      message(10, '10:08', { from: null, from_id: 'user333', text: 'I was here', edited: '2026-11-20T10:09:00', edited_unixtime: unix('10:09') }),
      message(11, '10:09', { reply_to_message_id: 999, text: 'replying to something that is gone' }),
      service(12, '10:10', 'invite_members', { members: ['Dave Lim'] }),
      service(13, '10:11', 'join_group_by_link', { actor: 'Erin', actor_id: 'user555', inviter: 'Alice Tan' }),
      service(14, '10:12', 'remove_members', { actor: 'Erin', actor_id: 'user555', members: ['Erin'] }),
      service(15, '10:13', 'pin_message', { ...{ actor: 'Bob', actor_id: 'user222' }, message_id: 2 }),
      service(16, '10:14', 'edit_group_title', { title: 'Binjai Empire' }),
      // Things the importer cannot use must be counted, never thrown on.
      service(17, '10:15', 'phone_call', { duration_seconds: 5 }),
      'garbage',
      { id: 'not-a-number', type: 'message', date_unixtime: unix('10:16'), text: 'x' },
      { id: 18, type: 'message', text: 'no date at all' },
      message(19, '10:17', { text: { unexpected: 'shape' }, media_type: 'hologram' }),
    ]),
    { chatId },
  );

  assert.deepEqual(readDay(chatId, '2026-11-20'), [
    '[2026-11-20 09:00] * Alice Tan created the group',
    '[2026-11-20 10:00] Alice Tan [msg 2]: lunch at 1?',
    '[2026-11-20 10:01] Bob [msg 3, reply to msg 2 by Alice Tan]: sign up here by Friday (links: https://example.com/form)',
    '[2026-11-20 10:02] Alice Tan [msg 4]: [photo] the receipt ⏎ for lunch',
    '[2026-11-20 10:03] Bob [msg 5]: [file: budget.xlsx]',
    '[2026-11-20 10:04] Alice Tan [msg 6]: [voice message 1:15]',
    '[2026-11-20 10:05] Bob [msg 7]: [sticker 😀]',
    '[2026-11-20 10:06] Alice Tan [msg 8]: [poll: "Dinner?" options: Yes | No]',
    '[2026-11-20 10:07] Bob [msg 9]: [forwarded from Carol] news',
    '[2026-11-20 10:08] Deleted Account [msg 10, EDITED]: I was here',
    '[2026-11-20 10:09] Alice Tan [msg 11, reply to msg 999]: replying to something that is gone',
    '[2026-11-20 10:10] * Alice Tan added Dave Lim to the group',
    '[2026-11-20 10:11] * Erin joined the group',
    '[2026-11-20 10:12] * Erin left the group',
    '[2026-11-20 10:13] * Bob pinned msg 2: "lunch at 1?"',
    '[2026-11-20 10:14] * Alice Tan renamed the group to "Binjai Empire"',
    '[2026-11-20 10:17] Alice Tan [msg 19]: [hologram]',
  ]);

  assert.equal(result.dryRun, false);
  assert.equal(result.chatName, 'Binjai Kingdom');
  assert.equal(result.total, 21);
  assert.equal(result.imported, 17);
  assert.equal(result.skippedExisting, 0);
  assert.equal(result.skippedUnsupported, 4);
  assert.deepEqual(result.unsupportedKinds, {
    'malformed entry': 1,
    'entry without an id': 1,
    'entry without a date': 1,
    'service: phone_call': 1,
  });
  assert.deepEqual([result.daysWritten, result.daysCreated, result.daysMerged], [1, 1, 0]);
  assert.equal(result.isForum, false);
  assert.deepEqual(result.topics, []);
  assert.deepEqual(result.dateRange, { from: '2026-11-20 09:00', to: '2026-11-20 10:17' });
  assert.deepEqual(result.importedRange, { from: '2026-11-20 09:00', to: '2026-11-20 10:17' });
  assert.deepEqual(result.warnings, []);
});

// ── Forum topics ─────────────────────────────────────────────────────

const FORUM_EXPORT_ID = EXPORT_ID + 1;

function forumExport(): Fields {
  return exportOf(FORUM_EXPORT_ID, [
    message(1, '09:00', { text: 'before any topic existed' }),
    service(2, '09:01', 'topic_created', { title: 'Events' }),
    service(3, '09:02', 'topic_created', { actor: 'Bob', actor_id: 'user222', title: 'Food [SG]' }),
    // In a topic, a message that is not a reply points at the topic's creation message.
    message(4, '09:03', { ...BOB, reply_to_message_id: 2, text: 'AGM is on 12 Dec' }),
    message(5, '09:04', { reply_to_message_id: 4, text: 'noted' }),
    // A reply to a reply: the topic is inherited through the whole chain.
    message(6, '09:05', { from: 'Carol', from_id: 'user444', reply_to_message_id: 5, photo: 'photos/hall.jpg', text: 'the hall' }),
    message(7, '09:06', { ...BOB, reply_to_message_id: 3, file: 'files/menu.pdf', file_name: 'menu.pdf' }),
    message(8, '09:07', { text: 'general chatter' }),
    service(9, '09:08', 'pin_message', { message_id: 4 }),
    service(10, '09:09', 'invite_members', { members: ['Dave Lim'] }),
  ]);
}

test('a forum export is split into its topics, and a reply chain inherits its topic', () => {
  const chatId = chatIdOf(FORUM_EXPORT_ID);
  const result = importTelegramExport(forumExport(), { chatId });

  assert.deepEqual(readDay(chatId, '2026-11-20'), [
    '[2026-11-20 09:00] [#General] Alice Tan [msg 1]: before any topic existed',
    '[2026-11-20 09:01] [#Events] * Alice Tan created the topic "Events"',
    '[2026-11-20 09:02] [#Food SG] * Bob created the topic "Food [SG]"',
    '[2026-11-20 09:03] [#Events] Bob [msg 4]: AGM is on 12 Dec',
    '[2026-11-20 09:04] [#Events] Alice Tan [msg 5, reply to msg 4 by Bob]: noted',
    '[2026-11-20 09:05] [#Events] Carol [msg 6, reply to msg 5 by Alice Tan]: [photo] the hall',
    '[2026-11-20 09:06] [#Food SG] Bob [msg 7]: [file: menu.pdf]',
    '[2026-11-20 09:07] [#General] Alice Tan [msg 8]: general chatter',
    '[2026-11-20 09:08] [#Events] * Alice Tan pinned msg 4: "AGM is on 12 Dec"',
    '[2026-11-20 09:09] [#General] * Alice Tan added Dave Lim to the group',
  ]);

  assert.equal(result.isForum, true);
  assert.deepEqual(result.topics, [
    { threadId: null, name: 'General', messages: 3 },
    { threadId: 2, name: 'Events', messages: 5 },
    { threadId: 3, name: 'Food SG', messages: 2 },
  ]);
  // The names are registered, so the bot tags later messages in these topics the same way.
  assert.equal(transcript.getTopicName(chatId, 2), 'Events');
  assert.equal(transcript.getTopicName(chatId, 3), 'Food SG');

  // The store finds the imported lines by topic, like live ones.
  const context = transcript.recentContext(chatId, 250, 'Food SG');
  assert.match(context, /\[#Food SG\] Bob \[msg 7\]/);
});

test('a topic name the bot already uses is kept, and imported lines carry it', () => {
  const exportId = EXPORT_ID + 2;
  const chatId = chatIdOf(exportId);
  transcript.setTopicName(chatId, 2, 'Events 2026');

  importTelegramExport(
    exportOf(exportId, [
      service(2, '09:01', 'topic_created', { title: 'Events' }),
      message(4, '09:03', { reply_to_message_id: 2, text: 'hello' }),
    ]),
    { chatId },
  );
  assert.equal(transcript.getTopicName(chatId, 2), 'Events 2026');
  assert.equal(readDay(chatId, '2026-11-20')[1], '[2026-11-20 09:03] [#Events 2026] Alice Tan [msg 4]: hello');
});

// ── Time ─────────────────────────────────────────────────────────────

test('days are split at midnight in the configured timezone, from date_unixtime', () => {
  const exportId = EXPORT_ID + 3;
  const chatId = chatIdOf(exportId);
  const result = importTelegramExport(
    exportOf(exportId, [
      // 15:59:30 and 16:00:10 UTC on the 20th: either side of midnight in Singapore.
      message(1, '23:59:30', { text: 'last of the day', date_unixtime: String(Date.parse('2026-11-20T15:59:30Z') / 1000) }),
      message(2, '00:00:10', { text: 'first of the next', date_unixtime: Date.parse('2026-11-20T16:00:10Z') / 1000 }),
    ]),
    { chatId },
  );

  assert.deepEqual(fs.readdirSync(path.join(transcript.groupDir(chatId), 'transcript')).sort(), ['2026-11-20.txt', '2026-11-21.txt']);
  assert.deepEqual(readDay(chatId, '2026-11-20'), ['[2026-11-20 23:59] Alice Tan [msg 1]: last of the day']);
  assert.deepEqual(readDay(chatId, '2026-11-21'), ['[2026-11-21 00:00] Alice Tan [msg 2]: first of the next']);
  assert.deepEqual([result.daysWritten, result.daysCreated], [2, 2]);
  assert.deepEqual(result.dateRange, { from: '2026-11-20 23:59', to: '2026-11-21 00:00' });
});

// ── Merging with the live record ─────────────────────────────────────

const MERGE_EXPORT_ID = EXPORT_ID + 4;

function mergeExport(): Fields {
  return exportOf(MERGE_EXPORT_ID, [
    message(9, '09:59', { ...BOB, text: 'early' }),
    message(10, '10:00', { text: 'first live, edited', edited_unixtime: unix('10:20') }),
    service(11, '10:05:05', 'invite_members', { actor: 'Bob', actor_id: 'user222', members: ['Dave'] }),
    message(12, '10:05:20', { ...BOB, text: 'missed by the bot' }),
    message(13, '10:05:40', { ...BOB, text: 'after the join' }),
    message(14, '10:10', { text: 'later' }),
    message(15, '10:22', { ...BOB, text: 'details' }),
    message(16, '10:25', { from: 'Sekre', from_id: 'user999', reply_to_message_id: 14, text: 'see [msg 15] for details' }),
    message(17, '10:30', { ...BOB, text: 'last' }),
  ]);
}

test('importing into a day the bot already recorded adds only what is missing, in order', () => {
  const chatId = chatIdOf(MERGE_EXPORT_ID);
  const at = (time: string) => new Date(Number(unix(time)) * 1000);

  // What the live bot wrote: usernames, its own wording for the join, an edit, and its own answer.
  transcript.appendTranscript(chatId, at('10:00'), 'Alice Tan (@alice) [msg 10]: first live');
  transcript.appendTranscript(chatId, at('10:05'), '* Bob added Dave Lim to the group');
  transcript.appendTranscript(chatId, at('10:05'), 'Bob (@bob) [msg 13]: after the join');
  transcript.appendTranscript(chatId, at('10:20'), 'Alice Tan (@alice) [msg 10, EDITED]: first live, edited');
  transcript.appendTranscript(chatId, at('10:25'), 'Sekre (@sekre_bot) [msg 16, reply to msg 14 by Alice Tan]: see [msg 15] for details');
  transcript.noteMember(chatId, { id: 111, name: 'Alice Tan', username: 'alice' }, at('10:00'));
  transcript.flushMembers();
  const membersFile = path.join(transcript.groupDir(chatId), 'members.json');
  const aliceBefore = JSON.parse(fs.readFileSync(membersFile, 'utf8'))['111'];

  const result = importTelegramExport(mergeExport(), { chatId });

  assert.deepEqual(readDay(chatId, '2026-11-20'), [
    '[2026-11-20 09:59] Bob [msg 9]: early',
    '[2026-11-20 10:00] Alice Tan (@alice) [msg 10]: first live',
    '[2026-11-20 10:05] * Bob added Dave Lim to the group',
    '[2026-11-20 10:05] Bob [msg 12]: missed by the bot',
    '[2026-11-20 10:05] Bob (@bob) [msg 13]: after the join',
    '[2026-11-20 10:10] Alice Tan [msg 14]: later',
    '[2026-11-20 10:20] Alice Tan (@alice) [msg 10, EDITED]: first live, edited',
    '[2026-11-20 10:22] Bob [msg 15]: details',
    '[2026-11-20 10:25] Sekre (@sekre_bot) [msg 16, reply to msg 14 by Alice Tan]: see [msg 15] for details',
    '[2026-11-20 10:30] Bob [msg 17]: last',
  ]);
  assert.equal(result.imported, 5);
  assert.equal(result.skippedExisting, 4, 'msg 10, the join, msg 13 and msg 16 were already recorded');
  assert.deepEqual([result.daysWritten, result.daysCreated, result.daysMerged], [1, 0, 1]);
  assert.deepEqual(result.importedRange, { from: '2026-11-20 09:59', to: '2026-11-20 10:30' });

  // No temp file is left next to the day file.
  assert.deepEqual(fs.readdirSync(path.join(transcript.groupDir(chatId), 'transcript')), ['2026-11-20.txt']);

  // People the record already knew are left alone; people only in the history are added.
  const members = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
  assert.deepEqual(members['111'], aliceBefore);
  assert.equal(members['111'].username, 'alice');
  assert.deepEqual(
    { name: members['222'].name, messages: members['222'].messages, firstSeen: members['222'].firstSeen },
    { name: 'Bob', messages: 4, firstSeen: '2026-11-20' },
  );
  assert.equal(result.membersAdded, 1);
});

test('running the same import again changes nothing', () => {
  for (const [exportId, exportData] of [
    [MERGE_EXPORT_ID, mergeExport()],
    [FORUM_EXPORT_ID, forumExport()],
  ] as const) {
    const chatId = chatIdOf(exportId);
    const dir = transcript.groupDir(chatId);
    const before = snapshot(dir);
    const modified = fs.statSync(path.join(dir, 'transcript', '2026-11-20.txt')).mtimeMs;

    const result = importTelegramExport(exportData, { chatId });

    assert.equal(result.imported, 0);
    assert.equal(result.daysWritten, 0);
    assert.equal(result.membersAdded, 0);
    assert.equal(result.skippedExisting, (exportData.messages as unknown[]).length);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(fs.statSync(path.join(dir, 'transcript', '2026-11-20.txt')).mtimeMs, modified, 'the file was not rewritten');
  }
});

// ── Dry run and bad input ────────────────────────────────────────────

test('a dry run reports what an import would do and writes nothing', () => {
  const exportId = EXPORT_ID + 5;
  const chatId = chatIdOf(exportId);
  const exportData = { ...forumExport(), id: exportId };

  const dry = importTelegramExport(exportData, { chatId, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.imported, 10);
  assert.deepEqual([dry.daysWritten, dry.daysCreated, dry.membersAdded], [1, 1, 3]);
  assert.equal(dry.topics.length, 3);
  assert.equal(fs.existsSync(transcript.groupDir(chatId)), false, 'not even the group folder is created');
  assert.equal(transcript.getTopicName(chatId, 2), undefined);

  // The real run then does exactly what the dry run said.
  const real = importTelegramExport(exportData, { chatId });
  assert.deepEqual({ ...real, dryRun: true }, dry);

  // A dry run over an existing record leaves it untouched too.
  const before = snapshot(transcript.groupDir(chatId));
  const again = importTelegramExport({ ...exportData, messages: [...(exportData.messages as unknown[]), message(11, '09:30', { text: 'new' })] }, { chatId, dryRun: true });
  assert.equal(again.imported, 1);
  assert.deepEqual(snapshot(transcript.groupDir(chatId)), before);
});

test('input that is not a chat export, or is from another chat, is refused', () => {
  const chatId = chatIdOf(EXPORT_ID + 6);
  assert.throws(() => importTelegramExport(null, { chatId }), ImportError);
  assert.throws(() => importTelegramExport({ name: 'x', messages: 'nope' }, { chatId }), /not a Telegram Desktop chat export/);
  assert.throws(() => importTelegramExport({ chats: { list: [] } }, { chatId }), /whole account/);
  assert.throws(() => importTelegramExport(exportOf(EXPORT_ID + 6, []), { chatId: 0 }), /chat id/);

  const other = exportOf(12345, [message(1, '10:00', { text: 'hi' })]);
  assert.throws(() => importTelegramExport(other, { chatId }), /does not match chat id/);
  assert.equal(fs.existsSync(transcript.groupDir(chatId)), false);

  const forced = importTelegramExport(other, { chatId, dryRun: true, allowChatMismatch: true });
  assert.equal(forced.imported, 1);
  assert.match(forced.warnings[0], /does not match chat id/);

  // A basic group's chat id is the export id with a minus sign.
  assert.equal(importTelegramExport(other, { chatId: -12345, dryRun: true }).imported, 1);
});

// ── Command line ─────────────────────────────────────────────────────

test('the command line imports a file, and fails on bad input', () => {
  const exportId = EXPORT_ID + 7;
  const chatId = chatIdOf(exportId);
  const file = path.join(dataDir, 'result.json');
  // Telegram Desktop writes the file with a byte order mark on some systems.
  fs.writeFileSync(file, '﻿' + JSON.stringify(exportOf(exportId, [message(1, '10:00', { text: 'from the command line' })])));

  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/import-cli.ts'), ...args], { encoding: 'utf8', env: process.env });

  const dry = run(file, '--chat-id', String(chatId), '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  assert.match(dry.stdout, /Imported:\s+1 lines, 2026-11-20 10:00 to 2026-11-20 10:00/);
  assert.equal(fs.existsSync(transcript.groupDir(chatId)), false);

  const real = run(file, `--chat-id=${chatId}`);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Days written:\s+1 \(1 new, 0 merged/);
  assert.deepEqual(readDay(chatId, '2026-11-20'), ['[2026-11-20 10:00] Alice Tan [msg 1]: from the command line']);

  assert.notEqual(run(file).status, 0, 'no chat id');
  assert.notEqual(run(file, '--chat-id', 'abc').status, 0, 'chat id is not a number');
  assert.notEqual(run(path.join(dataDir, 'missing.json'), '--chat-id', String(chatId)).status, 0, 'no such file');
  const wrongChat = run(file, '--chat-id', '-1001');
  assert.equal(wrongChat.status, 1);
  assert.match(wrongChat.stderr, /does not match chat id/);

  fs.writeFileSync(file, '{ not json');
  assert.notEqual(run(file, '--chat-id', String(chatId)).status, 0, 'not JSON');
});
