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
  /** Which events it runs on; unset means new and edited messages only. */
  events?: HookEventType[];
  lastError?: string;
  lastErrorAt?: string;
}

export type HookAction =
  | { do: 'reply'; text: string }
  | { do: 'send'; text: string }
  | { do: 'react'; emoji: string }
  /** A picture posted as a real photo: from an https URL (Telegram fetches it) or a file in the workspace. */
  | { do: 'photo'; url?: string; file?: string; caption?: string; reply: boolean }
  /** Without message_id: the message the hook is running on. With it: an earlier message in the group. */
  | { do: 'delete'; message_id?: number }
  | { do: 'pin'; message_id?: number }
  | { do: 'note'; text: string }
  | { do: 'ask'; prompt: string }
  /** Any Telegram Bot API method that anyone may use (see telegram-api.ts), pointed at this group. */
  | { do: 'api'; method: string; params: Record<string, unknown> };

export interface HookOutcome {
  hook: Hook;
  actions: HookAction[];
}

export const HOOK_EVENTS = ['message', 'edit', 'callback', 'reaction', 'poll_answer'] as const;
export type HookEventType = (typeof HOOK_EVENTS)[number];
const DEFAULT_EVENTS: HookEventType[] = ['message', 'edit'];

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

export function hasActiveHooks(chatId: number, type?: HookEventType): boolean {
  return load(chatId).some((hook) => hook.enabled && (!type || (hook.events ?? DEFAULT_EVENTS).includes(type)));
}

/** Register a hook, or update the one with the same name. It starts enabled. */
export function saveHook(
  chatId: number,
  input: { name: string; file: string; description: string; createdBy: string; events?: HookEventType[] },
): Hook {
  const events = input.events?.length ? [...new Set(input.events)].filter((e) => HOOK_EVENTS.includes(e)) : undefined;
  const sameAsDefault = !events || (events.length === 2 && events.includes('message') && events.includes('edit'));
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
    if (sameAsDefault) delete existing.events;
    else existing.events = events;
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
    ...(sameAsDefault ? {} : { events }),
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
  const events = hook.events ? `, on ${hook.events.join('/')}` : '';
  return `[${hook.name}] ${state}${events}, hooks/${hook.file}, by ${hook.createdBy}: ${hook.description}${error}`;
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

/** A workspace path a hook may post: relative, no "..", no hidden folders. */
const WORKSPACE_FILE = /^(?!\/)(?!.*(?:^|\/)\.)[\w./-]{1,300}$/;

export function parseActions(stdout: string): HookAction[] {
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
      case 'photo': {
        const url = str('url', 2000).trim();
        const file = str('file', 300).trim().replace(/^\.\//, '');
        const caption = str('caption', 1024);
        const source = /^https:\/\/\S+$/i.test(url) ? { url } : WORKSPACE_FILE.test(file) ? { file } : undefined;
        if (source) actions.push({ do: 'photo', ...source, ...(caption.trim() ? { caption } : {}), reply: action.reply !== false });
        break;
      }
      case 'delete':
      case 'pin': {
        const id = action.message_id;
        actions.push(typeof id === 'number' && Number.isInteger(id) && id > 0 ? { do: action.do, message_id: id } : { do: action.do });
        break;
      }
      case 'ask':
        if (str('prompt', 2000).trim()) actions.push({ do: 'ask', prompt: str('prompt', 2000) });
        break;
      case 'api': {
        const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params) ? action.params : {};
        if (str('method', 60)) actions.push({ do: 'api', method: str('method', 60), params: params as Record<string, unknown> });
        break;
      }
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
  return runHooksForEvent(chatId, uid, buildHookEvent(msg, topic, edited));
}

/**
 * Run the group's enabled hooks on any event: a message, or a button press, reaction
 * or poll vote (those carry no message of their own, see group.ts).
 */
export async function runHooksForEvent(chatId: number, uid: number, event: Record<string, unknown>): Promise<HookOutcome[]> {
  // A hook only sees the kinds of event it asked for: older hooks were written for messages.
  const type = event.event as HookEventType;
  const hooks = load(chatId).filter((hook) => hook.enabled && (hook.events ?? DEFAULT_EVENTS).includes(type));
  if (!hooks.length) return [];

  const results = await runHookScripts(
    chatId,
    uid,
    hooks.map((hook) => hook.file),
    JSON.stringify(event),
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
