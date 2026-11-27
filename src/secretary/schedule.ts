/**
 * Reminders and recurring tasks for a group.
 *
 * A schedule is either a fixed message ("⏰ AGM in one hour") or a task for
 * the secretary to carry out when it fires ("post a recap of last week").
 * It runs once at a given local time, or repeatedly on a cron pattern.
 * Schedules live in the group's folder (schedules.json) and are fired by a
 * single timer inside the bot, so nothing depends on a system cron.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Cron } from 'croner';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getGroup, listGroups, type EffortLevel } from './state.js';
import { groupDir, localTime } from './transcript.js';

export interface Schedule {
  id: string;
  /**
   * message: post the text as is. task: run the secretary with the text as its
   * instruction. script: run that script from the workspace and post what it prints.
   */
  kind: 'message' | 'task' | 'script';
  text: string;
  /** For tasks: how hard the secretary should think on this run. Default is the group's setting. */
  effort?: EffortLevel;
  /** Five-field cron pattern for a recurring schedule, in the group's timezone. */
  cron?: string;
  /** Local date-time for a one-off schedule, e.g. "2026-12-01T09:00". */
  at?: string;
  /** Repeat every this many seconds (finer than cron allows). */
  everySeconds?: number;
  /** Stop repeating after this moment (ISO 8601 UTC). */
  until?: string;
  /** Next firing time, ISO 8601 UTC. */
  nextRun: string;
  /** Forum topic the schedule was created in; its messages are posted there. */
  threadId?: number;
  topic?: string;
  createdBy: string;
  /** Telegram user id of the creator: a task runs with that person's rights. */
  createdById?: number;
  createdAt: string;
  lastRun?: string;
}

export interface ScheduleInput {
  kind: 'message' | 'task' | 'script';
  text: string;
  effort?: EffortLevel;
  at?: string;
  cron?: string;
  everySeconds?: number;
  /** Local date-time after which a repeating schedule stops, e.g. "2026-12-01T19:30". */
  until?: string;
  threadId?: number;
  topic?: string;
  createdBy: string;
  createdById?: number;
}

/** Shortest gaps allowed between repeats in this group (the owner or a manager can change them). */
export function repeatLimits(chatId: number): { seconds: number; taskMinutes: number } {
  const group = getGroup(chatId);
  return {
    seconds: group?.minRepeatSeconds ?? DEFAULT_MIN_REPEAT_SECONDS,
    taskMinutes: group?.minTaskRepeatMinutes ?? config.SECRETARY_MIN_REPEAT_MINUTES,
  };
}

export const DEFAULT_MIN_REPEAT_SECONDS = 10;
/** Nothing can repeat faster than this, whatever the settings say. */
const FLOOR_SECONDS = 5;

function parseLocal(value: string, label: string): Date {
  const at = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(at)) throw new Error(`"${label}" must look like 2026-12-01T09:00 (local time).`);
  let next: Date | undefined;
  try {
    // From long ago, so a date in the past still parses (and is then refused as past).
    next = nextOccurrence({ at }, new Date(0));
  } catch {
    throw new Error(`"${at}" is not a valid date and time.`);
  }
  if (!next) throw new Error(`"${at}" is not a valid date and time.`);
  return next;
}

const TICK_MS = 5_000;
const cache = new Map<number, Schedule[]>();

function filePath(chatId: number): string {
  return path.join(groupDir(chatId), 'schedules.json');
}

function load(chatId: number): Schedule[] {
  let schedules = cache.get(chatId);
  if (!schedules) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath(chatId), 'utf8'));
      schedules = Array.isArray(raw) ? (raw as Schedule[]) : [];
    } catch {
      schedules = [];
    }
    cache.set(chatId, schedules);
  }
  return schedules;
}

function save(chatId: number): void {
  fs.mkdirSync(groupDir(chatId), { recursive: true });
  atomicWriteFileSync(filePath(chatId), JSON.stringify(load(chatId), null, 2));
}

/** Next occurrence strictly after `from`, or undefined when there is none (a one-off in the past). */
function nextOccurrence(schedule: Pick<Schedule, 'cron' | 'at'>, from: Date): Date | undefined {
  const pattern = schedule.cron ?? schedule.at;
  if (!pattern) return undefined;
  return new Cron(pattern, { timezone: config.SECRETARY_TIMEZONE }).nextRun(from) ?? undefined;
}

/** Validates the request and stores the schedule. Errors are worded for the person who asked. */
export function createSchedule(chatId: number, input: ScheduleInput): Schedule {
  const text = input.text.trim();
  if (!text) throw new Error('The reminder needs some text.');
  if (input.kind === 'script' && (!/^[A-Za-z0-9_][\w./-]{0,199}$/.test(text) || text.split('/').includes('..'))) {
    throw new Error('For a script schedule, the text must be the path of a script in the workspace, e.g. scripts/check_prs.py.');
  }
  if ([input.at, input.cron, input.everySeconds].filter((v) => v !== undefined && v !== '').length !== 1) {
    throw new Error('Give exactly one of "at" (one time), "cron" (repeating at set times) or "every_seconds" (repeating every N seconds).');
  }
  const limits = repeatLimits(chatId);
  // A task runs Claude each time, so it has its own (larger) minimum gap.
  const minMs = input.kind === 'task' ? limits.taskMinutes * 60_000 : Math.max(FLOOR_SECONDS, limits.seconds) * 1000;
  const describeMin = input.kind === 'task' ? `${limits.taskMinutes} minutes` : `${Math.max(FLOOR_SECONDS, limits.seconds)} seconds`;
  const until = input.until ? parseLocal(input.until, 'until') : undefined;
  if (until && until.getTime() <= Date.now()) throw new Error(`"until" (${input.until}) is already in the past.`);

  const schedules = load(chatId);
  if (schedules.length >= config.SECRETARY_MAX_SCHEDULES_PER_GROUP) {
    throw new Error(`This group already has ${schedules.length} schedules, which is the maximum. Cancel some first.`);
  }

  const now = new Date();
  let next: Date | undefined;

  if (input.at) {
    const at = input.at.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(at)) {
      throw new Error('"at" must look like 2026-12-01T09:00 (local time).');
    }
    try {
      next = nextOccurrence({ at }, now);
    } catch {
      throw new Error(`"${at}" is not a valid date and time.`);
    }
    if (!next) throw new Error(`${at} is already in the past (now is ${localTime(now).stamp}).`);
    input = { ...input, at };
  } else if (input.everySeconds !== undefined) {
    const every = Math.round(input.everySeconds);
    if (!(every * 1000 >= minMs)) {
      throw new Error(`In this group a repeating ${input.kind} can fire at most every ${describeMin} (the owner or a manager can change that).`);
    }
    next = new Date(now.getTime() + every * 1000);
    input = { ...input, everySeconds: every };
  } else {
    const cron = input.cron!.trim().replace(/\s+/g, ' ');
    if (cron.split(' ').length !== 5) {
      throw new Error('"cron" must have five fields: minute hour day-of-month month day-of-week.');
    }
    let runs: Date[];
    try {
      runs = new Cron(cron, { timezone: config.SECRETARY_TIMEZONE }).nextRuns(4, now);
    } catch (error) {
      throw new Error(`Not a valid cron pattern: ${(error as Error).message}`);
    }
    if (!runs.length) throw new Error('That pattern never fires.');
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].getTime() - runs[i - 1].getTime() < minMs) {
        throw new Error(`In this group a repeating ${input.kind} can fire at most every ${describeMin} (the owner or a manager can change that).`);
      }
    }
    next = runs[0];
    input = { ...input, cron };
  }

  let id: string;
  do {
    id = randomBytes(3).toString('hex').slice(0, 4);
  } while (schedules.some((s) => s.id === id));

  const schedule: Schedule = {
    id,
    kind: input.kind,
    text,
    effort: input.kind === 'task' ? input.effort : undefined,
    cron: input.cron,
    at: input.at,
    ...(input.everySeconds !== undefined ? { everySeconds: input.everySeconds } : {}),
    ...(until ? { until: until.toISOString() } : {}),
    nextRun: next.toISOString(),
    threadId: input.threadId,
    topic: input.topic,
    createdBy: input.createdBy,
    ...(input.createdById !== undefined ? { createdById: input.createdById } : {}),
    createdAt: now.toISOString(),
  };
  schedules.push(schedule);
  save(chatId);
  return schedule;
}

export function listSchedules(chatId: number): Schedule[] {
  return [...load(chatId)].sort((a, b) => a.nextRun.localeCompare(b.nextRun));
}

export function cancelSchedule(chatId: number, id: string): Schedule | undefined {
  const schedules = load(chatId);
  const index = schedules.findIndex((s) => s.id === id.trim().toLowerCase());
  if (index === -1) return undefined;
  const [removed] = schedules.splice(index, 1);
  save(chatId);
  return removed;
}

export function describeSchedule(schedule: Schedule): string {
  const next = localTime(new Date(schedule.nextRun)).stamp;
  const until = schedule.until ? ` until ${localTime(new Date(schedule.until)).stamp}` : '';
  const when = schedule.everySeconds
    ? `repeats every ${schedule.everySeconds} s${until}, next ${next}`
    : schedule.cron
      ? `repeats on cron "${schedule.cron}"${until}, next ${next}`
      : `once at ${next}`;
  const where = schedule.topic ? ` in #${schedule.topic}` : '';
  const what =
    schedule.kind === 'task'
      ? `task${schedule.effort ? ` (effort ${schedule.effort})` : ''}`
      : schedule.kind === 'script'
        ? 'script'
        : 'reminder';
  return `[${schedule.id}] ${what}${where}, ${when}, set by ${schedule.createdBy}: ${schedule.text}`;
}

export function forgetSchedules(chatId: number): void {
  cache.delete(chatId);
}

/**
 * Collect what is due for one group and move each schedule on (or remove it)
 * before it is delivered, so a crash mid-delivery cannot cause repeats.
 */
export function takeDue(chatId: number, now = new Date()): Schedule[] {
  const schedules = load(chatId);
  const due = schedules.filter((s) => new Date(s.nextRun).getTime() <= now.getTime());
  if (!due.length) return [];

  for (const schedule of due) {
    let next: Date | undefined;
    try {
      if (schedule.everySeconds) {
        // Keep the rhythm, but never try to catch up on missed beats after downtime.
        const step = schedule.everySeconds * 1000;
        let t = new Date(schedule.nextRun).getTime() + step;
        if (t <= now.getTime()) t = now.getTime() + step;
        next = new Date(t);
      } else {
        next = schedule.cron ? nextOccurrence(schedule, now) : undefined;
      }
    } catch {
      next = undefined;
    }
    if (next && schedule.until && next.getTime() > new Date(schedule.until).getTime()) next = undefined;
    if (next) {
      schedule.nextRun = next.toISOString();
      schedule.lastRun = now.toISOString();
    } else {
      schedules.splice(schedules.indexOf(schedule), 1);
    }
  }
  save(chatId);
  return due.map((s) => ({ ...s }));
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the single timer that delivers due schedules for every enabled group. */
export function startScheduler(deliver: (chatId: number, schedule: Schedule) => Promise<void>): void {
  if (timer || !config.SECRETARY_SCHEDULES) return;

  const tick = () => {
    for (const group of listGroups()) {
      if (!group.enabled) continue;
      let due: Schedule[];
      try {
        due = takeDue(group.chatId);
      } catch (error) {
        console.error(`[Schedule] Could not read schedules for ${group.chatId}:`, (error as Error).message);
        continue;
      }
      for (const schedule of due) {
        deliver(group.chatId, schedule).catch((error) => {
          console.error(`[Schedule] Failed to deliver ${schedule.id} in ${group.chatId}:`, (error as Error).message);
        });
      }
    }
  };

  timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
