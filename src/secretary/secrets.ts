/**
 * Per-group secrets (API keys, tokens) set from the chat with /secret.
 *
 * They are kept on the bot's side in DATA_DIR/secrets.json (mode 0600, outside
 * the groups/ folder the sandbox can read) and handed to that group's sandbox
 * commands, hooks and scripts as environment variables. Anyone who can ask the
 * secretary to run commands can therefore use them: a secret is shared with the
 * group, not hidden from it. What it protects against is the key sitting in the
 * chat history, the transcript and the backups.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

interface StoredSecret {
  value: string;
  setBy: string;
  setAt: string;
}

type SecretFile = Record<string, Record<string, StoredSecret>>;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Variables the sandbox sets itself; a secret may not take their place. */
const RESERVED = new Set([
  'PATH', 'HOME', 'TMPDIR', 'RECORD', 'LANG', 'TZ', 'SANDBOX_CMD', 'HOOK_FILES', 'SCHEDULED_SCRIPT',
  'CHROMIUM', 'MPLBACKEND', 'MPLCONFIGDIR', 'XDG_CACHE_HOME', 'GIT_TERMINAL_PROMPT',
]);

const MAX_SECRETS = 40;
const MAX_VALUE_LENGTH = 8000;

let cache: SecretFile | null = null;

function filePath(): string {
  return path.join(config.DATA_DIR, 'secrets.json');
}

function load(): SecretFile {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as SecretFile;
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  atomicWriteFileSync(filePath(), JSON.stringify(load(), null, 2), { mode: 0o600 });
}

/** Why this name cannot be used, or undefined if it can. */
export function secretNameProblem(name: string): string | undefined {
  if (!SECRET_NAME.test(name)) return 'A secret name is 2-64 characters: capital letters, digits and "_", starting with a letter (e.g. AGENTMAIL_API_KEY).';
  if (RESERVED.has(name)) return `${name} is set by the workspace itself; pick another name.`;
  return undefined;
}

export function setSecret(chatId: number, name: string, value: string, setBy: string): void {
  const problem = secretNameProblem(name);
  if (problem) throw new Error(problem);
  if (!value || value.length > MAX_VALUE_LENGTH) throw new Error(`The value must be 1-${MAX_VALUE_LENGTH} characters.`);
  const all = load();
  const group = (all[String(chatId)] ??= {});
  if (!group[name] && Object.keys(group).length >= MAX_SECRETS) throw new Error(`This group already has ${MAX_SECRETS} secrets.`);
  group[name] = { value, setBy, setAt: new Date().toISOString() };
  save();
}

export function removeSecret(chatId: number, name: string): boolean {
  const group = load()[String(chatId)];
  if (!group?.[name]) return false;
  delete group[name];
  save();
  return true;
}

/** Names only, with who set them: never the values. */
export function listSecrets(chatId: number): Array<{ name: string; setBy: string; setAt: string }> {
  return Object.entries(load()[String(chatId)] ?? {}).map(([name, s]) => ({ name, setBy: s.setBy, setAt: s.setAt }));
}

/** The environment variables a group's sandbox commands get. */
export function secretEnv(chatId: number): Record<string, string> {
  return Object.fromEntries(Object.entries(load()[String(chatId)] ?? {}).map(([name, s]) => [name, s.value]));
}

export function forgetSecrets(chatId: number): void {
  const all = load();
  if (!all[String(chatId)]) return;
  delete all[String(chatId)];
  save();
}

export function migrateSecrets(oldChatId: number, newChatId: number): void {
  const all = load();
  if (!all[String(oldChatId)]) return;
  all[String(newChatId)] = all[String(oldChatId)];
  delete all[String(oldChatId)];
  save();
}

/** For tests. */
export function resetSecretsCache(): void {
  cache = null;
}
