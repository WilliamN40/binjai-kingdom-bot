/**
 * Plain-text transcript store, one folder per group.
 *
 *   DATA_DIR/groups/group_<id>/
 *     transcript/2026-11-26.txt   one line per message, every topic interleaved and tagged
 *     topics.json                 forum topic id -> name
 *     members.json                everyone seen speaking
 *     notes.md                    things the group asked the secretary to remember
 *
 * Everything for a group lives in a single folder on purpose: a question asked
 * in one topic can be answered from what was said in any other topic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const GENERAL_TOPIC = 'General';

// ── Paths ────────────────────────────────────────────────────────────

export function groupsRoot(): string {
  return path.join(config.DATA_DIR, 'groups');
}

export function groupDir(chatId: number): string {
  return path.join(groupsRoot(), `group_${Math.abs(chatId)}`);
}

function transcriptDir(chatId: number): string {
  return path.join(groupDir(chatId), 'transcript');
}

const preparedDirs = new Set<number>();

export function ensureGroupDir(chatId: number): void {
  if (preparedDirs.has(chatId) && fs.existsSync(transcriptDir(chatId))) return;
  const dir = groupDir(chatId);
  fs.mkdirSync(transcriptDir(chatId), { recursive: true });
  // Closed to "other" users: inside the sandbox every group runs as a different
  // Linux user, and only the owning group's user is let into this folder.
  fs.chmodSync(dir, 0o750);
  preparedDirs.add(chatId);
}

// ── Time ─────────────────────────────────────────────────────────────

let formatter: Intl.DateTimeFormat | null = null;

function getFormatter(): Intl.DateTimeFormat {
  if (!formatter) {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    };
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: config.SECRETARY_TIMEZONE });
    } catch {
      console.warn(`[Secretary] Unknown timezone "${config.SECRETARY_TIMEZONE}", using UTC`);
      formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
    }
  }
  return formatter;
}

/** Local day ("2026-11-26") and minute stamp ("2026-11-26 21:33") in the configured timezone. */
export function localTime(date: Date): { day: string; stamp: string } {
  const parts: Record<string, string> = {};
  for (const part of getFormatter().formatToParts(date)) {
    parts[part.type] = part.value;
  }
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, stamp: `${day} ${parts.hour}:${parts.minute}` };
}

// ── Transcript lines ─────────────────────────────────────────────────

/** Keep each message on one physical line so grep results are whole messages. */
export function flatten(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ⏎ ').trim();
}

export function appendTranscript(chatId: number, date: Date, body: string, topic?: string): void {
  ensureGroupDir(chatId);
  const { day, stamp } = localTime(date);
  const topicTag = topic ? ` [#${topic}]` : '';
  const line = `[${stamp}]${topicTag} ${flatten(body)}\n`;
  fs.appendFileSync(path.join(transcriptDir(chatId), `${day}.txt`), line, 'utf8');
}

function listTranscriptFiles(chatId: number): string[] {
  try {
    return fs
      .readdirSync(transcriptDir(chatId))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

const MAX_SCAN_BYTES = 3_000_000;

/**
 * Recent transcript to place directly in a prompt.
 *
 * Most of the budget goes to the latest messages across the whole group;
 * the rest reaches further back for the topic the question was asked in,
 * so a busy neighbouring topic cannot crowd out the local conversation.
 */
export function recentContext(chatId: number, maxChars: number, topic?: string): string {
  const files = listTranscriptFiles(chatId).reverse();
  const dir = transcriptDir(chatId);

  const groupBudget = topic ? Math.floor(maxChars * 0.65) : maxChars;
  const topicMarker = topic ? `] [#${topic}] ` : null;

  const picked: string[] = [];
  let used = 0;
  let scanned = 0;
  let groupPhase = true;

  outer: for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    scanned += content.length;

    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;

      if (groupPhase && used + line.length > groupBudget) {
        if (!topicMarker) break outer;
        groupPhase = false;
      }
      if (!groupPhase) {
        if (!line.includes(topicMarker!)) continue;
        if (used + line.length > maxChars) break outer;
      }

      picked.push(line);
      used += line.length + 1;
    }

    if (scanned > MAX_SCAN_BYTES) break;
  }

  return picked.reverse().join('\n');
}

export interface TranscriptStats {
  days: number;
  firstDay?: string;
  lastDay?: string;
  bytes: number;
}

export function transcriptStats(chatId: number): TranscriptStats {
  const files = listTranscriptFiles(chatId);
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += fs.statSync(path.join(transcriptDir(chatId), file)).size;
    } catch {
      // ignore files that vanish mid-scan
    }
  }
  return {
    days: files.length,
    firstDay: files[0]?.replace('.txt', ''),
    lastDay: files[files.length - 1]?.replace('.txt', ''),
    bytes,
  };
}

// ── Topics ───────────────────────────────────────────────────────────

type TopicMap = Record<string, { name: string; updatedAt: string }>;
const topicCache = new Map<number, TopicMap>();

function topicsPath(chatId: number): string {
  return path.join(groupDir(chatId), 'topics.json');
}

function loadTopics(chatId: number): TopicMap {
  let topics = topicCache.get(chatId);
  if (!topics) {
    try {
      topics = JSON.parse(fs.readFileSync(topicsPath(chatId), 'utf8')) as TopicMap;
    } catch {
      topics = {};
    }
    topicCache.set(chatId, topics);
  }
  return topics;
}

/** Topic names end up inside "[#name]" tags, so strip anything that would break the tag. */
export function cleanTopicName(name: string): string {
  return name.replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Untitled';
}

export function getTopicName(chatId: number, threadId: number): string | undefined {
  return loadTopics(chatId)[String(threadId)]?.name;
}

export function setTopicName(chatId: number, threadId: number, rawName: string): void {
  const name = cleanTopicName(rawName);
  const topics = loadTopics(chatId);
  if (topics[String(threadId)]?.name === name) return;
  topics[String(threadId)] = { name, updatedAt: new Date().toISOString() };
  ensureGroupDir(chatId);
  atomicWriteFileSync(topicsPath(chatId), JSON.stringify(topics, null, 2));
}

export function listTopicNames(chatId: number): string[] {
  return Object.values(loadTopics(chatId)).map((t) => t.name);
}

// ── Members ──────────────────────────────────────────────────────────

interface Member {
  name: string;
  username?: string;
  firstSeen: string;
  lastSeen: string;
  /** Exact time of their latest message (ISO 8601), used for "what did I miss". */
  lastMessageAt?: string;
  messages: number;
}

type MemberMap = Record<string, Member>;
const memberCache = new Map<number, MemberMap>();
const dirtyMembers = new Set<number>();
let memberFlushTimer: ReturnType<typeof setInterval> | null = null;

function membersPath(chatId: number): string {
  return path.join(groupDir(chatId), 'members.json');
}

function loadMembers(chatId: number): MemberMap {
  let members = memberCache.get(chatId);
  if (!members) {
    try {
      members = JSON.parse(fs.readFileSync(membersPath(chatId), 'utf8')) as MemberMap;
    } catch {
      members = {};
    }
    memberCache.set(chatId, members);
  }
  return members;
}

/** Counts a message for a member and returns when they last wrote before this one. */
export function noteMember(
  chatId: number,
  user: { id: number; name: string; username?: string },
  date: Date,
): Date | undefined {
  const members = loadMembers(chatId);
  const day = localTime(date).day;
  const existing = members[String(user.id)];
  let previous: Date | undefined;
  if (existing) {
    previous = existing.lastMessageAt ? new Date(existing.lastMessageAt) : undefined;
    existing.name = user.name;
    existing.username = user.username;
    existing.lastSeen = day;
    existing.lastMessageAt = date.toISOString();
    existing.messages += 1;
  } else {
    members[String(user.id)] = {
      name: user.name,
      username: user.username,
      firstSeen: day,
      lastSeen: day,
      lastMessageAt: date.toISOString(),
      messages: 1,
    };
  }

  dirtyMembers.add(chatId);
  if (!memberFlushTimer) {
    memberFlushTimer = setInterval(flushMembers, 30_000);
    memberFlushTimer.unref();
  }
  return previous;
}

/** Member files are rewritten at most every 30 seconds, and once more on shutdown. */
export function flushMembers(): void {
  for (const chatId of dirtyMembers) {
    try {
      ensureGroupDir(chatId);
      atomicWriteFileSync(membersPath(chatId), JSON.stringify(loadMembers(chatId), null, 2));
    } catch (err) {
      console.error(`[Secretary] Failed to write members for ${chatId}:`, (err as Error).message);
    }
  }
  dirtyMembers.clear();
}

// ── Notes ────────────────────────────────────────────────────────────

const NOTES_PROMPT_CHARS = 8000;

function notesPath(chatId: number): string {
  return path.join(groupDir(chatId), 'notes.md');
}

export function appendNote(chatId: number, note: string, savedBy: string): void {
  ensureGroupDir(chatId);
  const { stamp } = localTime(new Date());
  fs.appendFileSync(notesPath(chatId), `- [${stamp}] (asked by ${flatten(savedBy)}) ${flatten(note)}\n`, 'utf8');
}

/** The most recent notes, trimmed to what is reasonable to put in every prompt. */
export function readNotes(chatId: number): string {
  try {
    const notes = fs.readFileSync(notesPath(chatId), 'utf8').trim();
    if (notes.length <= NOTES_PROMPT_CHARS) return notes;
    const tail = notes.slice(-NOTES_PROMPT_CHARS);
    return tail.slice(tail.indexOf('\n') + 1);
  } catch {
    return '';
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

function forgetCaches(chatId: number): void {
  preparedDirs.delete(chatId);
  topicCache.delete(chatId);
  memberCache.delete(chatId);
  dirtyMembers.delete(chatId);
}

/** Move a group's folder when Telegram gives the chat a new id (group -> supergroup upgrade). */
export function migrateGroupData(oldChatId: number, newChatId: number): void {
  flushMembers();
  const from = groupDir(oldChatId);
  const to = groupDir(newChatId);
  forgetCaches(oldChatId);
  forgetCaches(newChatId);
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(groupsRoot(), { recursive: true });
  fs.renameSync(from, to);
}

export function deleteGroupData(chatId: number): void {
  forgetCaches(chatId);
  fs.rmSync(groupDir(chatId), { recursive: true, force: true });
}

// ── Whole days and digests ───────────────────────────────────────────

/** Every day that has a transcript, oldest first ("2026-11-26"). */
export function listTranscriptDays(chatId: number): string[] {
  return listTranscriptFiles(chatId).map((name) => name.replace('.txt', ''));
}

export function readTranscriptDay(chatId: number, day: string): string {
  try {
    return fs.readFileSync(path.join(transcriptDir(chatId), `${day}.txt`), 'utf8');
  } catch {
    return '';
  }
}

function digestDir(chatId: number): string {
  return path.join(groupDir(chatId), 'digests');
}

export function digestPath(chatId: number, day: string): string {
  return path.join(digestDir(chatId), `${day}.md`);
}

export function listDigestDays(chatId: number): string[] {
  try {
    return fs
      .readdirSync(digestDir(chatId))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.replace('.md', ''))
      .sort();
  } catch {
    return [];
  }
}

/** The most recent digests that fit in `maxChars`, oldest first, for placing in a prompt. */
export function readRecentDigests(chatId: number, maxChars: number): string {
  const picked: string[] = [];
  let used = 0;
  for (const day of listDigestDays(chatId).reverse()) {
    let text: string;
    try {
      text = fs.readFileSync(digestPath(chatId, day), 'utf8').trim();
    } catch {
      continue;
    }
    if (used + text.length > maxChars) break;
    picked.push(text);
    used += text.length + 2;
  }
  return picked.reverse().join('\n\n');
}
