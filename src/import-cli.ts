/**
 * Loads a group's past history from a Telegram Desktop export into its record.
 *
 *   node dist/import-cli.js <path to result.json> --chat-id <id> [--dry-run]
 *
 * Runs inside the bot's container, with the bot's environment (DATA_DIR,
 * SECRETARY_TIMEZONE, …). See src/secretary/import.ts for what it does.
 */

import * as fs from 'fs';
import type { ImportResult } from './secretary/import.js';

const USAGE = `Usage: node dist/import-cli.js <path to result.json> --chat-id <id> [--dry-run] [--force]

  <path to result.json>  the file from Telegram Desktop: ⋮ → Export chat history → format JSON
  --chat-id <id>         the group's chat id as the bot knows it, e.g. -1001234567890 (see /groups)
  --dry-run              report what would be imported, write nothing
  --force                import even if the export's own chat id does not match --chat-id`;

interface Args {
  file: string;
  chatId: number;
  dryRun: boolean;
  force: boolean;
}

/** Returns the parsed arguments, or a sentence saying what is wrong with them. */
function parseArgs(argv: string[]): Args | string {
  let file: string | undefined;
  let chatId: string | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg === '--chat-id') chatId = argv[++i] ?? '';
    else if (arg.startsWith('--chat-id=')) chatId = arg.slice('--chat-id='.length);
    else if (arg.startsWith('--')) return `Unknown option ${arg}.`;
    else if (file === undefined) file = arg;
    else return `Unexpected argument "${arg}".`;
  }

  if (!file) return 'The path to result.json is missing.';
  if (chatId === undefined) return '--chat-id is missing.';
  if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) === 0) {
    return `"${chatId}" is not a chat id. It is a whole number, negative for groups, e.g. -1001234567890.`;
  }
  return { file, chatId: Number(chatId), dryRun, force };
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function summarize(result: ImportResult, chatId: number): string {
  const range = (r?: { from: string; to: string }) => (r ? `${r.from} to ${r.to}` : 'nothing');
  const row = (label: string, value: string) => `  ${`${label}:`.padEnd(18)}${value}`;

  const lines = [
    `Export of "${result.chatName ?? 'unnamed chat'}" into group ${chatId}` +
      (result.dryRun ? ' (dry run: nothing was written, this is what an import would do)' : ''),
    row('In the export', `${count(result.total)} entries, ${range(result.dateRange)}`),
    row('Imported', `${count(result.imported)} lines${result.importedRange ? `, ${range(result.importedRange)}` : ''}`),
    row('Already recorded', `${count(result.skippedExisting)} skipped`),
    row('Unsupported', `${count(result.skippedUnsupported)} skipped`),
    ...Object.entries(result.unsupportedKinds).map(([kind, n]) => `${' '.repeat(20)}${count(n)} × ${kind}`),
    row('Days written', `${count(result.daysWritten)} (${count(result.daysCreated)} new, ${count(result.daysMerged)} merged into an existing day)`),
    row(
      'Topics',
      result.isForum ? result.topics.map((topic) => `${topic.name} (${count(topic.messages)})`).join(', ') : 'none, not a forum',
    ),
    row('Members', `${count(result.membersAdded)} added`),
    ...result.warnings.map((warning) => `  Note: ${warning}`),
  ];
  if (!result.dryRun && result.imported > 0) {
    lines.push('  Restart the bot if it was running, so it reloads the topic and member lists.');
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(`${args}\n\n${USAGE}`);
    return 2;
  }

  let exportData: unknown;
  try {
    exportData = JSON.parse(fs.readFileSync(args.file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'it is not valid JSON' : (error as Error).message;
    console.error(`Could not read ${args.file}: ${reason}`);
    return 1;
  }

  // Loaded only now: the configuration behind it needs the bot's environment and exits without it.
  const { importTelegramExport, ImportError } = await import('./secretary/import.js');
  try {
    const result = importTelegramExport(exportData, { chatId: args.chatId, dryRun: args.dryRun, allowChatMismatch: args.force });
    console.log(summarize(result, args.chatId));
    return 0;
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    console.error(`Import failed: ${error.message}`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error('Import failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
