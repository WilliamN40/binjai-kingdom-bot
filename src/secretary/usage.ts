/**
 * Usage log: one line per Claude run, per group, so the owner can see who is
 * using how much. Costs are what the same work would cost at API prices; on a
 * subscription they are a measure of how much of the plan was used, not a bill.
 */

import * as fs from 'fs';
import * as path from 'path';
import { groupDir } from './transcript.js';

export interface UsageEntry {
  /** ISO time the run finished. */
  t: string;
  kind: 'ask' | 'task' | 'hook' | 'digest';
  userId?: number;
  name: string;
  costUsd: number;
  seconds: number;
  turns: number;
}

function filePath(chatId: number): string {
  return path.join(groupDir(chatId), 'usage.jsonl');
}

export function logUsage(chatId: number, entry: UsageEntry): void {
  try {
    fs.mkdirSync(groupDir(chatId), { recursive: true });
    fs.appendFileSync(filePath(chatId), JSON.stringify(entry) + '\n', 'utf8');
  } catch (error) {
    console.warn('[Usage] Could not write the usage log:', (error as Error).message);
  }
}

export interface UsageRow {
  name: string;
  runs: number;
  costUsd: number;
  seconds: number;
}

/** Totals per person (and per kind of automatic run) over the last `days` days. */
export function summarizeUsage(chatId: number, days: number, now = new Date()): { rows: UsageRow[]; total: UsageRow } {
  const since = now.getTime() - days * 86_400_000;
  const byName = new Map<string, UsageRow>();
  const total: UsageRow = { name: 'Total', runs: 0, costUsd: 0, seconds: 0 };

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(filePath(chatId), 'utf8').split('\n');
  } catch {
    // no usage yet
  }

  for (const line of lines) {
    if (!line) continue;
    let entry: UsageEntry;
    try {
      entry = JSON.parse(line) as UsageEntry;
    } catch {
      continue;
    }
    if (new Date(entry.t).getTime() < since) continue;

    const label =
      entry.kind === 'digest' ? 'Daily digest' : entry.kind === 'task' ? `Scheduled tasks (${entry.name})` : entry.kind === 'hook' ? `Hooks (${entry.name})` : entry.name;
    const row = byName.get(label) ?? { name: label, runs: 0, costUsd: 0, seconds: 0 };
    row.runs += 1;
    row.costUsd += entry.costUsd || 0;
    row.seconds += entry.seconds || 0;
    byName.set(label, row);

    total.runs += 1;
    total.costUsd += entry.costUsd || 0;
    total.seconds += entry.seconds || 0;
  }

  return { rows: [...byName.values()].sort((a, b) => b.costUsd - a.costUsd), total };
}

export function formatUsage(chatId: number, days: number): string {
  const { rows, total } = summarizeUsage(chatId, days);
  if (!total.runs) return `No Claude usage in the last ${days} day(s).`;
  const line = (row: UsageRow) => `• ${row.name}: ${row.runs} run(s), about $${row.costUsd.toFixed(2)}, ${Math.round(row.seconds / 60)} min`;
  return [
    `Claude usage, last ${days} day(s):`,
    ...rows.map(line),
    '',
    `Total: ${total.runs} run(s), about $${total.costUsd.toFixed(2)}.`,
    'Dollar figures are API-price equivalents, a measure of plan usage rather than a bill.',
  ].join('\n');
}
