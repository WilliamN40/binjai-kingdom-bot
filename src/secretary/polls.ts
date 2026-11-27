/**
 * Polls the bot posted, by poll id. Telegram reports a vote with only the poll id
 * (no chat, no question), so this is how a vote finds its group and its wording
 * for the record. Kept in DATA_DIR/polls.json so votes after a restart still count.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface PollInfo {
  chatId: number;
  topic?: string;
  threadId?: number;
  messageId: number;
  question: string;
  options: string[];
  anonymous: boolean;
  at: string;
}

const MAX_POLLS = 500;
let cache: Record<string, PollInfo> | null = null;

function filePath(): string {
  return path.join(config.DATA_DIR, 'polls.json');
}

function load(): Record<string, PollInfo> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Record<string, PollInfo>;
  } catch {
    cache = {};
  }
  return cache;
}

export function rememberPoll(pollId: string, info: PollInfo): void {
  const polls = load();
  polls[pollId] = info;
  const ids = Object.keys(polls);
  if (ids.length > MAX_POLLS) {
    for (const id of ids.sort((a, b) => polls[a].at.localeCompare(polls[b].at)).slice(0, ids.length - MAX_POLLS)) delete polls[id];
  }
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  atomicWriteFileSync(filePath(), JSON.stringify(polls));
}

export function findPoll(pollId: string): PollInfo | undefined {
  return load()[pollId];
}

/** "Alice voted for "Song Fa" in the poll "Dinner?" (msg 120)", or a withdrawn vote. */
export function describeVote(poll: PollInfo, voter: string, optionIds: number[]): string {
  if (!optionIds.length) return `* ${voter} took back their vote in the poll "${poll.question}" (msg ${poll.messageId})`;
  const chosen = optionIds.map((i) => `"${poll.options[i] ?? `option ${i + 1}`}"`).join(', ');
  return `* ${voter} voted for ${chosen} in the poll "${poll.question}" (msg ${poll.messageId})`;
}

export function describeResult(poll: PollInfo, counts: Array<{ text: string; voter_count: number }>, total: number): string {
  const tally = counts.map((o) => `${o.text} ${o.voter_count}`).join(', ');
  return `* The poll "${poll.question}" (msg ${poll.messageId}) closed: ${tally} (${total} voter${total === 1 ? '' : 's'})`;
}

/** For tests. */
export function resetPollCache(): void {
  cache = null;
}
