/**
 * Hooks: small scripts in a group's sandbox workspace that react to messages.
 *
 * For every new or edited message in a group that has enabled hooks, the bot
 * runs each hook script in the sandbox with the message as JSON on stdin. A
 * hook answers on stdout with the actions it wants taken:
 *
 *   {"actions": [{"do": "reply", "text": "..."}, {"do": "delete"}]}
 *
 * The scripts are ordinary files under hooks/ in the workspace, written by
 * the secretary (or by anyone, through it). Which ones are active is kept
 * here, on the bot's side, in the group's hooks.json. Scripts only ever
 * *ask* for actions; the bot carries them out from a fixed list, with limits.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message } from 'grammy/types';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { describeContent, senderOf } from './format.js';
import { runHookScripts } from './sandbox.js';
import { groupDir, localTime } from './transcript.js';

export interface Hook {
  name: string;
  /** Script file inside the workspace's hooks/ folder, e.g. "no_emma.py". */
  file: string;
  description: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastError?: string;
  lastErrorAt?: string;
}

export type HookAction =
  | { do: 'reply'; text: string }
  | { do: 'send'; text: string }
  | { do: 'react'; emoji: string }
  | { do: 'delete' }
  | { do: 'pin' }
  | { do: 'note'; text: string }
  | { do: 'ask'; prompt: string };

export interface HookOutcome {
  hook: Hook;
  actions: HookAction[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FILE_PATTERN = /^[A-Za-z0-9][\w.-]{0,79}\.(py|js|mjs|sh)$/;
const MAX_HOOKS = 30;
const MAX_ACTIONS_PER_HOOK = 5;

const cache = new Map<number, Hook[]>();

function filePath(chatId: number): string {
  return path.join(groupDir(chatId), 'hooks.json');
}

function load(chatId: number): Hook[] {
  let hooks = cache.get(chatId);
  if (!hooks) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath(chatId), 'utf8'));
      hooks = Array.isArray(raw) ? (raw as Hook[]) : [];
    } catch {
      hooks = [];
    }
    cache.set(chatId, hooks);
  }
  return hooks;
}

function save(chatId: number): void {
  fs.mkdirSync(groupDir(chatId), { recursive: true });
  atomicWriteFileSync(filePath(chatId), JSON.stringify(load(chatId), null, 2));
}

export function listHooks(chatId: number): Hook[] {
  return [...load(chatId)];
}

export function hasActiveHooks(chatId: number): boolean {
  return load(chatId).some((hook) => hook.enabled);
}

/** Register a hook, or update the one with the same name. It starts enabled. */
export function saveHook(
  chatId: number,
  input: { name: string; file: string; description: string; createdBy: string },
): Hook {
  const name = input.name.trim().toLowerCase();
  const file = input.file.trim().replace(/^hooks\//, '');
  if (!NAME_PATTERN.test(name)) {
    throw new Error('A hook name is 1-40 characters: lowercase letters, digits, "-" and "_".');
  }
  if (!FILE_PATTERN.test(file)) {
    throw new Error('The hook file must be directly inside hooks/ and end in .py, .js, .mjs or .sh, e.g. hooks/no_spam.py.');
  }

  const hooks = load(chatId);
  const existing = hooks.find((hook) => hook.name === name);
  if (existing) {
    existing.file = file;
    existing.description = input.description.trim().slice(0, 300);
    existing.enabled = true;
    delete existing.lastError;
    delete existing.lastErrorAt;
    save(chatId);
    return existing;
  }

  if (hooks.length >= MAX_HOOKS) throw new Error(`This group already has ${MAX_HOOKS} hooks. Remove one first.`);
  const hook: Hook = {
    name,
    file,
    description: input.description.trim().slice(0, 300),
    enabled: true,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  hooks.push(hook);
  save(chatId);
  return hook;
}

export function setHookEnabled(chatId: number, name: string, enabled: boolean): Hook | undefined {
  const hook = load(chatId).find((h) => h.name === name.trim().toLowerCase());
  if (!hook) return undefined;
  hook.enabled = enabled;
  save(chatId);
  return hook;
}

export function removeHook(chatId: number, name: string): Hook | undefined {
  const hooks = load(chatId);
  const index = hooks.findIndex((h) => h.name === name.trim().toLowerCase());
  if (index === -1) return undefined;
  const [removed] = hooks.splice(index, 1);
  save(chatId);
  return removed;
}

export function describeHook(hook: Hook): string {
  const state = hook.enabled ? 'on' : 'off';
  const error = hook.lastError ? ` (last error ${hook.lastErrorAt}: ${hook.lastError})` : '';
  return `[${hook.name}] ${state}, hooks/${hook.file}, by ${hook.createdBy}: ${hook.description}${error}`;
}

export function forgetHooks(chatId: number): void {
  cache.delete(chatId);
}

function messageKind(msg: Message): string {
  if (msg.photo) return 'photo';
  if (msg.animation) return 'gif';
  if (msg.video) return 'video';
  if (msg.video_note) return 'video_note';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'file';
  if (msg.sticker) return 'sticker';
  if (msg.poll) return 'poll';
  if (msg.location || msg.venue) return 'location';
  if (msg.contact) return 'contact';
  if (msg.text !== undefined) return 'text';
  return 'event';
}

/** The JSON a hook receives on stdin. Kept small and stable; `raw` is Telegram's own message object. */
export function buildHookEvent(msg: Message, topic: string | undefined, edited: boolean): Record<string, unknown> {
  const sender = senderOf(msg);
  const reply = msg.reply_to_message && !msg.reply_to_message.forum_topic_created ? msg.reply_to_message : undefined;
  const text = msg.text ?? msg.caption ?? '';
  const links = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0]);
  for (const entity of msg.entities ?? msg.caption_entities ?? []) {
    if (entity.type === 'text_link') links.push(entity.url);
  }

  return {
    event: edited ? 'edit' : 'message',
    chat: { id: msg.chat.id, title: 'title' in msg.chat ? msg.chat.title : undefined },
    topic: topic ?? null,
    message_id: msg.message_id,
    date: new Date(msg.date * 1000).toISOString(),
    local_time: localTime(new Date(msg.date * 1000)).stamp,
    from: { id: sender.id, name: sender.name, username: sender.username ?? null, is_bot: msg.from?.is_bot ?? false },
    kind: messageKind(msg),
    text,
    summary: describeContent(msg),
    links: [...new Set(links)],
    file_name: msg.document?.file_name ?? null,
    reply_to: reply
      ? {
          message_id: reply.message_id,
          from_name: senderOf(reply as Message).name,
          text: (reply as Message).text ?? (reply as Message).caption ?? '',
        }
      : null,
    raw: msg,
  };
}

function parseActions(stdout: string): HookAction[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: unknown[] }).actions
      : parsed && typeof parsed === 'object' && 'do' in parsed
        ? [parsed]
        : [];

  const actions: HookAction[] = [];
  for (const item of list.slice(0, MAX_ACTIONS_PER_HOOK)) {
    if (!item || typeof item !== 'object') continue;
    const action = item as Record<string, unknown>;
    const str = (key: string, max: number) => (typeof action[key] === 'string' ? (action[key] as string).slice(0, max) : '');
    switch (action.do) {
      case 'reply':
      case 'send':
      case 'note':
        if (str('text', 4000).trim()) actions.push({ do: action.do, text: str('text', 4000) });
        break;
      case 'react':
        if (str('emoji', 16)) actions.push({ do: 'react', emoji: str('emoji', 16) });
        break;
      case 'delete':
      case 'pin':
        actions.push({ do: action.do });
        break;
      case 'ask':
        if (str('prompt', 2000).trim()) actions.push({ do: 'ask', prompt: str('prompt', 2000) });
        break;
      default:
        break;
    }
  }
  return actions;
}

/**
 * Run the group's enabled hooks against one message and return what they asked for.
 * A hook that crashes, times out or prints something unreadable is recorded as
 * failed (visible in /hooks) and simply contributes no actions.
 */
export async function runHooks(
  chatId: number,
  uid: number,
  msg: Message,
  topic: string | undefined,
  edited: boolean,
): Promise<HookOutcome[]> {
  const hooks = load(chatId).filter((hook) => hook.enabled);
  if (!hooks.length) return [];

  const results = await runHookScripts(
    chatId,
    uid,
    hooks.map((hook) => hook.file),
    JSON.stringify(buildHookEvent(msg, topic, edited)),
  );

  const outcomes: HookOutcome[] = [];
  let changed = false;
  for (const hook of hooks) {
    const result = results.get(hook.file);
    let error: string | undefined;
    let actions: HookAction[] = [];

    if (!result) {
      error = 'did not run';
    } else if (result.code !== 0) {
      error = result.code === 124 ? 'timed out' : `exit ${result.code}: ${result.stderr.trim().split('\n').pop() ?? ''}`.slice(0, 200);
    } else {
      try {
        actions = parseActions(result.stdout);
      } catch {
        error = `output was not JSON: ${result.stdout.trim().slice(0, 80)}`;
      }
    }

    if (error) {
      hook.lastError = error;
      hook.lastErrorAt = localTime(new Date()).stamp;
      changed = true;
    } else if (hook.lastError) {
      delete hook.lastError;
      delete hook.lastErrorAt;
      changed = true;
    }
    if (actions.length) outcomes.push({ hook, actions });
  }
  if (changed) save(chatId);
  return outcomes;
}
