/**
 * Secretary middleware: records every message in enabled groups and answers
 * the ones addressed to the bot. It handles all group traffic itself, so the
 * private-chat coding handlers further down the chain never see group updates.
 */

import { GrammyError, InputFile, type Api, type Context, type NextFunction } from 'grammy';
import type { BotFullInfo, Message } from 'grammy/types';
import { config } from '../config.js';
import { processMessageForTelegram, splitMessage } from '../telegram/markdown.js';
import type { ImageAttachment } from '../providers/types.js';
import { askSecretary } from './agent.js';
import { describeContent, formatMessageBody, senderLabel, senderOf, topicNameFromReply } from './format.js';
import { clearSandbox, sandboxEnabled, uploadToSandbox } from './sandbox.js';
import { describeSchedule, forgetSchedules, listSchedules, type Schedule } from './schedule.js';
import {
  claimOwnership,
  disableGroup,
  enableGroup,
  getGroup,
  isGroupEnabled,
  isOwner,
  listGroups,
  migrateGroupState,
  removeGroup,
  sandboxUidFor,
  setWelcome,
  touchGroup,
  type GroupState,
} from './state.js';
import {
  GENERAL_TOPIC,
  appendTranscript,
  deleteGroupData,
  getTopicName,
  listTopicNames,
  localTime,
  migrateGroupData,
  noteMember,
  setTopicName,
  transcriptStats,
} from './transcript.js';
import { detectTrigger } from './trigger.js';

/** Messages older than this are still recorded (Telegram replays them after downtime) but not answered. */
const ANSWER_MAX_AGE_SECONDS = 300;
const MAX_IMAGE_BYTES = 4_500_000;
/** Telegram does not let bots download files larger than this. */
const MAX_DOWNLOAD_BYTES = 20_000_000;
const CHUNK_LENGTH = 4000;
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export const GROUP_COMMANDS = [
  { command: 'ask', description: 'Ask the secretary about anything said in this group' },
  { command: 'summary', description: 'Recap the discussion (e.g. /summary this week)' },
  { command: 'catchup', description: 'What happened since you last wrote here' },
  { command: 'reminders', description: 'List reminders and recurring tasks' },
  { command: 'stop', description: 'Stop the answer the secretary is working on' },
  { command: 'status', description: 'Show what the secretary is recording' },
  { command: 'help', description: 'How to use the secretary' },
];

// ── Small helpers ────────────────────────────────────────────────────

/** Where a message from the bot should go. */
interface Target {
  chatId: number;
  threadId?: number;
  replyTo?: number;
}

/** Runs at most `limit` answers at once; the rest wait their turn. */
class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const answerSlots = new Semaphore(Math.max(1, config.SECRETARY_MAX_CONCURRENT));

/** Answers in progress, so /stop can cancel them. */
interface RunningAnswer {
  userId: number;
  controller: AbortController;
}
const running = new Map<number, Set<RunningAnswer>>();

function botLabel(me: BotFullInfo): string {
  return `${config.BOT_NAME} (@${me.username})`;
}

function threadIdOf(msg: Message): number | undefined {
  return msg.is_topic_message ? msg.message_thread_id : undefined;
}

function targetOf(msg: Message): Target {
  return { chatId: msg.chat.id, threadId: threadIdOf(msg), replyTo: msg.message_id };
}

function isForum(msg: Message): boolean {
  return msg.chat.type === 'supergroup' && msg.chat.is_forum === true;
}

/** Topic label for a message, learning topic names from the service messages Telegram attaches. */
function topicOf(msg: Message): string | undefined {
  if (!isForum(msg)) return undefined;

  const threadId = threadIdOf(msg);
  if (threadId === undefined) return GENERAL_TOPIC;

  const chatId = msg.chat.id;
  if (msg.forum_topic_created) {
    setTopicName(chatId, threadId, msg.forum_topic_created.name);
  } else if (msg.forum_topic_edited?.name) {
    setTopicName(chatId, threadId, msg.forum_topic_edited.name);
  } else if (!getTopicName(chatId, threadId)) {
    const original = topicNameFromReply(msg);
    if (original) setTopicName(chatId, threadId, original);
  }

  return getTopicName(chatId, threadId) ?? `topic ${threadId}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sendOptions(target: Target, withReply: boolean) {
  return {
    message_thread_id: target.threadId,
    link_preview_options: { is_disabled: true },
    ...(withReply && target.replyTo
      ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } }
      : {}),
  };
}

/** `clearKeyboard` also removes a custom keyboard left in the chat by a previous bot setup. */
async function sendPlain(api: Api, target: Target, text: string, clearKeyboard = false): Promise<Message> {
  return api.sendMessage(target.chatId, text, {
    ...sendOptions(target, true),
    ...(clearKeyboard ? { reply_markup: { remove_keyboard: true as const } } : {}),
  });
}

/** Post text formatted for Telegram, falling back to plain text if the markup is rejected. */
async function sendFormatted(api: Api, target: Target, text: string): Promise<Message | undefined> {
  let first: Message | undefined;
  try {
    for (const part of processMessageForTelegram(text, CHUNK_LENGTH)) {
      const sent = await api.sendMessage(target.chatId, part, { ...sendOptions(target, !first), parse_mode: 'MarkdownV2' });
      first ??= sent;
    }
    return first;
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400 || first) throw error;
  }

  // Telegram rejected the MarkdownV2 markup before anything was sent: resend as plain text.
  for (const chunk of splitMessage(text, CHUNK_LENGTH)) {
    const sent = await api.sendMessage(target.chatId, chunk, sendOptions(target, !first));
    first ??= sent;
  }
  return first;
}

function startTyping(api: Api, target: Target): () => void {
  const send = () => {
    api.sendChatAction(target.chatId, 'typing', { message_thread_id: target.threadId }).catch(() => {});
  };
  send();
  const interval = setInterval(send, 4500);
  return () => clearInterval(interval);
}

/** Download a file the bot was sent. The URL contains the bot token, so it must never be logged. */
async function downloadTelegramFile(api: Api, fileId: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path || (file.file_size ?? 0) > maxBytes) return undefined;
    const response = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return data.length <= maxBytes ? data : undefined;
  } catch (error) {
    console.warn('[Secretary] Could not download a file:', (error as Error).name);
    return undefined;
  }
}

interface Attachments {
  images: ImageAttachment[];
  /** Sentences for the prompt about files that were placed in the workspace (or could not be). */
  notes: string[];
}

/** Collect what the question points at: a photo to look at, or a document to open in the workspace. */
async function gatherAttachments(api: Api, group: GroupState, messages: Array<Message | undefined>): Promise<Attachments> {
  const result: Attachments = { images: [], notes: [] };

  for (const msg of messages) {
    if (!msg) continue;

    if (msg.photo?.length && config.SECRETARY_VISION && !result.images.length) {
      // Largest size that fits the limit; Telegram lists sizes smallest first.
      const photo = [...msg.photo].reverse().find((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES);
      const data = photo && (await downloadTelegramFile(api, photo.file_id, MAX_IMAGE_BYTES));
      if (data) result.images.push({ data: data.toString('base64'), mediaType: 'image/jpeg' });
      continue;
    }

    // Anything else that is a file: documents, videos, audio, voice notes.
    const doc: { file_id: string; file_name?: string; mime_type?: string } | undefined =
      msg.document ??
      (msg.video && { ...msg.video, file_name: msg.video.file_name ?? 'video.mp4' }) ??
      (msg.animation && { ...msg.animation, file_name: msg.animation.file_name ?? 'animation.mp4' }) ??
      (msg.audio && { ...msg.audio, file_name: msg.audio.file_name ?? 'audio.mp3' }) ??
      (msg.voice && { ...msg.voice, file_name: 'voice.ogg' }) ??
      (msg.video_note && { ...msg.video_note, file_name: 'video_note.mp4' });
    if (!doc) continue;
    const name = (doc.file_name ?? 'file').replace(/[^\w.\-]+/g, '_').slice(-100);

    if (doc.mime_type && VISION_TYPES.has(doc.mime_type) && config.SECRETARY_VISION && !result.images.length) {
      const data = await downloadTelegramFile(api, doc.file_id, MAX_IMAGE_BYTES);
      if (data) {
        result.images.push({ data: data.toString('base64'), mediaType: doc.mime_type });
        continue;
      }
    }

    if (!sandboxEnabled()) {
      result.notes.push(`The file "${name}" cannot be opened because the workspace is not available.`);
      continue;
    }
    const data = await downloadTelegramFile(api, doc.file_id, MAX_DOWNLOAD_BYTES);
    if (!data) {
      result.notes.push(`The file "${name}" could not be downloaded (bots can only fetch files up to 20 MB).`);
      continue;
    }
    try {
      const saved = `inbox/${msg.message_id}_${name}`;
      await uploadToSandbox(group.chatId, sandboxUidFor(group.chatId), saved, data);
      result.notes.push(`The file "${name}" from msg ${msg.message_id} is saved in your workspace as ${saved}. Open it with run_command.`);
    } catch (error) {
      result.notes.push(`The file "${name}" could not be saved to the workspace: ${(error as Error).message}`);
    }
  }
  return result;
}

// ── Recording ────────────────────────────────────────────────────────

interface Recorded {
  topic?: string;
  /** When this person last wrote before the current message. */
  previousMessageAt?: Date;
}

function record(msg: Message, edited: boolean): Recorded {
  const topic = topicOf(msg);
  const date = new Date((edited && msg.edit_date ? msg.edit_date : msg.date) * 1000);
  appendTranscript(msg.chat.id, date, formatMessageBody(msg, { edited }), topic);

  let previousMessageAt: Date | undefined;
  if (!edited && msg.from && !msg.from.is_bot && !msg.sender_chat) {
    previousMessageAt = noteMember(msg.chat.id, senderOf(msg), date);
  }
  return { topic, previousMessageAt };
}

function recordBotMessage(me: BotFullInfo, sent: Message, text: string, context: string, topic?: string): void {
  if (!isGroupEnabled(sent.chat.id)) return;
  const body = `${botLabel(me)} [msg ${sent.message_id}, ${context}]: ${text}`;
  appendTranscript(sent.chat.id, new Date(sent.date * 1000), body, topic);
}

/** Lets the secretary post a file from its workspace into the conversation it is answering. */
function fileSender(api: Api, me: BotFullInfo, target: Target, topic: string | undefined) {
  return async (data: Buffer, fileName: string, caption?: string): Promise<void> => {
    const sent = await api.sendDocument(target.chatId, new InputFile(data, fileName), {
      caption,
      message_thread_id: target.threadId,
      ...(target.replyTo
        ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } }
        : {}),
    });
    recordBotMessage(me, sent, `[file: ${fileName}]${caption ? ` ${caption}` : ''}`, 'sent a file', topic);
  };
}

// ── Answering ────────────────────────────────────────────────────────

interface Ask {
  question: string;
  /** Skip the replied-to message (used by commands that are not about one message). */
  ignoreReply?: boolean;
  previousMessageAt?: Date;
}

async function answer(ctx: Context, group: GroupState, msg: Message, topic: string | undefined, ask: Ask): Promise<void> {
  const api = ctx.api;
  const chatId = msg.chat.id;
  const target = targetOf(msg);
  const stopTyping = startTyping(api, target);
  api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: '👀' }]).catch(() => {});

  const entry: RunningAnswer = { userId: msg.from?.id ?? 0, controller: new AbortController() };
  const active = running.get(chatId) ?? new Set<RunningAnswer>();
  running.set(chatId, active);
  active.add(entry);

  try {
    const replied =
      ask.ignoreReply || msg.reply_to_message?.forum_topic_created ? undefined : (msg.reply_to_message as Message | undefined);
    const attachments = await gatherAttachments(api, group, [msg, replied]);

    const context: string[] = [];
    // A partial quote: the person highlighted one part of the message they replied to.
    if (replied && msg.quote?.text) {
      context.push(`They quoted this part of it: "${msg.quote.text.replace(/\s+/g, ' ').trim().slice(0, 1000)}".`);
    }
    if (ask.previousMessageAt) {
      context.push(`Their previous message in this group was at ${localTime(ask.previousMessageAt).stamp}.`);
    }
    context.push(...attachments.notes);
    const question = context.length ? `${ask.question}\n\n(${context.join(' ')})` : ask.question;

    const result = await answerSlots.run(() =>
      askSecretary(
        {
          group,
          botName: config.BOT_NAME,
          asker: senderLabel(senderOf(msg)),
          question,
          topic,
          threadId: target.threadId,
          repliedTo: replied ? `[${localTime(new Date(replied.date * 1000)).stamp}] ${formatMessageBody(replied)}` : undefined,
          images: attachments.images.length ? attachments.images : undefined,
          sendFile: fileSender(api, ctx.me, target, topic),
        },
        entry.controller,
      ),
    );

    stopTyping();
    const sent = await sendFormatted(api, target, result.text);
    if (sent) {
      recordBotMessage(ctx.me, sent, result.text, `reply to msg ${msg.message_id} by ${senderOf(msg).name}`, topic);
    }

    const cost = result.costUsd !== undefined ? ` $${result.costUsd.toFixed(4)}` : '';
    console.log(
      `[Secretary] Answered in ${chatId} (${(result.durationMs / 1000).toFixed(1)}s, ${result.turns ?? '?'} turns,${cost} tools: ${result.toolsUsed.join(',') || 'none'})`,
    );
  } catch (error) {
    stopTyping();
    const reason = error instanceof Error ? error.message : 'unknown error';
    if (entry.controller.signal.aborted && !/too long/.test(reason)) {
      console.log(`[Secretary] Answer in ${chatId} was stopped`);
    } else {
      console.error(`[Secretary] Failed to answer in ${chatId}:`, reason);
    }
    const friendly = entry.controller.signal.aborted
      ? 'Stopped.'
      : 'Sorry, I could not answer that just now. Please try again in a moment.';
    await sendPlain(api, target, friendly).catch(() => {});
  } finally {
    active.delete(entry);
    api.setMessageReaction(chatId, msg.message_id, []).catch(() => {});
  }
}

/** Start an answer without holding up the update queue: recording must keep flowing while Claude thinks. */
function answerInBackground(ctx: Context, group: GroupState, msg: Message, topic: string | undefined, ask: Ask): void {
  void answer(ctx, group, msg, topic, ask).catch((error) => {
    console.error('[Secretary] Unexpected error:', error);
  });
}

// ── Scheduled reminders and tasks ────────────────────────────────────

/** Builds the function the scheduler calls for each reminder or task that comes due. */
export function createScheduleDeliverer(api: Api, me: BotFullInfo) {
  return async (chatId: number, schedule: Schedule): Promise<void> => {
    const group = getGroup(chatId);
    if (!group?.enabled) return;

    let target: Target = { chatId, threadId: schedule.threadId };
    const post = async (text: string): Promise<Message | undefined> => {
      try {
        return await sendFormatted(api, target, text);
      } catch (error) {
        // The topic it was created in may be gone; fall back to the main chat.
        if (target.threadId && error instanceof GrammyError && error.error_code === 400) {
          target = { chatId };
          return sendFormatted(api, target, text);
        }
        throw error;
      }
    };

    if (schedule.kind === 'message') {
      // The bot adds the alarm clock; drop one the reminder text may already start with.
      const text = `⏰ ${schedule.text.replace(/^⏰\s*/u, '')}`;
      const sent = await post(text);
      if (sent) recordBotMessage(me, sent, text, `reminder ${schedule.id} set by ${schedule.createdBy}`, schedule.topic);
      console.log(`[Schedule] Delivered reminder ${schedule.id} in ${chatId}`);
      return;
    }

    const stopTyping = startTyping(api, target);
    try {
      const result = await answerSlots.run(() =>
        askSecretary({
          group,
          botName: config.BOT_NAME,
          asker: schedule.createdBy,
          question: schedule.text,
          topic: schedule.topic,
          threadId: schedule.threadId,
          scheduled: true,
          sendFile: fileSender(api, me, target, schedule.topic),
        }),
      );
      stopTyping();
      const sent = await post(result.text);
      if (sent) recordBotMessage(me, sent, result.text, `scheduled task ${schedule.id} set by ${schedule.createdBy}`, schedule.topic);
      console.log(`[Schedule] Ran task ${schedule.id} in ${chatId} (${(result.durationMs / 1000).toFixed(1)}s)`);
    } catch (error) {
      stopTyping();
      console.error(`[Schedule] Task ${schedule.id} in ${chatId} failed:`, (error as Error).message);
      await post(`⚠️ The scheduled task "${schedule.text.slice(0, 80)}" (${schedule.id}) could not be completed this time.`).catch(() => {});
    }
  };
}

// ── Group commands ───────────────────────────────────────────────────

function helpText(me: BotFullInfo): string {
  const lines = [
    `I'm ${config.BOT_NAME}, this group's secretary. I keep a written record of what is said here (in every topic) and answer questions about it.`,
    '',
    `• Mention @${me.username} with a question, or reply to one of my messages`,
    '• /ask <question> — about anything said in the group, or anything else',
    '• /summary [period or focus] — recap, e.g. /summary this week',
    '• /catchup — what happened since you last wrote here',
    '• /reminders — list reminders and recurring tasks',
    '• /stop — stop the answer I am working on',
    '• /status — what I am recording',
    '',
    'Things you can ask me to do:',
    '• "Remember that the AGM moved to 20 Dec" — I keep notes',
    '• "Remind us on Friday at 6pm to bring the banner", "Post a recap every Monday at 9am"',
  ];
  if (sandboxEnabled()) {
    lines.push('• "Make a spreadsheet of who is coming", "Chart who talks the most" — I can run scripts and send files');
    lines.push('• Reply to a PDF, Word or Excel file and mention me to have it read');
  }
  lines.push('', 'Admins: /welcome <text> sets a greeting for new members. Owner: /enable, /disable, /forget.');
  return lines.join('\n');
}

async function isAdminOrOwner(ctx: Context, msg: Message): Promise<boolean> {
  if (isOwner(msg.from?.id)) return true;
  // An anonymous admin posts as the group itself.
  if (msg.sender_chat?.id === msg.chat.id) return true;
  if (!msg.from) return false;
  try {
    const member = await ctx.api.getChatMember(msg.chat.id, msg.from.id);
    return member.status === 'administrator' || member.status === 'creator';
  } catch {
    return false;
  }
}

async function privacyWarning(ctx: Context, chatId: number): Promise<string> {
  if (ctx.me.can_read_all_group_messages) return '';
  try {
    const me = await ctx.api.getChatMember(chatId, ctx.me.id);
    if (me.status === 'administrator' || me.status === 'creator') return '';
  } catch {
    // fall through to the warning
  }
  return (
    '\n\n⚠️ Right now Telegram only shows me commands, mentions and replies to me, so my record would have gaps. ' +
    'To let me see everything, either make me an admin of this group, or turn off privacy mode in @BotFather ' +
    '(/setprivacy → Disable) and then remove and re-add me.'
  );
}

async function handleEnable(ctx: Context, msg: Message): Promise<void> {
  const target = targetOf(msg);
  if (!isOwner(msg.from?.id)) {
    await sendPlain(ctx.api, target, "Only the bot's owner can turn the secretary on.");
    return;
  }
  const chat = msg.chat;
  const group = enableGroup(chat.id, {
    title: 'title' in chat && chat.title ? chat.title : `Group ${chat.id}`,
    enabledBy: msg.from!.id,
    username: 'username' in chat ? chat.username : undefined,
    isForum: isForum(msg),
  });
  appendTranscript(chat.id, new Date(msg.date * 1000), `* ${senderOf(msg).name} turned on the secretary`, topicOf(msg));

  await sendPlain(
    ctx.api,
    target,
    `📒 Secretary mode is on for "${group.title}".\n\n` +
      'From now on I keep a written record of the messages in this group, across all topics, so I can answer questions about what was said. ' +
      `Mention @${ctx.me.username}, reply to me, or use /ask. /help shows everything I can do.\n\n` +
      'The owner can stop recording with /disable and erase the record with /forget.' +
      (await privacyWarning(ctx, chat.id)),
    true,
  );
}

async function handleGroupCommand(
  ctx: Context,
  msg: Message,
  recorded: Recorded,
  command: string,
  args: string,
): Promise<void> {
  const api = ctx.api;
  const chatId = msg.chat.id;
  const target = targetOf(msg);
  const group = getGroup(chatId);
  if (Date.now() / 1000 - msg.date > ANSWER_MAX_AGE_SECONDS) return;

  if (command === 'enable') {
    await handleEnable(ctx, msg);
    return;
  }

  // Until an owner enables the group, the bot stays silent.
  if (!group?.enabled) return;

  switch (command) {
    case 'disable':
      if (!isOwner(msg.from?.id)) {
        await sendPlain(api, target, "Only the bot's owner can turn the secretary off.");
        return;
      }
      disableGroup(chatId);
      await sendPlain(api, target, '📕 Secretary mode is off. I have stopped recording and reminders are paused; the existing record is kept. /enable turns me back on, /forget erases the record.');
      return;

    case 'forget':
      if (!isOwner(msg.from?.id)) {
        await sendPlain(api, target, "Only the bot's owner can erase the record.");
        return;
      }
      if (args.toLowerCase() !== 'confirm') {
        await sendPlain(api, target, 'This permanently deletes everything I have for this group: the record, notes, reminders and workspace files. Send "/forget confirm" to go ahead.');
        return;
      }
      if (sandboxEnabled() && group.sandboxUid !== undefined) {
        await clearSandbox(chatId, group.sandboxUid).catch((error) => {
          console.error(`[Secretary] Could not clear the workspace of ${chatId}:`, (error as Error).message);
        });
      }
      deleteGroupData(chatId);
      forgetSchedules(chatId);
      removeGroup(chatId);
      await sendPlain(api, target, '🗑 Everything I had for this group has been erased and recording is off.');
      return;

    case 'welcome': {
      if (!(await isAdminOrOwner(ctx, msg))) {
        await sendPlain(api, target, 'Only group admins can set the welcome message.');
        return;
      }
      if (!args) {
        await sendPlain(
          api,
          target,
          group.welcome
            ? `Current welcome message:\n\n${group.welcome}\n\nChange it with /welcome <text>, or turn it off with /welcome off.`
            : 'No welcome message is set. Use /welcome <text>; {name} is replaced with the new member\'s name and {group} with the group name.',
        );
        return;
      }
      if (args.toLowerCase() === 'off') {
        setWelcome(chatId, undefined);
        await sendPlain(api, target, 'Welcome message turned off.');
        return;
      }
      setWelcome(chatId, args.slice(0, 1500));
      await sendPlain(api, target, 'Welcome message saved. New members will be greeted with it.');
      return;
    }

    case 'status': {
      const stats = transcriptStats(chatId);
      const topics = group.isForum ? ` · ${listTopicNames(chatId).length + 1} topics known` : '';
      const schedules = listSchedules(chatId).length;
      await sendPlain(
        api,
        target,
        `📒 Recording "${group.title}" since ${stats.firstDay ?? 'today'} · ${stats.days} day(s) on file (${formatBytes(stats.bytes)})${topics}` +
          ` · ${schedules} reminder(s)/task(s) · workspace ${sandboxEnabled() ? 'on' : 'off'}` +
          (await privacyWarning(ctx, chatId)),
      );
      return;
    }

    case 'reminders': {
      const schedules = listSchedules(chatId);
      await sendPlain(
        api,
        target,
        schedules.length
          ? `Reminders and tasks:\n\n${schedules.map((s) => `• ${describeSchedule(s)}`).join('\n')}\n\nAsk me to cancel one by its id.`
          : 'Nothing is scheduled. Ask me, e.g. "remind us on Friday at 6pm to bring the banner".',
      );
      return;
    }

    case 'stop': {
      const active = [...(running.get(chatId) ?? [])];
      const all = await isAdminOrOwner(ctx, msg);
      const mine = active.filter((entry) => all || entry.userId === msg.from?.id);
      if (!mine.length) {
        await sendPlain(api, target, active.length ? 'You can only stop your own question.' : 'Nothing is running.');
        return;
      }
      for (const entry of mine) entry.controller.abort();
      return;
    }

    case 'help':
    case 'start':
      await sendPlain(api, target, helpText(ctx.me));
      return;

    case 'ask':
      if (!args) {
        await sendPlain(api, target, 'Ask me something, e.g. "/ask what did we decide about the venue?"');
        return;
      }
      answerInBackground(ctx, group, msg, recorded.topic, { question: args, previousMessageAt: recorded.previousMessageAt });
      return;

    case 'summary':
      answerInBackground(ctx, group, msg, recorded.topic, {
        ignoreReply: true,
        question:
          `Give a recap of the group's discussion${args ? ` for: "${args}"` : ' today'}. ` +
          'Cover each topic that had real discussion: the main points, decisions made, questions still open, and action items with who owns them. ' +
          'Leave out small talk. If little happened in that period, say so briefly.',
      });
      return;

    case 'catchup':
      answerInBackground(ctx, group, msg, recorded.topic, {
        ignoreReply: true,
        previousMessageAt: recorded.previousMessageAt,
        question:
          'Catch me up on what I missed since my previous message in this group' +
          (recorded.previousMessageAt ? '' : ' (I have not written here before, so cover the last few days)') +
          '. Group it by topic, put anything that needs my attention or a reply from me first, and leave out small talk.',
      });
      return;

    default:
      return; // someone else's command
  }
}

// ── Private-chat commands owned by the secretary ─────────────────────

async function handleClaim(ctx: Context, code: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  switch (claimOwnership(userId, code)) {
    case 'claimed':
      console.log(`[Secretary] Ownership claimed by user ${userId}`);
      await ctx.reply(
        '✅ You are now the owner of this bot.\n\n' +
          'To set up a group: add me to it, then send /enable there. ' +
          'For a complete record, make me an admin of the group (or disable privacy mode in @BotFather and re-add me).\n\n' +
          'Here in private chat you also have the full Claudegram assistant: see /start. /groups lists the groups I am recording.',
        { reply_markup: { remove_keyboard: true } },
      );
      return;
    case 'already-owned':
      await ctx.reply('This bot already has an owner.');
      return;
    case 'locked':
      await ctx.reply('Too many wrong attempts.');
      return;
    case 'wrong-code':
      await ctx.reply('That code is not right.');
      return;
  }
}

async function handleGroups(ctx: Context): Promise<void> {
  const groups = listGroups();
  if (!groups.length) {
    await ctx.reply('No groups yet. Add me to a group and send /enable there.');
    return;
  }
  const lines = groups.map((g) => {
    const stats = transcriptStats(g.chatId);
    const state = g.enabled ? 'recording' : 'paused';
    return `• ${g.title} (${g.chatId}): ${state}, ${stats.days} day(s), ${formatBytes(stats.bytes)}, ${listSchedules(g.chatId).length} schedule(s)`;
  });
  await ctx.reply(`Groups:\n${lines.join('\n')}`);
}

// ── Middleware ───────────────────────────────────────────────────────

/**
 * A previous setup of this bot may have given individual private chats their own
 * menu button (the button left of the attachment icon). Put each chat back on the
 * normal commands menu the first time we hear from it.
 */
const menuButtonReset = new Set<number>();

function resetMenuButton(ctx: Context, chatId: number): void {
  if (menuButtonReset.has(chatId)) return;
  if (menuButtonReset.size > 10_000) menuButtonReset.clear();
  menuButtonReset.add(chatId);
  ctx.api.setChatMenuButton({ chat_id: chatId, menu_button: { type: 'default' } }).catch((error) => {
    console.warn('[Secretary] Could not reset the menu button:', (error as Error).message);
  });
}

async function handleMembershipChange(ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update || (update.chat.type !== 'group' && update.chat.type !== 'supergroup')) return;

  const before = update.old_chat_member.status;
  const after = update.new_chat_member.status;
  console.log(`[Secretary] Bot status in ${update.chat.id} ("${update.chat.title}"): ${before} -> ${after}`);

  const joined = (before === 'left' || before === 'kicked') && (after === 'member' || after === 'administrator');
  if (joined && !isGroupEnabled(update.chat.id)) {
    const hint = isOwner(update.from.id)
      ? "Hi! I'm ready. Send /enable here to start the secretary for this group."
      : "Hi! I'm a private secretary bot. My owner needs to send /enable here before I do anything.";
    await ctx.api.sendMessage(update.chat.id, hint).catch(() => {});
  }
}

async function greetNewMembers(ctx: Context, group: GroupState, msg: Message): Promise<void> {
  const newcomers = (msg.new_chat_members ?? []).filter((member) => !member.is_bot);
  if (!group.welcome || !newcomers.length) return;
  const names = newcomers.map((m) => [m.first_name, m.last_name].filter(Boolean).join(' ')).join(', ');
  const text = group.welcome.replaceAll('{name}', names).replaceAll('{group}', group.title);
  try {
    const sent = await ctx.api.sendMessage(msg.chat.id, text, { link_preview_options: { is_disabled: true } });
    recordBotMessage(ctx.me, sent, text, 'welcome message', isForum(msg) ? GENERAL_TOPIC : undefined);
  } catch (error) {
    console.warn('[Secretary] Could not send the welcome message:', (error as Error).message);
  }
}

export async function secretaryMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.myChatMember) {
    await handleMembershipChange(ctx);
    return;
  }

  const chat = ctx.chat;
  if (!chat) return next();

  if (chat.type === 'private') {
    resetMenuButton(ctx, chat.id);
    const text = ctx.message?.text ?? '';
    const claim = text.match(/^\/claim(?:@\w+)?(?:\s+(\S+))?/);
    if (claim) {
      await handleClaim(ctx, claim[1] ?? '');
      return;
    }
    if (/^\/groups(?:@\w+)?\s*$/.test(text) && isOwner(ctx.from?.id)) {
      await handleGroups(ctx);
      return;
    }
    return next();
  }

  // Channels are ignored; groups never reach the private-chat handlers.
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const edited = ctx.editedMessage !== undefined;
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return;

  // Upgrading a basic group to a supergroup (for example by enabling topics) changes its id.
  if (msg.migrate_to_chat_id) {
    migrateGroupData(chat.id, msg.migrate_to_chat_id);
    migrateGroupState(chat.id, msg.migrate_to_chat_id);
    forgetSchedules(chat.id);
    return;
  }
  if (msg.migrate_from_chat_id) return;

  let recorded: Recorded = {};
  const enabledGroup = isGroupEnabled(chat.id) ? getGroup(chat.id) : undefined;
  if (enabledGroup) {
    touchGroup(chat.id, {
      title: chat.title,
      username: 'username' in chat ? chat.username : undefined,
      isForum: isForum(msg),
    });
    try {
      recorded = record(msg, edited);
    } catch (error) {
      console.error(`[Secretary] Failed to record message ${msg.message_id} in ${chat.id}:`, (error as Error).message);
    }
  }

  if (edited) return;
  const fresh = Date.now() / 1000 - msg.date <= ANSWER_MAX_AGE_SECONDS;

  if (enabledGroup && fresh && msg.new_chat_members?.length) {
    await greetNewMembers(ctx, enabledGroup, msg);
    return;
  }
  if (msg.from?.is_bot && !msg.sender_chat) return;

  const trigger = detectTrigger(msg, { id: ctx.me.id, username: ctx.me.username ?? '' });
  if (!trigger) return;

  if (trigger.kind === 'command') {
    await handleGroupCommand(ctx, msg, recorded, trigger.command, trigger.args);
    return;
  }

  const group = getGroup(chat.id);
  if (!group?.enabled || !fresh) return;

  let question = trigger.question;
  if (!question) {
    const replied = msg.reply_to_message && !msg.reply_to_message.forum_topic_created ? msg.reply_to_message : undefined;
    if (trigger.via === 'mention' && replied) {
      question =
        'They mentioned you on the message they replied to, without adding a question. ' +
        'Respond to that message in whatever way is most useful: answer it, explain it or summarise it.';
    } else if (msg.photo || msg.document || msg.voice || msg.video || msg.audio || msg.animation || msg.video_note) {
      question = `They sent you this without a question: ${describeContent(msg)}`;
    } else {
      await sendPlain(ctx.api, targetOf(msg), 'Yes? Ask me anything about what has been said here, e.g. "what did we agree on yesterday?"');
      return;
    }
  }

  answerInBackground(ctx, group, msg, recorded.topic, { question, previousMessageAt: recorded.previousMessageAt });
}
