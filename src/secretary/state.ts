/**
 * Persistent bot state for secretary mode: who owns the bot and which
 * groups are being recorded. Stored as JSON in DATA_DIR/state.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface GroupState {
  chatId: number;
  title: string;
  enabled: boolean;
  enabledAt: string;
  enabledBy: number;
  /** Public @username of the group, if it has one (used for message links). */
  username?: string;
  isForum?: boolean;
  /** Linux user id this group's commands run as inside the sandbox. */
  sandboxUid?: number;
  /** Greeting posted when someone joins. "{name}" and "{group}" are filled in. */
  welcome?: string;
  /** Reasoning effort for this group's answers; unset means the configured default. */
  effort?: EffortLevel;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const SANDBOX_UID_BASE = 20000;

interface State {
  ownerIds: number[];
  /** One-time code that turns the sender of `/claim <code>` into an owner. */
  claimCode?: string;
  groups: Record<string, GroupState>;
  /** When the records were last sent to the owners as a backup (ISO time). */
  lastBackupAt?: string;
}

const MAX_CLAIM_ATTEMPTS = 5;

let state: State | null = null;
const claimAttempts = new Map<number, number>();

function statePath(): string {
  return path.join(config.DATA_DIR, 'state.json');
}

function save(): void {
  if (!state) return;
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  atomicWriteFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function load(): State {
  if (state) return state;

  let loaded: State = { ownerIds: [], groups: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<State>;
    loaded = {
      ownerIds: Array.isArray(raw.ownerIds) ? raw.ownerIds : [],
      claimCode: typeof raw.claimCode === 'string' ? raw.claimCode : undefined,
      groups: raw.groups && typeof raw.groups === 'object' ? raw.groups : {},
      lastBackupAt: typeof raw.lastBackupAt === 'string' ? raw.lastBackupAt : undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A corrupt state file must not silently reset ownership.
      throw new Error(`Cannot read ${statePath()}: ${(err as Error).message}`);
    }
  }

  state = loaded;

  // Groups pre-approved through the environment are enabled from the start.
  let changed = false;
  for (const chatId of config.ALLOWED_GROUP_IDS) {
    if (!state.groups[String(chatId)]) {
      state.groups[String(chatId)] = {
        chatId,
        title: `Group ${chatId}`,
        enabled: true,
        enabledAt: new Date().toISOString(),
        enabledBy: 0,
      };
      changed = true;
    }
  }
  if (changed) save();

  return state;
}

// ── Owners ───────────────────────────────────────────────────────────

export function getOwnerIds(): number[] {
  return [...new Set([...config.ALLOWED_USER_IDS, ...load().ownerIds])];
}

export function isOwner(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return config.ALLOWED_USER_IDS.includes(userId) || load().ownerIds.includes(userId);
}

/**
 * Returns the claim code while the bot has no owner, creating one on first use.
 * Once any owner exists there is no code and /claim stops working.
 */
export function getPendingClaimCode(): string | undefined {
  const s = load();
  if (getOwnerIds().length > 0) return undefined;

  const wanted = config.OWNER_CLAIM_CODE?.trim();
  if (wanted) {
    if (s.claimCode !== wanted) {
      s.claimCode = wanted;
      save();
    }
    return wanted;
  }

  if (!s.claimCode) {
    s.claimCode = randomBytes(9).toString('base64url');
    save();
  }
  return s.claimCode;
}

export type ClaimResult = 'claimed' | 'already-owned' | 'wrong-code' | 'locked';

export function claimOwnership(userId: number, code: string): ClaimResult {
  const expected = getPendingClaimCode();
  if (!expected) return 'already-owned';

  const attempts = claimAttempts.get(userId) ?? 0;
  if (attempts >= MAX_CLAIM_ATTEMPTS) return 'locked';

  const a = Buffer.from(code.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    claimAttempts.set(userId, attempts + 1);
    return 'wrong-code';
  }

  const s = load();
  s.ownerIds.push(userId);
  delete s.claimCode;
  save();
  return 'claimed';
}

// ── Groups ───────────────────────────────────────────────────────────

export function getGroup(chatId: number): GroupState | undefined {
  return load().groups[String(chatId)];
}

export function isGroupEnabled(chatId: number): boolean {
  return getGroup(chatId)?.enabled === true;
}

export function listGroups(): GroupState[] {
  return Object.values(load().groups);
}

export function enableGroup(
  chatId: number,
  info: { title: string; enabledBy: number; username?: string; isForum?: boolean },
): GroupState {
  const s = load();
  const existing = s.groups[String(chatId)];
  const group: GroupState = {
    chatId,
    title: info.title,
    enabled: true,
    enabledAt: existing?.enabled ? existing.enabledAt : new Date().toISOString(),
    enabledBy: info.enabledBy,
    username: info.username,
    isForum: info.isForum,
    sandboxUid: existing?.sandboxUid,
    welcome: existing?.welcome,
    effort: existing?.effort,
  };
  s.groups[String(chatId)] = group;
  save();
  return group;
}

/** Each group gets its own sandbox user, assigned once and never reused while the group exists. */
export function sandboxUidFor(chatId: number): number {
  const s = load();
  const group = s.groups[String(chatId)];
  if (!group) throw new Error(`Unknown group ${chatId}`);
  if (group.sandboxUid === undefined) {
    const taken = Object.values(s.groups).map((g) => g.sandboxUid ?? SANDBOX_UID_BASE);
    group.sandboxUid = Math.max(SANDBOX_UID_BASE, ...taken) + 1;
    save();
  }
  return group.sandboxUid;
}

export function disableGroup(chatId: number): boolean {
  const s = load();
  const group = s.groups[String(chatId)];
  if (!group?.enabled) return false;
  group.enabled = false;
  save();
  return true;
}

export function removeGroup(chatId: number): void {
  const s = load();
  delete s.groups[String(chatId)];
  save();
}

export function setWelcome(chatId: number, welcome: string | undefined): void {
  const s = load();
  const group = s.groups[String(chatId)];
  if (!group) return;
  if (welcome) group.welcome = welcome;
  else delete group.welcome;
  save();
}

export function setGroupEffort(chatId: number, effort: EffortLevel | undefined): void {
  const s = load();
  const group = s.groups[String(chatId)];
  if (!group) return;
  if (effort) group.effort = effort;
  else delete group.effort;
  save();
}

/** Keep the stored title / username / forum flag in sync with what Telegram reports. */
export function touchGroup(
  chatId: number,
  info: { title?: string; username?: string; isForum?: boolean },
): void {
  const s = load();
  const group = s.groups[String(chatId)];
  if (!group) return;

  const title = info.title ?? group.title;
  if (group.title === title && group.username === info.username && group.isForum === info.isForum) {
    return;
  }
  group.title = title;
  group.username = info.username;
  group.isForum = info.isForum;
  save();
}

/** A basic group that is upgraded to a supergroup gets a new chat id. */
export function migrateGroupState(oldChatId: number, newChatId: number): void {
  const s = load();
  const group = s.groups[String(oldChatId)];
  if (!group) return;
  delete s.groups[String(oldChatId)];
  s.groups[String(newChatId)] = { ...group, chatId: newChatId };
  save();
}

export function getLastBackupAt(): Date | undefined {
  const value = load().lastBackupAt;
  return value ? new Date(value) : undefined;
}

export function setLastBackupAt(date: Date): void {
  load().lastBackupAt = date.toISOString();
  save();
}

/** Test hook: forget the in-memory copy so the next call re-reads the file. */
export function resetStateCache(): void {
  state = null;
  claimAttempts.clear();
}
