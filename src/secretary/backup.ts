/**
 * Backups of the record. Telegram never re-sends old messages to a bot, so
 * the transcripts cannot be rebuilt if the server is lost. Once a week (and
 * on /backup) the bot packs every group's record into one archive and sends
 * it to each owner's private chat, which keeps a copy off the server.
 *
 * The archive holds the groups' records, notes, schedules and hook lists.
 * Files inside the sandbox workspaces are not included.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InputFile, type Api } from 'grammy';
import { config } from '../config.js';
import { getLastBackupAt, getOwnerIds, setLastBackupAt } from './state.js';
import { flushMembers, localTime } from './transcript.js';

const WEEK_MS = 7 * 86_400_000;
const MAX_ARCHIVE_BYTES = 45_000_000;

function createArchive(): Promise<string> {
  return new Promise((resolve, reject) => {
    flushMembers();
    const out = path.join(os.tmpdir(), `secretary-backup-${localTime(new Date()).day}.tar.gz`);
    const entries = ['groups', 'state.json'].filter((name) => fs.existsSync(path.join(config.DATA_DIR, name)));
    if (!entries.length) {
      reject(new Error('there is nothing to back up yet'));
      return;
    }
    execFile('tar', ['-czf', out, '-C', config.DATA_DIR, ...entries], { timeout: 120_000 }, (error) => {
      if (error) reject(new Error(`could not create the archive: ${error.message}`));
      else resolve(out);
    });
  });
}

/** Create a backup and send it to every owner. Returns the archive size in bytes. */
export async function sendBackup(api: Api, reason: string): Promise<number> {
  const owners = getOwnerIds();
  if (!owners.length) throw new Error('the bot has no owner to send a backup to');

  const archive = await createArchive();
  try {
    const size = fs.statSync(archive).size;
    if (size > MAX_ARCHIVE_BYTES) {
      throw new Error(`the archive is ${(size / 1e6).toFixed(0)} MB, larger than Telegram lets a bot send. Copy the data folder off the server instead.`);
    }
    for (const owner of owners) {
      await api.sendDocument(owner, new InputFile(archive), {
        caption: `🗄 Secretary backup (${reason}). Records, notes, reminders and hook lists of all groups. Keep this file somewhere safe.`,
      });
    }
    setLastBackupAt(new Date());
    return size;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Check hourly whether a week has passed since the last backup. */
export function startBackups(api: Api): void {
  if (timer || !config.SECRETARY_BACKUPS) return;
  const check = () => {
    const last = getLastBackupAt();
    if (!getOwnerIds().length) return;
    // The first backup waits a day after setup rather than firing on first start.
    if (!last) {
      setLastBackupAt(new Date(Date.now() - WEEK_MS + 86_400_000));
      return;
    }
    if (Date.now() - last.getTime() < WEEK_MS) return;
    sendBackup(api, 'weekly')
      .then((size) => console.log(`[Backup] Sent weekly backup (${(size / 1024).toFixed(0)} KB)`))
      .catch((error) => console.error('[Backup] Weekly backup failed:', (error as Error).message));
  };
  timer = setInterval(check, 3_600_000);
  timer.unref();
  check();
}

export function stopBackups(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
