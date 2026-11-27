/**
 * Tool guard for the group secretary.
 *
 * Anyone in a group can talk to the secretary, so the Claude process behind
 * it gets a read-only view of exactly one folder: that group's record. This
 * check runs before every tool call and is what keeps one group's questions
 * away from another group's history, the bot's secrets, and the rest of the
 * machine.
 *
 * The secretary's own tools (notes, schedules, sandbox commands) are let
 * through by name: each of them is implemented by the bot and scoped to the
 * group it was created for.
 */

import * as path from 'path';
import { isPathWithinRoot } from '../utils/workspace-guard.js';

export const SECRETARY_TOOL_PREFIX = 'mcp__secretary__';

export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

export interface GuardOptions {
  webSearch: boolean;
  /** Full names of the bot-implemented tools offered in this run. */
  ownTools: string[];
  /** MCP servers the group added; all their tools run inside the group's sandbox. */
  mcpServers?: string[];
}

const deny = (reason: string): GuardDecision => ({ allowed: false, reason });
const allow: GuardDecision = { allowed: true };

function insideRoot(root: string, candidate: unknown): boolean {
  if (candidate === undefined || candidate === null || candidate === '') return true; // tool default = cwd
  if (typeof candidate !== 'string') return false;
  if (candidate.includes('\0')) return false;
  if (candidate.startsWith('~')) return false; // never let a tool expand this to the home directory
  return isPathWithinRoot(root, path.resolve(root, candidate));
}

function safePattern(pattern: unknown): boolean {
  if (pattern === undefined || pattern === null) return true;
  if (typeof pattern !== 'string') return false;
  if (pattern.startsWith('~')) return false;
  if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith('\\')) return false;
  return !pattern.split(/[\\/]/).includes('..');
}

export function checkToolUse(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
  options: GuardOptions,
): GuardDecision {
  const outside = "You can only read files inside this group's record. Use run_command for files in the workspace.";

  if (options.ownTools.includes(toolName)) return allow;
  if (options.mcpServers?.some((name) => toolName.startsWith(`mcp__${name}__`))) return allow;

  switch (toolName) {
    case 'Read':
      if (typeof input.file_path !== 'string' || !input.file_path) return deny('Read needs a file path.');
      return insideRoot(root, input.file_path) ? allow : deny(outside);

    case 'Grep':
      if (!insideRoot(root, input.path)) return deny(outside);
      return safePattern(input.glob) ? allow : deny(outside);

    case 'Glob':
      if (!insideRoot(root, input.path)) return deny(outside);
      return safePattern(input.pattern) ? allow : deny(outside);

    case 'WebSearch':
      return options.webSearch ? allow : deny('Web search is turned off for this bot.');

    default:
      return deny(`The ${toolName} tool is not available to the group secretary.`);
  }
}
