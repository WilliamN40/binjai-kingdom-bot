/**
 * Loads a group's past history from a Telegram Desktop export ("Export chat
 * history" -> JSON, the result.json file) into the transcript store.
 *
 * Imported lines are written in the same form the live recorder uses (see
 * format.ts), so prompts and searches work on them unchanged. The live record
 * is never rewritten or reordered: lines already on file stay exactly as they
 * are, in the order they are in, and exported messages that are already
 * recorded are skipped. Running the same import twice changes nothing.
 *
 * The export format is not documented, so everything read from it is treated
 * as untrusted: an entry with an unexpected shape degrades to a tag or is
 * counted as unsupported, it never throws.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  GENERAL_TOPIC,
  cleanTopicName,
  digestPath,
  flatten,
  flushMembers,
  getTopicName,
  groupDir,
  listTopicNames,
  localTime,
  noteMember,
  setTopicName,
} from './transcript.js';

export interface ImportOptions {
  /** The group's Telegram chat id as the bot knows it (negative, e.g. -1001234567890). */
  chatId: number;
  /** Work everything out and report it, but write nothing. */
  dryRun?: boolean;
  /** Import even though the export's own chat id does not belong to `chatId`. */
  allowChatMismatch?: boolean;
}

export interface ImportedTopic {
  /** Id of the topic (the message that created it); null for General. */
  threadId: number | null;
  name: string;
  /** Lines the export holds for this topic, whether or not they were already recorded. */
  messages: number;
}

export interface ImportResult {
  dryRun: boolean;
  /** The chat's name as written in the export. */
  chatName?: string;
  /** Entries in the export. */
  total: number;
  /** Lines added to the record (or that would be, in a dry run). */
  imported: number;
  /** Entries left out because the record already has them. */
  skippedExisting: number;
  /** Entries left out because they could not be understood. */
  skippedUnsupported: number;
  /** What the unsupported entries were, e.g. { "service: phone_call": 2 }. */
  unsupportedKinds: Record<string, number>;
  /** Day files created or changed: daysCreated + daysMerged. */
  daysWritten: number;
  daysCreated: number;
  /** Day files that already existed and had lines merged in. */
  daysMerged: number;
  isForum: boolean;
  /** General first, then the export's topics. Empty when the group is not a forum. */
  topics: ImportedTopic[];
  /** First and last minute stamp in the export, in the configured timezone. */
  dateRange?: { from: string; to: string };
  /** First and last minute stamp of the lines that were added. */
  importedRange?: { from: string; to: string };
  /** People added to members.json (only those the record did not know yet). */
  membersAdded: number;
  warnings: string[];
}

/** The export cannot be imported at all (as opposed to single entries being skipped). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

// ── Reading untrusted values ─────────────────────────────────────────

type Raw = Record<string, unknown>;

const DELETED_ACCOUNT = 'Deleted Account';

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

function messageId(value: unknown): number | undefined {
  const id = num(value);
  return id !== undefined && Number.isSafeInteger(id) ? id : undefined;
}

/** Text is a string, or a list mixing strings and { type, text, href? } parts. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (isObject(value) && typeof value.text === 'string') return value.text;
  return '';
}

// ── Formatting, mirroring format.ts ──────────────────────────────────

function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return '';
  const whole = Math.round(seconds);
  return ` ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function snippet(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** URLs hidden behind link text are not part of the visible text, so list them explicitly. */
function hiddenLinks(raw: Raw): string {
  const urls: string[] = [];
  for (const source of [raw.text, raw.text_entities]) {
    if (!Array.isArray(source)) continue;
    for (const part of source) {
      if (isObject(part) && part.type === 'text_link') {
        const href = str(part.href);
        if (href) urls.push(href);
      }
    }
  }
  return urls.length ? ` (links: ${[...new Set(urls)].join(', ')})` : '';
}

function forwardedFrom(raw: Raw): string {
  if (!('forwarded_from' in raw)) return '';
  const name = str(raw.forwarded_from);
  // Present but empty: forwarded from a hidden or deleted account.
  if (!name) return '[forwarded] ';
  const fromChannel = typeof raw.forwarded_from_id === 'string' && raw.forwarded_from_id.startsWith('channel');
  return fromChannel ? `[forwarded from channel ${name}] ` : `[forwarded from ${name}] `;
}

function fileName(raw: Raw): string | undefined {
  const given = str(raw.file_name);
  if (given) return given;
  // Without the files downloaded, the path is a sentence in brackets rather than a path.
  const file = str(raw.file);
  if (!file || file.startsWith('(')) return undefined;
  return file.split(/[\\/]/).pop() || undefined;
}

function mediaTag(raw: Raw): string {
  if (raw.photo !== undefined && raw.photo !== null) return '[photo]';

  const mediaType = str(raw.media_type);
  const length = duration(num(raw.duration_seconds));
  switch (mediaType) {
    case 'animation':
      return '[GIF]';
    case 'video_file':
      return `[video${length}]`;
    case 'video_message':
      return `[video note${length}]`;
    case 'voice_message':
      return `[voice message${length}]`;
    case 'audio_file': {
      const title = [str(raw.performer), str(raw.title)].filter(Boolean).join(' - ') || fileName(raw) || '';
      return `[audio${title ? `: ${title}` : ''}${length}]`;
    }
    case 'sticker': {
      const emoji = str(raw.sticker_emoji);
      return `[sticker${emoji ? ` ${emoji}` : ''}]`;
    }
  }
  if ((raw.file !== undefined && raw.file !== null) || str(raw.file_name)) {
    return `[file: ${fileName(raw) ?? 'unnamed'}]`;
  }
  // A kind of media this importer does not know: keep its name as the tag.
  if (mediaType) return `[${mediaType.replace(/_/g, ' ')}]`;

  if (isObject(raw.poll)) {
    const answers = Array.isArray(raw.poll.answers) ? raw.poll.answers : [];
    const options = answers.map((answer) => textOf(isObject(answer) ? answer.text : answer).trim()).filter(Boolean);
    return `[poll: "${textOf(raw.poll.question)}" options: ${options.join(' | ')}]`;
  }
  if (isObject(raw.location_information)) {
    const place = str(raw.place_name);
    if (place) return `[venue: ${[place, str(raw.address)].filter(Boolean).join(', ')}]`;
    const latitude = num(raw.location_information.latitude);
    const longitude = num(raw.location_information.longitude);
    if (latitude !== undefined && longitude !== undefined) return `[location: ${latitude}, ${longitude}]`;
  }
  if (isObject(raw.contact_information)) {
    const contact = raw.contact_information;
    return `[contact: ${[str(contact.first_name), str(contact.last_name)].filter(Boolean).join(' ')}]`;
  }
  if (isObject(raw.dice)) {
    return `[dice ${[str(raw.dice.emoji), num(raw.dice.value)].filter((part) => part !== undefined).join(' ')}]`;
  }
  return '';
}

/** What the message says: forwarded-from prefix, media tag, then text or caption. */
function describeContent(raw: Raw): string {
  const text = textOf(raw.text) || textOf(raw.text_entities);
  const body = [mediaTag(raw), text].filter(Boolean).join(' ') + hiddenLinks(raw);
  return forwardedFrom(raw) + (body || '[unsupported message type]');
}

// ── Entries ──────────────────────────────────────────────────────────

interface Entry {
  raw: Raw;
  id: number;
  /** Unix time, used for ordering. */
  seconds: number;
  day: string;
  stamp: string;
  /** Exact time; missing when the export only had the exporting machine's wall-clock time. */
  date?: Date;
  service: boolean;
  /** Who sent the message, or who did the thing a service message reports. */
  name: string;
}

function timeOf(raw: Raw): Pick<Entry, 'seconds' | 'day' | 'stamp' | 'date'> | null {
  const unix = num(raw.date_unixtime);
  if (unix !== undefined && unix > 0) {
    const date = new Date(unix * 1000);
    if (!Number.isNaN(date.getTime())) return { seconds: unix, date, ...localTime(date) };
  }
  // Old exports have no date_unixtime, only the wall-clock time of the exporting machine.
  // Its timezone is unknown, so the time is kept as written.
  const wall = typeof raw.date === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw.date) : null;
  if (!wall) return null;
  const seconds = Date.parse(`${raw.date as string}Z`) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return { seconds, day: wall[1], stamp: `${wall[1]} ${wall[2]}` };
}

/** Name of a sender or actor. Anonymous admins post as the group itself. */
function nameOf(name: unknown, peerId: unknown, selfPeer: string | undefined): string {
  if (selfPeer && peerId === selfPeer) return 'Anonymous admin';
  const given = str(name);
  if (given) return given;
  return typeof peerId === 'string' && peerId.startsWith('channel') ? 'Channel' : DELETED_ACCOUNT;
}

function userIdOf(peerId: unknown): number | undefined {
  const match = typeof peerId === 'string' ? /^user(\d+)$/.exec(peerId) : null;
  return match ? messageId(match[1]) : undefined;
}

/** What the entry points at: the message replied to or pinned, which also places it in a topic. */
function parentOf(entry: Entry): number | undefined {
  const { raw } = entry;
  if (entry.service && raw.action === 'pin_message') return messageId(raw.message_id);
  // A reply to a message in another chat says nothing about topics in this one.
  if (raw.reply_to_peer_id !== undefined && raw.reply_to_peer_id !== null) return undefined;
  return messageId(raw.reply_to_message_id);
}

interface Lookup {
  entries: Map<number, Entry>;
  /** Whether the id is the creation message of a forum topic. */
  isTopicRoot(id: number): boolean;
  /** The topic an entry belongs to; null for General. */
  threadOf(id: number): number | null;
}

/** Group events as a sentence, in the words format.ts uses; null when the action is not known. */
function describeEvent(entry: Entry, lookup: Lookup): string | null {
  const { raw, name: actor } = entry;
  const people = (value: unknown): string[] => (Array.isArray(value) ? value : []).map((member) => str(member) ?? DELETED_ACCOUNT);

  switch (raw.action) {
    case 'invite_members': {
      const members = people(raw.members);
      const selfJoin = !members.length || (members.length === 1 && members[0] === actor);
      return selfJoin ? `${actor} joined the group` : `${actor} added ${members.join(', ')} to the group`;
    }
    case 'remove_members': {
      const members = people(raw.members);
      const selfLeft = !members.length || (members.length === 1 && members[0] === actor);
      return selfLeft ? `${actor} left the group` : `${actor} removed ${members.join(', ')} from the group`;
    }
    case 'join_group_by_link':
    case 'join_group_by_request':
      return `${actor} joined the group`;
    case 'edit_group_title': {
      const title = str(raw.title);
      return title ? `${actor} renamed the group to "${title}"` : null;
    }
    case 'edit_group_photo':
      return `${actor} changed the group photo`;
    case 'delete_group_photo':
      return `${actor} removed the group photo`;
    case 'pin_message': {
      const pinnedId = messageId(raw.message_id);
      if (pinnedId === undefined) return `${actor} pinned a message`;
      const pinned = lookup.entries.get(pinnedId);
      const text = pinned && !pinned.service ? textOf(pinned.raw.text) || textOf(pinned.raw.text_entities) : '';
      return `${actor} pinned msg ${pinnedId}${text.trim() ? `: "${snippet(text)}"` : ''}`;
    }
    case 'topic_created':
      return `${actor} created the topic "${str(raw.title) ?? 'Untitled'}"`;
    case 'topic_edit': {
      // The export does not always say which topic was edited.
      const topic = lookup.threadOf(entry.id) === null ? 'a topic' : 'this topic';
      const title = str(raw.new_title);
      if (title) return `${actor} renamed ${topic} to "${title}"`;
      if (raw.new_icon_emoji_id !== undefined) return `${actor} changed ${topic === 'a topic' ? "a topic's" : "this topic's"} icon`;
      return `${actor} updated ${topic}`;
    }
    case 'create_group':
    case 'create_channel':
      return `${actor} created the group`;
    case 'migrate_from_group':
    case 'migrate_to_supergroup':
      return 'The group was upgraded to a supergroup';
    case 'group_call': {
      const seconds = num(raw.duration) ?? num(raw.duration_seconds);
      return seconds !== undefined ? `Video chat ended after${duration(seconds)}` : `${actor} started a video chat`;
    }
    case 'set_messages_ttl': {
      const seconds = num(raw.period);
      return seconds ? `${actor} set messages to auto-delete after ${seconds}s` : `${actor} turned off auto-delete`;
    }
    default:
      return null;
  }
}

/** The transcript body of an ordinary message: `Name [msg 12, reply to msg 9 by Bob]: text`. */
function describeMessage(entry: Entry, lookup: Lookup, selfPeer: string | undefined): string {
  const { raw } = entry;
  const meta = [`msg ${entry.id}`];

  const replyTo = messageId(raw.reply_to_message_id);
  if (raw.reply_to_peer_id !== undefined && raw.reply_to_peer_id !== null) {
    meta.push('reply to a message from another chat');
  } else if (replyTo !== undefined && !lookup.isTopicRoot(replyTo)) {
    // Inside a topic every message that is not a reply points at the topic's creation message.
    const target = lookup.entries.get(replyTo);
    meta.push(target ? `reply to msg ${replyTo} by ${target.name}` : `reply to msg ${replyTo}`);
  }
  if (raw.edited !== undefined || raw.edited_unixtime !== undefined) meta.push('EDITED');

  const anonymous = selfPeer !== undefined && raw.from_id === selfPeer;
  const signature = anonymous && str(raw.author) ? ` "${str(raw.author)}"` : '';
  return `${entry.name}${signature} [${meta.join(', ')}]: ${describeContent(raw)}`;
}

// ── Day files ────────────────────────────────────────────────────────

/** A line to add to the record. */
interface NewLine {
  id: number;
  seconds: number;
  stamp: string;
  event: boolean;
  /** Flattened body, without timestamp and topic tag. */
  body: string;
  text: string;
  topic: number | null;
  member?: { id: number; name: string; date: Date };
}

/** A line already in the record. Kept byte for byte; only read to find where new lines go. */
interface OldLine {
  text: string;
  stamp: string;
  event: boolean;
  body?: string;
  id?: number;
  edited?: boolean;
}

const RECORDED_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (?:\[#[^\]]*\] )?(.*)$/s;
/** The line's own message number: the first "[msg N…]" after the sender's name. */
const OWN_MESSAGE_ID = / \[msg (\d+)(?:, ([^\]]*))?\]/;

function parseRecorded(content: string): OldLine[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  let lastStamp = '';
  return lines.map((text): OldLine => {
    const match = RECORDED_LINE.exec(text);
    // Not a transcript line: it stays attached to the line before it.
    if (!match) return { text, stamp: lastStamp, event: false };
    lastStamp = match[1];
    const body = match[2];
    if (body.startsWith('* ')) return { text, stamp: lastStamp, event: true, body };
    const own = OWN_MESSAGE_ID.exec(body);
    return {
      text,
      stamp: lastStamp,
      event: false,
      id: own ? Number(own[1]) : undefined,
      edited: own?.[2]?.split(', ').includes('EDITED') ?? false,
    };
  });
}

/**
 * Leaves out what the day's record already has.
 *
 * Messages are matched by their number. Events carry no number in the record,
 * so an exported event is taken as recorded when the record has an event in
 * the same minute: the identical one if there is one, otherwise any one not
 * yet matched (the live wording can differ slightly from the imported one).
 */
function dropRecorded(recorded: OldLine[], candidates: NewLine[]): NewLine[] {
  const ids = new Set<number>();
  const events = new Map<string, string[]>();
  for (const line of recorded) {
    if (line.id !== undefined) ids.add(line.id);
    if (line.event && line.body !== undefined) {
      const bodies = events.get(line.stamp) ?? [];
      bodies.push(line.body);
      events.set(line.stamp, bodies);
    }
  }

  const fresh = candidates.filter((line) => {
    if (ids.has(line.id)) return false;
    ids.add(line.id);
    return true;
  });

  const matched = new Set<NewLine>();
  for (const exactOnly of [true, false]) {
    for (const line of fresh) {
      if (!line.event || matched.has(line)) continue;
      const bodies = events.get(line.stamp);
      if (!bodies?.length) continue;
      const index = exactOnly ? bodies.indexOf(line.body) : 0;
      if (index < 0) continue;
      bodies.splice(index, 1);
      matched.add(line);
    }
  }
  return fresh.filter((line) => !matched.has(line));
}

/**
 * Chronological merge. Recorded lines keep their order; each new line goes in
 * front of the first recorded line that is later than it. Within one minute
 * (the record's resolution) message numbers decide, since they only go up.
 */
function mergeLines(recorded: OldLine[], fresh: NewLine[]): string[] {
  const merged: string[] = [];
  let next = 0;
  for (const line of recorded) {
    while (next < fresh.length && goesBefore(fresh[next], line)) merged.push(fresh[next++].text);
    merged.push(line.text);
  }
  while (next < fresh.length) merged.push(fresh[next++].text);
  return merged;
}

function goesBefore(fresh: NewLine, recorded: OldLine): boolean {
  if (fresh.stamp !== recorded.stamp) return fresh.stamp < recorded.stamp;
  // An EDITED line carries the number of an older message, so it says nothing about order.
  return recorded.id !== undefined && !recorded.edited && fresh.id < recorded.id;
}

interface DayFile {
  content: string;
  size: number;
  stat: fs.Stats;
}

function readDayFile(file: string): DayFile | null {
  try {
    const data = fs.readFileSync(file);
    return { content: data.toString('utf8'), size: data.length, stat: fs.statSync(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sizeOnDisk(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** A replaced file must stay appendable by the bot, whoever ran the import. */
function keepOwner(file: string, before: fs.Stats): void {
  try {
    const after = fs.statSync(file);
    if (after.uid !== before.uid || after.gid !== before.gid) fs.chownSync(file, before.uid, before.gid);
  } catch {
    // Not permitted: the file stays owned by whoever ran the import.
  }
}

const MAX_WRITE_ATTEMPTS = 5;

/**
 * Adds the day's new lines to its file and returns the ones that were added.
 * The bot may be appending to the same file, so the file is replaced only if
 * it is still the size it was when it was read; otherwise it is read again.
 */
function writeDay(file: string, candidates: NewLine[], dryRun: boolean): { added: NewLine[]; existed: boolean } {
  for (let attempt = 1; ; attempt++) {
    const before = readDayFile(file);
    const recorded = before ? parseRecorded(before.content) : [];
    const added = dropRecorded(recorded, candidates);
    if (dryRun || !added.length) return { added, existed: before !== null };

    const merged = mergeLines(recorded, added).join('\n') + '\n';
    if (sizeOnDisk(file) !== (before?.size ?? -1)) {
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        throw new ImportError(`${path.basename(file)} keeps changing while it is being merged. Run the import again when the group is quiet.`);
      }
      continue;
    }
    atomicWriteFileSync(file, merged, before ? { mode: before.stat.mode & 0o777 } : undefined);
    if (before) keepOwner(file, before.stat);
    return { added, existed: before !== null };
  }
}

// ── The import ───────────────────────────────────────────────────────

function knownMemberIds(chatId: number): Set<string> {
  try {
    const members: unknown = JSON.parse(fs.readFileSync(path.join(groupDir(chatId), 'members.json'), 'utf8'));
    return new Set(isObject(members) ? Object.keys(members) : []);
  } catch {
    return new Set();
  }
}

/** A supergroup's chat id is its bare id, as found in an export, behind "-100". */
const SUPERGROUP_OFFSET = 1_000_000_000_000;

/** The chat ids an export id can stand for: a basic group (-id) or a supergroup (-100id). */
function belongsToChat(exportId: number, chatId: number): boolean {
  const bare = Math.abs(chatId);
  return bare === exportId || bare === SUPERGROUP_OFFSET + exportId;
}

export function importTelegramExport(exportData: unknown, options: ImportOptions): ImportResult {
  const { chatId } = options;
  const dryRun = options.dryRun === true;
  const warnings: string[] = [];

  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new ImportError('The chat id must be a whole number other than 0.');
  }
  if (!isObject(exportData) || !Array.isArray(exportData.messages)) {
    const wholeAccount = isObject(exportData) && isObject(exportData.chats);
    throw new ImportError(
      wholeAccount
        ? 'This is an export of a whole account. Export the one group instead: open it in Telegram Desktop, then ⋮ → Export chat history → format JSON.'
        : 'This is not a Telegram Desktop chat export: there is no "messages" list in it.',
    );
  }

  const messages: unknown[] = exportData.messages;

  const givenId = messageId(exportData.id);
  const exportId = givenId !== undefined ? Math.abs(givenId) : undefined;
  if (exportId === undefined) {
    warnings.push('The export does not say which chat it is from, so it could not be checked against the chat id.');
  } else if (!belongsToChat(exportId, chatId)) {
    const problem = `The export is of chat ${exportId} ("${str(exportData.name) ?? 'unnamed'}"), which does not match chat id ${chatId} (expected ${-(SUPERGROUP_OFFSET + exportId)} for a supergroup or ${-exportId} for a basic group).`;
    if (!options.allowChatMismatch) throw new ImportError(problem);
    warnings.push(`${problem} Imported anyway, as asked.`);
  }
  // Anonymous admins post as the group itself.
  const selfPeer = exportId !== undefined ? `channel${exportId}` : undefined;

  const unsupportedKinds: Record<string, number> = {};
  let skippedUnsupported = 0;
  const unsupported = (kind: string): void => {
    skippedUnsupported++;
    unsupportedKinds[kind] = (unsupportedKinds[kind] ?? 0) + 1;
  };

  // ── Pass 1: what is in the export ──────────────────────────────────
  const entries = new Map<number, Entry>();
  let wallClockTimes = 0;
  for (const raw of messages) {
    if (!isObject(raw)) {
      unsupported('malformed entry');
      continue;
    }
    const id = messageId(raw.id);
    const time = timeOf(raw);
    if (id === undefined || !time) {
      unsupported(id === undefined ? 'entry without an id' : 'entry without a date');
      continue;
    }
    if (entries.has(id)) {
      unsupported('repeated message id');
      continue;
    }
    if (!time.date) wallClockTimes++;
    const service = raw.type === 'service';
    const name = service ? nameOf(raw.actor, raw.actor_id, selfPeer) : nameOf(raw.from, raw.from_id, selfPeer);
    entries.set(id, { raw, id, service, name, ...time });
  }
  if (wallClockTimes) {
    warnings.push(
      `${wallClockTimes} ${wallClockTimes === 1 ? 'entry has' : 'entries have'} no date_unixtime; the time was taken as written by the exporting computer, whatever its timezone was.`,
    );
  }

  const ordered = [...entries.values()].sort((a, b) => a.seconds - b.seconds || a.id - b.id);

  // ── Topics ─────────────────────────────────────────────────────────
  const topicTitles = new Map<number, string>();
  for (const entry of ordered) {
    if (entry.service && entry.raw.action === 'topic_created') {
      topicTitles.set(entry.id, str(entry.raw.title) ?? 'Untitled');
    }
  }
  const isForum = topicTitles.size > 0 || listTopicNames(chatId).length > 0;

  const parents = new Map<number, number>();
  for (const entry of ordered) {
    const parent = parentOf(entry);
    if (parent !== undefined && parent !== entry.id) parents.set(entry.id, parent);
  }

  // A topic can also be known to the bot without its creation message being in the export
  // (an export of a date range, for example).
  const isTopicRoot = (id: number): boolean => topicTitles.has(id) || getTopicName(chatId, id) !== undefined;

  const threads = new Map<number, number | null>();
  const threadOf = (id: number): number | null => {
    const walked = new Set<number>();
    let current: number | undefined = id;
    let found: number | null = null;
    while (current !== undefined && !walked.has(current)) {
      if (isTopicRoot(current)) {
        found = current;
        break;
      }
      const known = threads.get(current);
      if (known !== undefined) {
        found = known;
        break;
      }
      walked.add(current);
      current = parents.get(current);
    }
    for (const step of walked) threads.set(step, found);
    return found;
  };

  // Renames, oldest first, so a topic ends up under its latest name.
  let unplacedRenames = 0;
  for (const entry of ordered) {
    if (!entry.service || entry.raw.action !== 'topic_edit') continue;
    const title = str(entry.raw.new_title);
    if (!title) continue;
    const thread = threadOf(entry.id);
    if (thread !== null && topicTitles.has(thread)) topicTitles.set(thread, title);
    else unplacedRenames++;
  }
  if (unplacedRenames) {
    warnings.push(
      `${unplacedRenames} topic rename(s) could not be applied, because the export does not say which topic was renamed. ` +
        'Those topics keep the name they were created with, unless the bot already knows a newer one.',
    );
  }

  // A name the bot already uses wins, so imported lines carry the same tag as the live ones.
  const topicName = (thread: number | null): string => {
    if (thread === null) return GENERAL_TOPIC;
    return getTopicName(chatId, thread) ?? cleanTopicName(topicTitles.get(thread) ?? `topic ${thread}`);
  };

  // ── Pass 2: one transcript line per entry ──────────────────────────
  const lookup: Lookup = { entries, isTopicRoot, threadOf };
  const byDay = new Map<string, NewLine[]>();
  const topicCounts = new Map<number | null, number>();

  for (const entry of ordered) {
    let body: string;
    if (entry.service) {
      const event = describeEvent(entry, lookup);
      if (!event) {
        unsupported(`service: ${str(entry.raw.action) ?? 'unknown action'}`);
        continue;
      }
      body = flatten(`* ${event}`);
    } else {
      body = flatten(describeMessage(entry, lookup, selfPeer));
    }

    const thread = isForum ? threadOf(entry.id) : null;
    const tag = isForum ? ` [#${topicName(thread)}]` : '';
    topicCounts.set(thread, (topicCounts.get(thread) ?? 0) + 1);

    const userId = entry.service ? undefined : userIdOf(entry.raw.from_id);
    const line: NewLine = {
      id: entry.id,
      seconds: entry.seconds,
      stamp: entry.stamp,
      event: entry.service,
      body,
      text: `[${entry.stamp}]${tag} ${body}`,
      topic: thread,
      member:
        userId !== undefined && entry.date && entry.name !== DELETED_ACCOUNT
          ? { id: userId, name: entry.name, date: entry.date }
          : undefined,
    };
    const lines = byDay.get(entry.day) ?? [];
    lines.push(line);
    byDay.set(entry.day, lines);
  }

  // ── Write ──────────────────────────────────────────────────────────
  const dir = path.join(groupDir(chatId), 'transcript');
  const membersBefore = knownMemberIds(chatId);
  const newMembers = new Set<number>();
  let prepared = false;
  let imported = 0;
  let skippedExisting = 0;
  let daysCreated = 0;
  let daysMerged = 0;
  const staleDigests: string[] = [];
  let firstImported: string | undefined;
  let lastImported: string | undefined;

  try {
    for (const day of [...byDay.keys()].sort()) {
      const candidates = byDay.get(day)!;
      if (!dryRun && !prepared) {
        fs.mkdirSync(dir, { recursive: true });
        // Same as the store: closed to "other" users (a no-op on Windows).
        fs.chmodSync(groupDir(chatId), 0o750);
        prepared = true;
      }

      const { added, existed } = writeDay(path.join(dir, `${day}.txt`), candidates, dryRun);
      skippedExisting += candidates.length - added.length;
      if (!added.length) continue;

      imported += added.length;
      if (existed) {
        daysMerged++;
        if (fs.existsSync(digestPath(chatId, day))) staleDigests.push(day);
      } else {
        daysCreated++;
      }
      firstImported ??= added[0].stamp;
      lastImported = added[added.length - 1].stamp;

      // Only people the record does not know yet: noteMember would otherwise move a live
      // member's "last message" back in time and drop their username.
      for (const line of added) {
        if (!line.member || membersBefore.has(String(line.member.id))) continue;
        newMembers.add(line.member.id);
        if (!dryRun) noteMember(chatId, { id: line.member.id, name: line.member.name }, line.member.date);
      }
    }
  } finally {
    // Also when a day could not be written: the days before it are on file, and so must their authors be.
    if (!dryRun && newMembers.size) flushMembers();
  }

  if (staleDigests.length) {
    const shown = staleDigests.slice(0, 10).join(', ') + (staleDigests.length > 10 ? ', …' : '');
    warnings.push(
      `${staleDigests.length} day(s) that gained lines already have a digest, which does not cover them: ${shown}. ` +
        'Delete those files in the digests folder to have them written again.',
    );
  }

  if (!dryRun) {
    for (const [thread, title] of topicTitles) {
      if (getTopicName(chatId, thread) === undefined) setTopicName(chatId, thread, title);
    }
  }

  const topics: ImportedTopic[] = isForum
    ? [
        { threadId: null, name: GENERAL_TOPIC, messages: topicCounts.get(null) ?? 0 },
        ...[...new Set([...topicTitles.keys(), ...topicCounts.keys()])]
          .filter((thread): thread is number => thread !== null)
          .map((thread) => ({ threadId: thread, name: topicName(thread), messages: topicCounts.get(thread) ?? 0 })),
      ]
    : [];

  return {
    dryRun,
    chatName: str(exportData.name),
    total: messages.length,
    imported,
    skippedExisting,
    skippedUnsupported,
    unsupportedKinds,
    daysWritten: daysCreated + daysMerged,
    daysCreated,
    daysMerged,
    isForum,
    topics,
    dateRange: ordered.length ? { from: ordered[0].stamp, to: ordered[ordered.length - 1].stamp } : undefined,
    importedRange: firstImported && lastImported ? { from: firstImported, to: lastImported } : undefined,
    membersAdded: newMembers.size,
    warnings,
  };
}
