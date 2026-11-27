/**
 * Secretary middleware: records every message in enabled groups and answers
 * the ones addressed to the bot. It handles all group traffic itself, so the
 * private-chat coding handlers further down the chain never see group updates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GrammyError, InputFile, type Api, type Context, type NextFunction } from 'grammy';
import type { BotFullInfo, Message } from 'grammy/types';
import { config } from '../config.js';
import { processMessageForTelegram, splitMessage } from '../telegram/markdown.js';
import type { ImageAttachment } from '../providers/types.js';
import { askSecretary, describeSettings, messageLinkBase } from './agent.js';
import { describeContent, formatMessageBody, senderLabel, senderOf, topicNameFromReply } from './format.js';
import { sendBackup } from './backup.js';
import {
  describeHook,
  forgetHooks,
  hasActiveHooks,
  listHooks,
  parseActions,
  runHooks,
  runHooksForEvent,
  setHookEnabled,
  type HookAction,
  type HookEventType,
  type HookOutcome,
} from './hooks.js';
import { forgetMcpServers } from './mcp.js';
import { callTelegram, methodLevel, prepareCall, sentMessages } from './telegram-api.js';
import { confirmDeploy, currentVersion, deployEnabled, describePlan, planDeploy, takeDeployResult } from './deploy.js';
import { clearSandbox, readSandboxFile, runInSandbox, sandboxEnabled, sandboxMachineAction, uploadToSandbox } from './sandbox.js';
import { formatUsage, logUsage } from './usage.js';
import { forgetSecrets, listSecrets, migrateSecrets, removeSecret, setSecret } from './secrets.js';
import { describeSchedule, forgetSchedules, listSchedules, type Schedule } from './schedule.js';
import {
  claimOwnership,
  disableGroup,
  enableGroup,
  getGroup,
  getOwnerIds,
  isGroupEnabled,
  isOwner,
  listGroups,
  migrateGroupState,
  removeGroup,
  sandboxUidFor,
  setAnswerTopic,
  setGroupEffort,
  setGroupModel,
  setWelcome,
  EFFORT_LEVELS,
  MODEL_CHOICES,
  canManage,
  resolveModel,
  updateGroupSettings,
  type EffortLevel,
  touchGroup,
  type GroupState,
} from './state.js';
import {
  GENERAL_TOPIC,
  appendNote,
  appendTranscript,
  deleteGroupData,
  findMedia,
  findMember,
  getTopicName,
  listTopicNames,
  localTime,
  migrateGroupData,
  noteMember,
  recordMedia,
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
/** Telegram's limit for a photo upload; larger pictures are sent as files. */
const MAX_PHOTO_UPLOAD_BYTES = 10_000_000;
const PHOTO_FILE = /\.(jpe?g|png|webp)$/i;

export const GROUP_COMMANDS = [
  { command: 'ask', description: 'Ask the secretary about anything said in this group' },
  { command: 'summary', description: 'Recap the discussion (e.g. /summary this week)' },
  { command: 'catchup', description: 'What happened since you last wrote here' },
  { command: 'reminders', description: 'List reminders, recurring tasks and scheduled scripts' },
  { command: 'hooks', description: 'List the scripts that react to messages (on/off <name>)' },
  { command: 'usage', description: 'Who used how much Claude (e.g. /usage 7)' },
  { command: 'stop', description: 'Stop the answer the secretary is working on' },
  { command: 'effort', description: 'Show or set how hard the secretary thinks per answer' },
  { command: 'model', description: 'Show or set which Claude model answers (owner)' },
  { command: 'answerhere', description: 'Post every answer in this topic (owner; /answerhere off)' },
  { command: 'settings', description: "Show this group's settings (who can change them, and how)" },
  { command: 'manager', description: 'Owner: /manager add|remove @username (managers can change settings)' },
  { command: 'deploy', description: 'Owner: deploy a new version of the bot (/deploy [branch], then confirm)' },
  { command: 'version', description: 'Which version of the bot is running' },
  { command: 'machine', description: "Status of this group's own machine; /machine reset rebuilds it" },
  { command: 'secret', description: 'List secrets, or add a key: /secret NAME value (owner/managers; best in DM)' },
  { command: 'status', description: 'Show what the secretary is recording' },
  { command: 'help', description: 'How to use the secretary' },
];

// ── Small helpers ────────────────────────────────────────────────────

/** Where a message from the bot should go. */
interface Target {
  chatId: number;
  threadId?: number;
  replyTo?: number;
  /**
   * The message replied to is in another topic. The reply then names the chat explicitly
   * (Telegram's "reply in another chat") and must fail rather than turn into a plain message.
   */
  replyAcross?: boolean;
}

/** Groups where Telegram would not take a reply across topics; answers there link back instead. */
const crossTopicReplyFails = new Set<number>();

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

/**
 * Where an answer goes: the asker's own topic, or the group's answer topic if the
 * owner set one with /answerhere. Telegram cannot reply across topics, so a moved
 * answer is a plain message that links back to the question instead.
 */
function answerTargetOf(group: GroupState, msg: Message): { target: Target; moved: boolean } {
  const own = targetOf(msg);
  if (!isForum(msg) || group.answerTopic === undefined) return { target: own, moved: false };
  // 0 stands for the General topic, which has no thread id.
  const threadId = group.answerTopic === 0 ? undefined : group.answerTopic;
  if (threadId === own.threadId) return { target: own, moved: false };
  return { target: { chatId: own.chatId, threadId }, moved: true };
}

function topicNameOf(chatId: number, threadId: number | undefined): string {
  return threadId === undefined ? GENERAL_TOPIC : (getTopicName(chatId, threadId) ?? `topic ${threadId}`);
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
      ? {
          reply_parameters: target.replyAcross
            ? { message_id: target.replyTo, chat_id: target.chatId, allow_sending_without_reply: false }
            : { message_id: target.replyTo, allow_sending_without_reply: true },
        }
      : {}),
  };
}

/**
 * Post an answer in another topic as a real reply to the question. Returns undefined when
 * Telegram refuses, so the caller can fall back to a link. Whether this works across topics
 * of one group is checked on the first try and remembered.
 */
async function sendAcrossTopics(api: Api, target: Target, question: Message, text: string): Promise<Message | undefined> {
  if (crossTopicReplyFails.has(target.chatId)) return undefined;
  let sent: Message | undefined;
  try {
    sent = await sendFormatted(api, { ...target, replyTo: question.message_id, replyAcross: true }, text);
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
    console.warn(`[Secretary] Cross-topic reply refused in ${target.chatId} (${error.description}); linking instead`);
    crossTopicReplyFails.add(target.chatId);
    return undefined;
  }
  // Posted, but check it is where it should be and shows as a reply; if not, link from now on.
  const thread = sent?.is_topic_message ? sent.message_thread_id : undefined;
  const replied = sent?.reply_to_message?.message_id === question.message_id || sent?.external_reply !== undefined;
  if (sent && (thread !== target.threadId || !replied)) {
    console.warn(`[Secretary] Cross-topic reply in ${target.chatId} landed in thread ${thread ?? 'General'} (reply: ${replied}); linking from now on`);
    crossTopicReplyFails.add(target.chatId);
  }
  return sent;
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

/** The picture in a message that the secretary could look at: a photo, or an image sent as a file. */
function pictureOf(msg: Message): { fileId: string; mediaType: string } | undefined {
  if (msg.photo?.length) {
    const photo = [...msg.photo].reverse().find((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES);
    return photo ? { fileId: photo.file_id, mediaType: 'image/jpeg' } : undefined;
  }
  const doc = msg.document;
  if (doc?.mime_type && VISION_TYPES.has(doc.mime_type) && (doc.file_size ?? 0) <= MAX_IMAGE_BYTES) {
    return { fileId: doc.file_id, mediaType: doc.mime_type };
  }
  return undefined;
}

/** Any other file in a message (document, video, audio, voice note), so it can be fetched later. */
function fileOf(msg: Message): { fileId: string; mediaType: string; fileName: string; size?: number } | undefined {
  const file: { file_id: string; file_name?: string; mime_type?: string; file_size?: number } | undefined =
    msg.document ??
    (msg.video && { ...msg.video, file_name: msg.video.file_name ?? 'video.mp4' }) ??
    (msg.animation && { ...msg.animation, file_name: msg.animation.file_name ?? 'animation.mp4' }) ??
    (msg.audio && { ...msg.audio, file_name: msg.audio.file_name ?? 'audio.mp3' }) ??
    (msg.voice && { ...msg.voice, file_name: 'voice.ogg' }) ??
    (msg.video_note && { ...msg.video_note, file_name: 'video_note.mp4' });
  if (!file) return undefined;
  return {
    fileId: file.file_id,
    mediaType: file.mime_type ?? 'application/octet-stream',
    fileName: (file.file_name ?? 'file').replace(/[^\w.\-]+/g, '_').slice(-100),
    ...(file.file_size ? { size: file.file_size } : {}),
  };
}

interface Recorded {
  topic?: string;
  /** When this person last wrote before the current message. */
  previousMessageAt?: Date;
}

function record(msg: Message, edited: boolean): Recorded {
  const topic = topicOf(msg);
  const date = new Date((edited && msg.edit_date ? msg.edit_date : msg.date) * 1000);
  appendTranscript(msg.chat.id, date, formatMessageBody(msg, { edited }), topic);
  const media = pictureOf(msg) ?? fileOf(msg);
  if (media) recordMedia(msg.chat.id, { msg: msg.message_id, ...media });

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
    const options = {
      caption,
      message_thread_id: target.threadId,
      ...(target.replyTo
        ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } }
        : {}),
    };
    // Pictures go out as photos, shown inline in the chat; anything else (or a picture
    // Telegram will not take as a photo) as a file.
    if (PHOTO_FILE.test(fileName) && data.length <= MAX_PHOTO_UPLOAD_BYTES) {
      try {
        const sent = await api.sendPhoto(target.chatId, new InputFile(data, fileName), options);
        recordBotMessage(me, sent, `[photo]${caption ? ` ${caption}` : ''}`, 'sent a photo', topic);
        return;
      } catch (error) {
        if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
      }
    }
    const sent = await api.sendDocument(target.chatId, new InputFile(data, fileName), options);
    recordBotMessage(me, sent, `[file: ${fileName}]${caption ? ` ${caption}` : ''}`, 'sent a file', topic);
  };
}

/** Lets the secretary look at a picture posted earlier in the group, by its message number. */
function imageViewer(api: Api, chatId: number) {
  return async (messageId: number): Promise<ImageAttachment | undefined> => {
    const media = findMedia(chatId, messageId);
    if (!media || !VISION_TYPES.has(media.mediaType)) return undefined;
    const data = await downloadTelegramFile(api, media.fileId, MAX_IMAGE_BYTES);
    return data ? { data: data.toString('base64'), mediaType: media.mediaType } : undefined;
  };
}

/** Polls the bot sent, by poll id, so a vote (which names no chat) can be routed to the group's hooks. */
const pollChats = new Map<string, { chatId: number; topic?: string }>();

/**
 * Calls any Telegram Bot API method for one group (rights are checked by the caller), writes what it
 * sent to the record, and remembers polls so their votes reach the hooks.
 */
function telegramCaller(api: Api, me: BotFullInfo, chatId: number, threadId: number | undefined, topic: string | undefined, label: string) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const payload = await prepareCall(method, params, { chatId, threadId }, (file) => readSandboxFile(chatId, sandboxUidFor(chatId), file));
    const result = await callTelegram(api, method, payload);
    for (const sent of sentMessages(result)) {
      const poll = (sent as { poll?: { id: string; question: string } }).poll;
      if (poll) {
        if (pollChats.size > 1000) pollChats.clear();
        pollChats.set(poll.id, { chatId, topic });
      }
      const body = sent.text ?? sent.caption ?? (poll ? `[poll] ${poll.question}` : `[${method.replace(/^send/, '').toLowerCase() || method}]`);
      if (sent.chat?.id === chatId && method !== 'forwardMessage') recordBotMessage(me, sent as unknown as Message, body, `${label} via ${method}`, topic);
    }
    console.log(`[Telegram] ${chatId} ${label}: ${method}`);
    return result;
  };
}

/** Lets the secretary fetch any file or picture posted earlier into its workspace, by message number. */
function fileFetcher(api: Api, group: GroupState) {
  return async (messageId: number): Promise<string> => {
    const media = findMedia(group.chatId, messageId);
    if (!media) throw new Error(`No file or picture is on record for msg ${messageId} (only those posted since this feature was added are).`);
    if ((media.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error('That file is over 20 MB, and Telegram does not let bots download it.');
    const data = await downloadTelegramFile(api, media.fileId, MAX_DOWNLOAD_BYTES);
    if (!data) throw new Error('The file could not be downloaded (bots can only fetch files up to 20 MB).');
    const name = media.fileName ?? (media.mediaType === 'image/jpeg' ? 'photo.jpg' : `image.${media.mediaType.split('/')[1] ?? 'bin'}`);
    const saved = `inbox/${messageId}_${name}`;
    await uploadToSandbox(group.chatId, sandboxUidFor(group.chatId), saved, data);
    return saved;
  };
}

// ── Answering ────────────────────────────────────────────────────────

interface Ask {
  question: string;
  /** Skip the replied-to message (used by commands that are not about one message). */
  ignoreReply?: boolean;
  previousMessageAt?: Date;
  /** Name of the hook that handed this message over, when it was not asked by a person. */
  viaHook?: string;
}

/**
 * A question is written to disk for as long as it is being answered. If the bot
 * is restarted or crashes in the middle, the file is still there on the next
 * start and the question is answered then, instead of being silently dropped.
 */
interface PendingAnswer {
  msg: Message;
  topic?: string;
  ask: { question: string; ignoreReply?: boolean; previousMessageAt?: string; viaHook?: string };
  startedAt: string;
  attempts: number;
}

const PENDING_MAX_AGE_MS = 15 * 60_000;
const PENDING_MAX_ATTEMPTS = 2;

function pendingDir(): string {
  return path.join(config.DATA_DIR, 'pending');
}

function pendingPath(msg: Message): string {
  return path.join(pendingDir(), `${msg.chat.id}_${msg.message_id}.json`);
}

function savePending(msg: Message, topic: string | undefined, ask: Ask, attempts: number): void {
  try {
    const pending: PendingAnswer = {
      msg,
      topic,
      ask: {
        question: ask.question,
        ignoreReply: ask.ignoreReply,
        previousMessageAt: ask.previousMessageAt?.toISOString(),
        // A hook-originated answer resumed after a restart must stay rights-free.
        viaHook: ask.viaHook,
      },
      startedAt: new Date().toISOString(),
      attempts,
    };
    fs.mkdirSync(pendingDir(), { recursive: true });
    fs.writeFileSync(pendingPath(msg), JSON.stringify(pending));
  } catch (error) {
    console.warn('[Secretary] Could not save a pending question:', (error as Error).message);
  }
}

function clearPending(msg: Message): void {
  fs.rmSync(pendingPath(msg), { force: true });
}

/**
 * Messages that have already been taken up as a question, so that editing one
 * (for example to fix a typo) does not get it answered a second time.
 */
const takenUp = new Set<string>();

function markTakenUp(msg: Message): boolean {
  const key = `${msg.chat.id}:${msg.message_id}`;
  if (takenUp.has(key)) return false;
  if (takenUp.size > 5000) takenUp.clear();
  takenUp.add(key);
  return true;
}

/**
 * When answers keep failing (an expired Claude token, a plan limit, a broken deploy),
 * the people in the group only see "try again". The owners get told what is wrong.
 */
const ALERT_AFTER_FAILURES = 3;
const ALERT_EVERY_MS = 60 * 60_000;
let consecutiveFailures = 0;
let lastAlertAt = 0;

function noteAnswerOutcome(api: Api, ok: boolean, reason = ''): void {
  if (ok) {
    consecutiveFailures = 0;
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures < ALERT_AFTER_FAILURES || Date.now() - lastAlertAt < ALERT_EVERY_MS) return;
  lastAlertAt = Date.now();
  const text = `⚠️ The secretary has failed to answer ${consecutiveFailures} times in a row.\nLatest error: ${reason.slice(0, 500)}`;
  for (const owner of getOwnerIds()) {
    api.sendMessage(owner, text).catch(() => {});
  }
}

/** Answers and scheduled tasks currently running; shutdown waits for this to reach zero. */
let inFlight = 0;

export function answersInFlight(): number {
  return inFlight;
}

async function answer(
  api: Api,
  me: BotFullInfo,
  group: GroupState,
  msg: Message,
  topic: string | undefined,
  ask: Ask,
  attempt = 1,
): Promise<void> {
  const chatId = msg.chat.id;
  const { target, moved } = answerTargetOf(group, msg);
  const answerTopic = moved && topic !== undefined ? topicNameOf(chatId, target.threadId) : topic;
  inFlight++;
  savePending(msg, topic, ask, attempt);
  const stopTyping = startTyping(api, target);
  // Shows the asker their question was picked up. Never allowed to block the answer, but a
  // failure is logged so it does not go unnoticed.
  api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: '👀' }]).catch((error) => {
    console.warn(`[Secretary] Could not react to msg ${msg.message_id} in ${chatId}:`, (error as Error).message);
  });

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
          // A hook-originated run never carries the rights of whoever wrote the message.
          askerId: ask.viaHook ? undefined : msg.from?.id,
          question,
          topic,
          threadId: target.threadId,
          repliedTo: replied ? `[${localTime(new Date(replied.date * 1000)).stamp}] ${formatMessageBody(replied)}` : undefined,
          images: attachments.images.length ? attachments.images : undefined,
          sendFile: fileSender(api, me, target, answerTopic),
          viewImage: imageViewer(api, chatId),
          fetchFile: sandboxEnabled() ? fileFetcher(api, group) : undefined,
          telegramCall: telegramCaller(api, me, chatId, target.threadId, answerTopic, `asked by ${senderOf(msg).name}`),
        },
        entry.controller,
      ),
    );

    stopTyping();
    // In another topic: a real reply if Telegram allows it, otherwise a line linking to the question.
    let sent = moved && result.text ? await sendAcrossTopics(api, target, msg, result.text) : undefined;
    if (!sent && result.text) {
      const linkBase = messageLinkBase(group);
      const origin = `${senderOf(msg).name}, #${topic ?? GENERAL_TOPIC}`;
      const text = moved
        ? `↪️ ${linkBase ? `[${origin}](${linkBase}/${msg.message_id})` : origin}\n${result.text}`
        : result.text;
      sent = await sendFormatted(api, target, text);
    }
    if (sent) {
      recordBotMessage(me, sent, result.text, `reply to msg ${msg.message_id} by ${senderOf(msg).name}`, answerTopic);
    }

    noteAnswerOutcome(api, true);
    logUsage(chatId, {
      t: new Date().toISOString(),
      kind: ask.viaHook ? 'hook' : 'ask',
      userId: msg.from?.id,
      name: ask.viaHook ?? senderOf(msg).name,
      costUsd: result.costUsd ?? 0,
      seconds: Math.round(result.durationMs / 1000),
      turns: result.turns ?? 0,
    });

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
      noteAnswerOutcome(api, false, reason);
    }
    const friendly = entry.controller.signal.aborted
      ? 'Stopped.'
      : 'Sorry, I could not answer that just now. Please try again in a moment.';
    await sendPlain(api, target, friendly).catch(() => {});
  } finally {
    active.delete(entry);
    inFlight--;
    // Answered, failed or stopped: either way it is settled and must not be retried.
    clearPending(msg);
    api.setMessageReaction(chatId, msg.message_id, []).catch((error) => {
      // "REACTION_EMPTY" only means there was nothing to remove.
      if (!/REACTION_EMPTY/.test((error as Error).message)) {
        console.warn(`[Secretary] Could not clear the reaction on msg ${msg.message_id} in ${chatId}:`, (error as Error).message);
      }
    });
  }
}

/** Start an answer without holding up the update queue: recording must keep flowing while Claude thinks. */
function answerInBackground(
  api: Api,
  me: BotFullInfo,
  group: GroupState,
  msg: Message,
  topic: string | undefined,
  ask: Ask,
  attempt = 1,
): void {
  void answer(api, me, group, msg, topic, ask, attempt).catch((error) => {
    console.error('[Secretary] Unexpected error:', error);
  });
}

/**
 * Announce finished deploys in the chat that asked for them. The host writes the
 * result; this checks for it now (after a restart) and then every 20 seconds
 * (a failed build leaves the bot running, so there is no restart to wait for).
 */
export function startDeployWatcher(api: Api, me: BotFullInfo): void {
  if (!deployEnabled()) return;
  const check = async () => {
    const result = takeDeployResult();
    if (!result) return;
    const text = result.ok
      ? `✅ Deployed ${result.sha.slice(0, 7)}${result.previous ? ` (was ${result.previous.slice(0, 7)})` : ''}. ${result.message}`.trim()
      : `❌ Deploy of ${result.sha.slice(0, 7)} failed, still running ${result.previous?.slice(0, 7) ?? 'the previous version'}.\n${result.message}`;
    try {
      const sent = await sendPlain(api, { chatId: result.chatId, threadId: result.threadId }, text);
      if (getGroup(result.chatId)?.enabled) recordBotMessage(me, sent, text, 'deploy', result.threadId ? topicNameOf(result.chatId, result.threadId) : undefined);
    } catch (error) {
      console.warn('[Deploy] Could not post the result:', (error as Error).message);
    }
  };
  void check();
  setInterval(() => void check(), 20_000).unref();
}

/**
 * Pick up questions that were cut off by a restart or crash. Called once at startup.
 * A question is retried once, and only while it is recent enough to still be wanted.
 */
export function resumePendingAnswers(api: Api, me: BotFullInfo): number {
  let files: string[];
  try {
    files = fs.readdirSync(pendingDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }

  let resumed = 0;
  for (const file of files) {
    const full = path.join(pendingDir(), file);
    try {
      const pending = JSON.parse(fs.readFileSync(full, 'utf8')) as PendingAnswer;
      const group = getGroup(pending.msg.chat.id);
      const fresh = Date.now() - new Date(pending.startedAt).getTime() <= PENDING_MAX_AGE_MS;
      if (!group?.enabled || !fresh || pending.attempts >= PENDING_MAX_ATTEMPTS) {
        fs.rmSync(full, { force: true });
        continue;
      }
      answerInBackground(
        api,
        me,
        group,
        pending.msg,
        pending.topic,
        {
          question: pending.ask.question,
          viaHook: pending.ask.viaHook,
          ignoreReply: pending.ask.ignoreReply,
          previousMessageAt: pending.ask.previousMessageAt ? new Date(pending.ask.previousMessageAt) : undefined,
        },
        pending.attempts + 1,
      );
      resumed++;
    } catch {
      fs.rmSync(full, { force: true });
    }
  }
  return resumed;
}

// ── Hooks ────────────────────────────────────────────────────────────

const HOOK_ACTIONS_PER_MINUTE = 30;
const hookActionTimes = new Map<number, number[]>();
const hookAskTimes = new Map<number, number[]>();

/** Sliding-window limiter: true if another event fits in the window, and counts it. */
function allow(times: Map<number, number[]>, chatId: number, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (times.get(chatId) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    times.set(chatId, recent);
    return false;
  }
  recent.push(now);
  times.set(chatId, recent);
  return true;
}

async function applyHookActions(
  api: Api,
  me: BotFullInfo,
  group: GroupState,
  msg: Message,
  topic: string | undefined,
  outcomes: HookOutcome[],
): Promise<void> {
  const chatId = msg.chat.id;
  const target = targetOf(msg);

  for (const { hook, actions } of outcomes) {
    for (const action of actions) {
      if (!allow(hookActionTimes, chatId, HOOK_ACTIONS_PER_MINUTE, 60_000)) {
        console.warn(`[Hooks] ${chatId}: more than ${HOOK_ACTIONS_PER_MINUTE} hook actions in a minute, skipping the rest`);
        return;
      }
      try {
        switch (action.do) {
          case 'reply': {
            const sent = await sendFormatted(api, target, action.text);
            if (sent) recordBotMessage(me, sent, action.text, `hook ${hook.name}, reply to msg ${msg.message_id}`, topic);
            break;
          }
          case 'send': {
            const sent = await sendFormatted(api, { chatId, threadId: target.threadId }, action.text);
            if (sent) recordBotMessage(me, sent, action.text, `hook ${hook.name}`, topic);
            break;
          }
          case 'photo': {
            const options = {
              message_thread_id: target.threadId,
              ...(action.caption ? { caption: action.caption } : {}),
              ...(action.reply ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}),
            };
            // A URL is fetched by Telegram's servers, never by the bot itself; a workspace
            // file comes out of the sandbox the same way send_file does.
            const sent = await api.sendPhoto(chatId, await photoSource(chatId, action), options);
            const context = action.reply ? `hook ${hook.name}, reply to msg ${msg.message_id}` : `hook ${hook.name}`;
            recordBotMessage(me, sent, `[photo]${action.caption ? ` ${action.caption}` : ''}`, context, topic);
            break;
          }
          case 'react':
            await api.setMessageReaction(chatId, msg.message_id, [{ type: 'emoji', emoji: action.emoji as never }]);
            break;
          case 'delete': {
            // An earlier message can be deleted too (Telegram allows it for 48 hours), so a
            // hook can keep a list of message ids and clean them up later.
            const id = action.message_id ?? msg.message_id;
            await api.deleteMessage(chatId, id);
            const who = id === msg.message_id ? ` from ${senderOf(msg).name}` : '';
            appendTranscript(chatId, new Date(), `* msg ${id}${who} was removed by the hook "${hook.name}"`, topic);
            break;
          }
          case 'pin':
            await api.pinChatMessage(chatId, action.message_id ?? msg.message_id, { disable_notification: true });
            break;
          case 'note':
            appendNote(chatId, action.text, `hook ${hook.name}`);
            break;
          case 'api':
            if (methodLevel(action.method) !== 'open') {
              console.warn(`[Hooks] ${chatId}: "${hook.name}" may not call ${action.method} (owner or manager only)`);
              break;
            }
            await telegramCaller(api, me, chatId, target.threadId, topic, `hook ${hook.name}`)(action.method, action.params);
            break;
          case 'ask':
            if (!allow(hookAskTimes, chatId, config.SECRETARY_HOOK_ASKS_PER_HOUR, 3_600_000)) {
              console.warn(`[Hooks] ${chatId}: hourly limit for hooks handing messages to the secretary reached`);
              break;
            }
            // A message the person already addressed to the secretary is not answered twice.
            if (!markTakenUp(msg)) break;
            answerInBackground(api, me, group, msg, topic, {
              question: `This message was handed to you automatically by the hook "${hook.name}", with this instruction: ${action.prompt}`,
              viaHook: hook.name,
            });
            break;
        }
      } catch (error) {
        console.warn(`[Hooks] ${chatId}: "${hook.name}" could not ${action.do}:`, (error as Error).message);
      }
    }
  }
}

/** A photo action's picture: a URL Telegram fetches itself, or a file read out of the workspace. */
async function photoSource(chatId: number, action: { url?: string; file?: string }): Promise<string | InputFile> {
  if (action.url) return action.url;
  return new InputFile(await readSandboxFile(chatId, sandboxUidFor(chatId), action.file!), action.file!.split('/').pop());
}

/**
 * Actions printed by a scheduled script ({"actions": [...]}, the same format as a hook's).
 * There is no incoming message here, so "reply" posts like "send", delete and pin need a
 * message_id, and react and ask are skipped.
 */
async function applyEventActions(
  api: Api,
  me: BotFullInfo,
  chatId: number,
  target: Target,
  topic: string | undefined,
  label: string,
  actions: HookAction[],
): Promise<void> {
  const schedule = { topic };
  for (const action of actions) {
    if (!allow(hookActionTimes, chatId, HOOK_ACTIONS_PER_MINUTE, 60_000)) {
      console.warn(`[Schedule] ${chatId}: more than ${HOOK_ACTIONS_PER_MINUTE} actions in a minute, skipping the rest`);
      return;
    }
    try {
      switch (action.do) {
        case 'reply':
        case 'send': {
          const sent = await sendFormatted(api, target, action.text);
          if (sent) recordBotMessage(me, sent, action.text, label, schedule.topic);
          break;
        }
        case 'photo': {
          const sent = await api.sendPhoto(chatId, await photoSource(chatId, action), {
            message_thread_id: target.threadId,
            ...(action.caption ? { caption: action.caption } : {}),
          });
          recordBotMessage(me, sent, `[photo]${action.caption ? ` ${action.caption}` : ''}`, label, schedule.topic);
          break;
        }
        case 'delete':
          if (action.message_id === undefined) break;
          await api.deleteMessage(chatId, action.message_id);
          appendTranscript(chatId, new Date(), `* msg ${action.message_id} was removed by ${label}`, schedule.topic);
          break;
        case 'pin':
          if (action.message_id !== undefined) await api.pinChatMessage(chatId, action.message_id, { disable_notification: true });
          break;
        case 'note':
          appendNote(chatId, action.text, label);
          break;
        case 'api':
          if (methodLevel(action.method) !== 'open') {
            console.warn(`[Actions] ${chatId}: ${label} may not call ${action.method} (owner or manager only)`);
            break;
          }
          await telegramCaller(api, me, chatId, target.threadId, topic, label)(action.method, action.params);
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn(`[Actions] ${chatId}: ${label} could not ${action.do}:`, (error as Error).message);
    }
  }
}

/** Run the group's hooks on one message and carry out what they ask for. Returns how many hooks acted. */
export async function runHooksOnMessage(
  api: Api,
  me: BotFullInfo,
  group: GroupState,
  msg: Message,
  topic: string | undefined,
  edited: boolean,
): Promise<number> {
  if (!sandboxEnabled() || !config.SECRETARY_HOOKS || !hasActiveHooks(group.chatId)) return 0;
  const outcomes = await runHooks(group.chatId, sandboxUidFor(group.chatId), msg, topic, edited);
  if (outcomes.length) await applyHookActions(api, me, group, msg, topic, outcomes);
  return outcomes.length;
}

/** The same, off the main path, so recording and answering never wait for scripts. */
function dispatchHooks(api: Api, me: BotFullInfo, group: GroupState, msg: Message, topic: string | undefined, edited: boolean): void {
  void runHooksOnMessage(api, me, group, msg, topic, edited).catch((error) => {
    console.warn(`[Hooks] ${group.chatId}: could not run hooks:`, (error as Error).message);
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

    if (schedule.kind === 'script') {
      // Runs in the sandbox without Claude. What it prints is the post; printing nothing posts nothing.
      const file = schedule.text;
      const runner = file.endsWith('.py') ? 'python3' : /\.m?js$/.test(file) ? 'node' : 'bash';
      const result = await runInSandbox(chatId, sandboxUidFor(chatId), `${runner} "$SCHEDULED_SCRIPT"`, 240, { SCHEDULED_SCRIPT: file });
      const output = result.stdout.trim();
      if (result.code !== 0) {
        const why = result.timedOut ? 'ran past its time limit' : (result.stderr.trim().split('\n').pop() ?? `exit code ${result.code}`);
        console.warn(`[Schedule] Script ${schedule.id} (${file}) in ${chatId} failed: ${why}`);
        await post(`⚠️ The scheduled script ${file} (${schedule.id}) failed: ${why.slice(0, 300)}`).catch(() => {});
        return;
      }
      // A script may print actions instead of a message.
      let actions: HookAction[] = [];
      if (/^[[{]/.test(output)) {
        try {
          actions = parseActions(output);
        } catch {
          actions = [];
        }
      }
      if (actions.length) {
        await applyEventActions(api, me, chatId, target, schedule.topic, `scheduled script ${schedule.id}`, actions);
      } else if (output) {
        const text = output.slice(0, 12_000);
        const sent = await post(text);
        if (sent) recordBotMessage(me, sent, text, `scheduled script ${schedule.id} (${file})`, schedule.topic);
      }
      console.log(`[Schedule] Ran script ${schedule.id} in ${chatId} (${output ? 'posted' : 'nothing to post'})`);
      return;
    }

    const stopTyping = startTyping(api, target);
    inFlight++;
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
          effort: schedule.effort,
          sendFile: fileSender(api, me, target, schedule.topic),
          viewImage: imageViewer(api, chatId),
          fetchFile: sandboxEnabled() ? fileFetcher(api, group) : undefined,
          telegramCall: telegramCaller(api, me, chatId, target.threadId, schedule.topic, `scheduled task ${schedule.id}`),
        }),
      );
      stopTyping();
      const sent = result.text ? await post(result.text) : undefined;
      if (sent) recordBotMessage(me, sent, result.text, `scheduled task ${schedule.id} set by ${schedule.createdBy}`, schedule.topic);
      logUsage(chatId, {
        t: new Date().toISOString(),
        kind: 'task',
        name: schedule.text.slice(0, 40),
        costUsd: result.costUsd ?? 0,
        seconds: Math.round(result.durationMs / 1000),
        turns: result.turns ?? 0,
      });
      console.log(`[Schedule] Ran task ${schedule.id} in ${chatId} (${(result.durationMs / 1000).toFixed(1)}s)`);
    } catch (error) {
      stopTyping();
      console.error(`[Schedule] Task ${schedule.id} in ${chatId} failed:`, (error as Error).message);
      await post(`⚠️ The scheduled task "${schedule.text.slice(0, 80)}" (${schedule.id}) could not be completed this time.`).catch(() => {});
    } finally {
      inFlight--;
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
    '• /reminders — list reminders, recurring tasks and scheduled scripts',
    '• /hooks — scripts that react to messages; /hooks off <name> switches one off',
    '• /usage [days] — who used how much Claude',
    '• /stop — stop the answer I am working on',
    '• /status — what I am recording',
    '• /settings — where I answer, model, house rules, managers; the owner or a manager changes them by asking me',
    '',
    'Things you can ask me to do:',
    '• "Remember that the AGM moved to 20 Dec" — I keep notes',
    '• "Remind us on Friday at 6pm to bring the banner", "Post a recap every Monday at 9am"',
  ];
  if (sandboxEnabled()) {
    lines.push('• "Make a spreadsheet of who is coming", "Chart who talks the most" — I can run scripts and send files');
    lines.push('• Reply to a PDF, Word or Excel file and mention me to have it read');
    lines.push('• "Make a hook that deletes messages containing X", "Run this script every 10 minutes" — automation without asking each time');
  }
  lines.push(
    '',
    'Admins: /welcome <text> sets a greeting for new members. ' +
      'Owner or managers: /effort <level>, /model <name>, /answerhere (send all answers to this topic). Owner: /enable, /disable, /forget.',
  );
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

  /** Reply to the command, and keep the reply in the record so the secretary can refer to it later. */
  const say = async (text: string): Promise<void> => {
    const sent = await sendPlain(api, target, text);
    recordBotMessage(ctx.me, sent, text, `reply to /${command} by ${senderOf(msg).name}`, recorded.topic);
  };

  if (command === 'enable') {
    await handleEnable(ctx, msg);
    return;
  }

  // Until an owner enables the group, the bot stays silent.
  if (!group?.enabled) return;

  switch (command) {
    case 'disable':
      if (!isOwner(msg.from?.id)) {
        await say("Only the bot's owner can turn the secretary off.");
        return;
      }
      disableGroup(chatId);
      await say('📕 Secretary mode is off. I have stopped recording and reminders are paused; the existing record is kept. /enable turns me back on, /forget erases the record.');
      return;

    case 'forget':
      if (!isOwner(msg.from?.id)) {
        await say("Only the bot's owner can erase the record.");
        return;
      }
      if (args.toLowerCase() !== 'confirm') {
        await say('This permanently deletes everything I have for this group: the record, notes, reminders and workspace files. Send "/forget confirm" to go ahead.');
        return;
      }
      if (sandboxEnabled() && group.sandboxUid !== undefined) {
        await clearSandbox(chatId, group.sandboxUid).catch((error) => {
          console.error(`[Secretary] Could not clear the workspace of ${chatId}:`, (error as Error).message);
        });
      }
      deleteGroupData(chatId);
      forgetSchedules(chatId);
      forgetHooks(chatId);
      forgetSecrets(chatId);
      forgetMcpServers(chatId);
      removeGroup(chatId);
      await say('🗑 Everything I had for this group has been erased and recording is off.');
      return;

    case 'welcome': {
      if (!(await isAdminOrOwner(ctx, msg))) {
        await say('Only group admins can set the welcome message.');
        return;
      }
      if (!args) {
        await say(
          group.welcome
            ? `Current welcome message:\n\n${group.welcome}\n\nChange it with /welcome <text>, or turn it off with /welcome off.`
            : 'No welcome message is set. Use /welcome <text>; {name} is replaced with the new member\'s name and {group} with the group name.',
        );
        return;
      }
      if (args.toLowerCase() === 'off') {
        setWelcome(chatId, undefined);
        await say('Welcome message turned off.');
        return;
      }
      setWelcome(chatId, args.slice(0, 1500));
      await say('Welcome message saved. New members will be greeted with it.');
      return;
    }

    case 'hooks': {
      const [verb, name] = args.split(/\s+/);
      if ((verb === 'on' || verb === 'off') && name) {
        const existing = listHooks(chatId).find((h) => h.name === name.toLowerCase());
        if (!existing) {
          await say(`There is no hook named "${name}".`);
          return;
        }
        // The person who made a hook, group admins and the owner may switch it.
        const allowed =
          existing.createdBy === senderLabel(senderOf(msg)) || canManage(group, msg.from?.id) || (await isAdminOrOwner(ctx, msg));
        if (!allowed) {
          await say(`Only ${existing.createdBy}, a group admin, the bot's owner or a manager can switch "${existing.name}" ${verb}.`);
          return;
        }
        setHookEnabled(chatId, existing.name, verb === 'on');
        await say(`Hook "${existing.name}" is now ${verb}.`);
        return;
      }
      const hooks = listHooks(chatId);
      await say(
        hooks.length
          ? `Hooks (scripts that react to messages):\n\n${hooks.map((h) => `• ${describeHook(h)}`).join('\n')}\n\n/hooks off <name> or /hooks on <name> switches one. Ask me to change or remove one.`
          : 'No hooks yet. Ask me for one, e.g. "make a hook that reacts with 🔥 whenever someone posts a GitHub link".',
      );
      return;
    }

    case 'usage': {
      const days = Math.min(Math.max(parseInt(args, 10) || 7, 1), 365);
      await say(formatUsage(chatId, days));
      return;
    }

    case 'effort': {
      const current = group.effort ?? config.SECRETARY_EFFORT;
      const levels = EFFORT_LEVELS.join(', ');
      const wanted = args.toLowerCase();
      if (!wanted) {
        await say(
          `Effort is ${current}${group.effort ? '' : ' (the default)'}. Levels: ${levels}. ` +
            'Higher means more thinking and checking per answer: better on hard questions, slower, and it uses more of the Claude plan. ' +
            'The owner or a manager can change it with /effort <level>, or /effort default.',
        );
        return;
      }
      if (!canManage(group, msg.from?.id)) {
        await say("Only the bot's owner or a manager can change the effort level.");
        return;
      }
      if (wanted === 'default') {
        setGroupEffort(chatId, undefined);
        await say(`Effort is back to the default (${config.SECRETARY_EFFORT}).`);
        return;
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(wanted)) {
        await say(`"${args}" is not a level. Use one of: ${levels}, or default.`);
        return;
      }
      setGroupEffort(chatId, wanted as EffortLevel);
      await say(`Effort set to ${wanted} for this group (was ${current}). It applies from the next question.`);
      return;
    }

    case 'model': {
      const current = group.model ?? 'default';
      const names = Object.keys(MODEL_CHOICES).join(', ');
      const wanted = args.trim();
      if (!wanted) {
        await say(
          `Model: ${group.model ?? `the default (${config.SECRETARY_MODEL || config.CLAUDE_MODEL})`}. ` +
            `Choices: ${names}, or any claude-... model id. Bigger models answer harder questions better but cost more per answer (see /usage). ` +
            'The owner or a manager can change it with /model <name>, or /model default.',
        );
        return;
      }
      if (!canManage(group, msg.from?.id)) {
        await say("Only the bot's owner or a manager can change the model.");
        return;
      }
      if (wanted.toLowerCase() === 'default') {
        setGroupModel(chatId, undefined);
        await say(`Model is back to the default (${config.SECRETARY_MODEL || config.CLAUDE_MODEL}).`);
        return;
      }
      const model = resolveModel(wanted);
      if (!model) {
        await say(`"${wanted}" is not a Claude model. Use one of: ${names}, a full claude-... id, or default.`);
        return;
      }
      setGroupModel(chatId, model);
      await say(`Model set to ${model} for this group (was ${current}). It applies from the next question.`);
      return;
    }

    case 'answerhere': {
      if (!isForum(msg)) {
        await say('This only works in groups with topics.');
        return;
      }
      if (!canManage(group, msg.from?.id)) {
        await say("Only the bot's owner or a manager can choose where answers go.");
        return;
      }
      if (args.toLowerCase() === 'off') {
        setAnswerTopic(chatId, undefined);
        await say('Answers go back to the topic each question was asked in.');
        return;
      }
      const here = threadIdOf(msg);
      setAnswerTopic(chatId, here ?? 0);
      await say(
        `From now on every answer is posted in #${topicNameOf(chatId, here)}, with a link back to the question. ` +
          'Command replies and hook messages stay where they happen. /answerhere off undoes this.',
      );
      return;
    }

    case 'manager':
    case 'managers': {
      const [verb, ...who] = args.split(/\s+/);
      const query = who.join(' ');
      if (!['add', 'remove'].includes(verb?.toLowerCase()) || !query) {
        await say(
          `${describeSettings(group).split('\n').find((line) => line.startsWith('Owner:'))}\n\n` +
            'The owner adds or removes a manager with /manager add @username or /manager remove @username. ' +
            "Managers can change this group's settings, secrets and hooks by asking me.",
        );
        return;
      }
      if (!isOwner(msg.from?.id)) {
        await say("Only the bot's owner can add or remove managers.");
        return;
      }
      const member = findMember(chatId, query);
      if (!member) {
        await say(`No member called "${query}" has written in this group yet.`);
        return;
      }
      const managers = new Set(group.managers ?? []);
      if (verb.toLowerCase() === 'add') managers.add(member.id);
      else managers.delete(member.id);
      updateGroupSettings(chatId, { managers: [...managers] });
      await say(`${member.name} is ${verb.toLowerCase() === 'add' ? 'now a manager' : 'no longer a manager'} of this group.`);
      return;
    }

    case 'machine': {
      if (!sandboxEnabled() || config.SANDBOX_BACKEND !== 'workbench') {
        await say("This group's workspace is not its own machine on this server (SANDBOX_BACKEND is not workbench).");
        return;
      }
      const wanted = args.toLowerCase();
      if (wanted === 'reset' && !canManage(group, msg.from?.id)) {
        await say("Only the bot's owner or a manager can reset the machine.");
        return;
      }
      try {
        const info = await sandboxMachineAction(chatId, sandboxUidFor(chatId), wanted === 'reset' ? 'reset' : 'status');
        const lines = Object.entries(info)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `• ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
        await say(
          (wanted === 'reset' ? 'Machine reset: it is rebuilt fresh on the next command (files in the workspace stay, ~/.setup.sh runs again).\n' : '') +
            (lines.join('\n') || 'No details.') +
            (wanted === 'reset' ? '' : '\n\n/machine reset (owner or manager) rebuilds it from a clean image; workspace files stay.'),
        );
      } catch (error) {
        await say(`Could not reach the machine: ${(error as Error).message}`);
      }
      return;
    }

    case 'version': {
      const version = currentVersion();
      await say(
        version
          ? `Running ${version.sha.slice(0, 7)}${version.deployedAt ? `, deployed ${version.deployedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}.`
          : "I don't know which version is running (it was not deployed from the chat).",
      );
      return;
    }

    case 'deploy': {
      if (!deployEnabled()) {
        await say('Deploying from the chat is not set up on this server (DEPLOY_FROM_CHAT and the host deployer).');
        return;
      }
      if (!isOwner(msg.from?.id)) {
        await say("Only the bot's owner can deploy.");
        return;
      }
      const [verb, sha] = args.split(/\s+/);
      if (verb?.toLowerCase() === 'confirm') {
        const problem = confirmDeploy(chatId, sha ?? '', senderLabel(senderOf(msg)), threadIdOf(msg));
        await say(problem ?? `🚀 Deploying ${sha}. I'll be back in a minute or two and post the result here.`);
        return;
      }
      try {
        await say(describePlan(await planDeploy(chatId, verb || 'main')));
      } catch (error) {
        await say(`Could not look that up: ${(error as Error).message}`);
      }
      return;
    }

    case 'settings':
      await say(
        `Settings for this group:\n${describeSettings(group)}\n\n` +
          'The owner or a manager can change any of these by asking me, e.g. "send all answers to #bot", ' +
          '"answer everyone in English", "use sonnet". The owner names managers with /manager add @username.',
      );
      return;

    case 'status': {
      const stats = transcriptStats(chatId);
      const topics = group.isForum ? ` · ${listTopicNames(chatId).length + 1} topics known` : '';
      const schedules = listSchedules(chatId).length;
      await say(
        `📒 Recording "${group.title}" since ${stats.firstDay ?? 'today'} · ${stats.days} day(s) on file (${formatBytes(stats.bytes)})${topics}` +
          ` · ${schedules} reminder(s)/task(s) · workspace ${sandboxEnabled() ? 'on' : 'off'}` +
          ` · ${listHooks(chatId).filter((h) => h.enabled).length} hook(s) on` +
          ` · effort ${group.effort ?? config.SECRETARY_EFFORT}` +
          ` · model ${group.model ?? 'default'}` +
          (group.answerTopic !== undefined ? ` · answers go to #${topicNameOf(chatId, group.answerTopic || undefined)}` : '') +
          (await privacyWarning(ctx, chatId)),
      );
      return;
    }

    case 'reminders': {
      const schedules = listSchedules(chatId);
      await say(
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
        await say(active.length ? 'You can only stop your own question.' : 'Nothing is running.');
        return;
      }
      for (const entry of mine) entry.controller.abort();
      return;
    }

    case 'help':
    case 'start':
      await say(helpText(ctx.me));
      return;

    case 'ask':
      if (!args) {
        await say('Ask me something, e.g. "/ask what did we decide about the venue?"');
        return;
      }
      answerInBackground(api, ctx.me, group, msg, recorded.topic, { question: args, previousMessageAt: recorded.previousMessageAt });
      return;

    case 'summary':
      answerInBackground(api, ctx.me, group, msg, recorded.topic, {
        ignoreReply: true,
        question:
          `Give a recap of the group's discussion${args ? ` for: "${args}"` : ' today'}. ` +
          'Cover each topic that had real discussion: the main points, decisions made, questions still open, and action items with who owns them. ' +
          'Leave out small talk. If little happened in that period, say so briefly.',
      });
      return;

    case 'catchup':
      answerInBackground(api, ctx.me, group, msg, recorded.topic, {
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

// ── Secrets ──────────────────────────────────────────────────────────

const SECRET_COMMAND = /^\/(secrets?)(?:@(\w+))?(?:\s+([\s\S]*))?$/i;

/** A /secret command meant for this bot (it may hold a key, so it is handled before anything else sees it). */
function secretCommandOf(msg: Message, botUsername: string | undefined): { args: string } | undefined {
  const match = (msg.text ?? '').trim().match(SECRET_COMMAND);
  if (!match) return undefined;
  if (match[2] && match[2].toLowerCase() !== (botUsername ?? '').toLowerCase()) return undefined;
  return { args: (match[3] ?? '').trim() };
}

/** Carry out /secret for one group and return the reply. Never echoes a value. */
function applySecretCommand(group: GroupState, userId: number | undefined, who: string, args: string): string {
  const names = () => {
    const list = listSecrets(group.chatId);
    return list.length
      ? `Secrets for "${group.title}" (available to my workspace as environment variables):\n${list.map((s) => `• ${s.name}, set by ${s.setBy} on ${s.setAt.slice(0, 10)}`).join('\n')}`
      : `No secrets are set for "${group.title}".`;
  };
  if (!args) {
    return `${names()}\n\nThe owner or a manager adds one with /secret NAME value (best in a private chat with me) and removes it with /secret unset NAME.`;
  }
  if (!canManage(group, userId)) {
    return "Only the bot's owner or a manager of this group can set secrets. If that was a real key, revoke it: I deleted the message, but people may have seen it.";
  }
  const [first, second, ...rest] = args.split(/\s+/);
  if (first.toLowerCase() === 'unset' && second) {
    return removeSecret(group.chatId, second) ? `Removed ${second}.` : `There is no secret called ${second}.`;
  }
  const value = [second, ...rest].join(' ').trim();
  if (!value) return 'Use /secret NAME value, e.g. /secret AGENTMAIL_API_KEY am_us_...';
  try {
    setSecret(group.chatId, first, value, who);
  } catch (error) {
    return (error as Error).message;
  }
  return (
    `🔑 Saved ${first} for "${group.title}". Commands, hooks and scripts in my workspace can use it as $${first}. ` +
    'Anyone who can ask me to run commands can use it too, so only add keys the whole group may use.'
  );
}

/** /secret sent in the group: remove the message, keep it out of the record, then act on it. */
async function handleSecretInGroup(ctx: Context, group: GroupState | undefined, msg: Message, args: string): Promise<void> {
  const deleted = await ctx.api.deleteMessage(msg.chat.id, msg.message_id).then(
    () => true,
    (error) => {
      console.warn(`[Secretary] Could not delete a /secret message in ${msg.chat.id}:`, (error as Error).message);
      return false;
    },
  );
  if (!group) return;
  const topic = topicOf(msg);
  appendTranscript(msg.chat.id, new Date(msg.date * 1000), `* ${senderOf(msg).name} sent /secret (kept out of the record)`, topic);
  const warning =
    args && !deleted ? "\n\n⚠️ I couldn't delete your message (I need to be an admin who can delete messages), so delete it yourself and treat the key as seen." : '';
  const text = applySecretCommand(group, msg.from?.id, senderLabel(senderOf(msg)), args) + warning;
  const sent = await sendPlain(ctx.api, { chatId: msg.chat.id, threadId: threadIdOf(msg) }, text).catch(() => undefined);
  if (sent) recordBotMessage(ctx.me, sent, text, `reply to /secret by ${senderOf(msg).name}`, topic);
}

/** /secret in a private chat: "/secret NAME value", or "/secret <group id> NAME value" for one of several groups. */
async function handleSecretInPrivate(ctx: Context, args: string): Promise<void> {
  const userId = ctx.from?.id;
  const mine = listGroups().filter((g) => g.enabled && canManage(g, userId));
  if (ctx.message) ctx.api.deleteMessage(ctx.message.chat.id, ctx.message.message_id).catch(() => {});
  if (!mine.length) {
    await ctx.reply("You are not the owner or a manager of any group I'm in, so you can't set secrets.");
    return;
  }
  const [first, ...rest] = args.split(/\s+/);
  const byId = /^-?\d+$/.test(first ?? '');
  const chosen = byId ? mine.find((g) => String(g.chatId) === first) : mine.length === 1 ? mine[0] : undefined;
  if (!chosen) {
    await ctx.reply(
      `Which group? Put its id first, e.g. /secret ${mine[0].chatId} NAME value\n\n${mine.map((g) => `• ${g.title}: ${g.chatId}`).join('\n')}`,
    );
    return;
  }
  const name = ctx.from ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') : 'someone';
  const who = ctx.from?.username ? `${name} (@${ctx.from.username})` : name;
  await ctx.reply(applySecretCommand(chosen, userId, who, (byId ? rest.join(' ') : args).trim()));
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

/**
 * Button presses, reactions and poll votes in a group: handed to the group's hooks as events
 * ("callback", "reaction", "poll_answer"), whose actions are then carried out. A button press
 * that no hook answers is still acknowledged, so the button stops spinning.
 */
async function handleGroupEvent(ctx: Context): Promise<boolean> {
  let chatId: number | undefined;
  let threadId: number | undefined;
  let event: Record<string, unknown> | undefined;
  let callbackId: string | undefined;
  const person = (u?: { id: number; first_name: string; last_name?: string; username?: string }) =>
    u ? { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username ?? null } : null;

  if (ctx.callbackQuery && ctx.chat && ctx.chat.type !== 'private') {
    const message = ctx.callbackQuery.message as Message | undefined;
    chatId = ctx.chat.id;
    threadId = message?.is_topic_message ? message.message_thread_id : undefined;
    callbackId = ctx.callbackQuery.id;
    event = {
      event: 'callback',
      callback_query_id: callbackId,
      data: ctx.callbackQuery.data ?? null,
      message_id: message?.message_id ?? null,
      message_text: message?.text ?? message?.caption ?? null,
      from: person(ctx.callbackQuery.from),
      raw: ctx.callbackQuery,
    };
  } else if (ctx.messageReaction) {
    const reaction = ctx.messageReaction;
    chatId = reaction.chat.id;
    const emoji = (list: typeof reaction.new_reaction) => list.map((r) => (r.type === 'emoji' ? r.emoji : r.type));
    event = {
      event: 'reaction',
      message_id: reaction.message_id,
      from: person(reaction.user),
      added: emoji(reaction.new_reaction).filter((e) => !emoji(reaction.old_reaction).includes(e)),
      removed: emoji(reaction.old_reaction).filter((e) => !emoji(reaction.new_reaction).includes(e)),
      now: emoji(reaction.new_reaction),
      raw: reaction,
    };
  } else if (ctx.pollAnswer) {
    const poll = pollChats.get(ctx.pollAnswer.poll_id);
    if (!poll) return true; // not one of ours, or from before a restart
    chatId = poll.chatId;
    event = { event: 'poll_answer', poll_id: ctx.pollAnswer.poll_id, option_ids: ctx.pollAnswer.option_ids, from: person(ctx.pollAnswer.user), raw: ctx.pollAnswer };
  } else {
    return false;
  }

  const group = chatId !== undefined && isGroupEnabled(chatId) ? getGroup(chatId) : undefined;
  let answered = false;
  if (group && sandboxEnabled() && config.SECRETARY_HOOKS && hasActiveHooks(group.chatId, event.event as HookEventType)) {
    const topic = group.isForum ? topicNameOf(group.chatId, threadId) : undefined;
    event.topic = topic ?? null;
    event.local_time = localTime(new Date()).stamp;
    try {
      const outcomes = await runHooksForEvent(group.chatId, sandboxUidFor(group.chatId), event);
      for (const { hook, actions } of outcomes) {
        answered ||= actions.some((a) => a.do === 'api' && a.method === 'answerCallbackQuery');
        await applyEventActions(ctx.api, ctx.me, group.chatId, { chatId: group.chatId, threadId }, topic, `hook ${hook.name}`, actions);
      }
    } catch (error) {
      console.warn(`[Hooks] ${group.chatId}: could not run hooks on a ${String(event.event)}:`, (error as Error).message);
    }
  }
  if (callbackId && !answered) await ctx.api.answerCallbackQuery(callbackId).catch(() => {});
  return true;
}

export async function secretaryMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (await handleGroupEvent(ctx)) return;
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
    const secret = ctx.message && secretCommandOf(ctx.message, ctx.me.username);
    if (secret) {
      await handleSecretInPrivate(ctx, secret.args);
      return;
    }
    if (/^\/groups(?:@\w+)?\s*$/.test(text) && isOwner(ctx.from?.id)) {
      await handleGroups(ctx);
      return;
    }
    if (/^\/backup(?:@\w+)?\s*$/.test(text) && isOwner(ctx.from?.id)) {
      try {
        await sendBackup(ctx.api, 'requested');
      } catch (error) {
        await ctx.reply(`Could not make a backup: ${(error as Error).message}`);
      }
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
    migrateSecrets(chat.id, msg.migrate_to_chat_id);
    return;
  }
  if (msg.migrate_from_chat_id) return;

  // A /secret may carry a key: it never reaches the record, the hooks or the secretary.
  const secret = secretCommandOf(msg, ctx.me.username);
  if (secret) {
    await handleSecretInGroup(ctx, isGroupEnabled(chat.id) ? getGroup(chat.id) : undefined, msg, secret.args);
    return;
  }

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

  // Hooks see every new and edited message from people (never the bot's own, never replays).
  if (enabledGroup && !msg.from?.is_bot && Date.now() / 1000 - (edited ? (msg.edit_date ?? msg.date) : msg.date) <= ANSWER_MAX_AGE_SECONDS) {
    dispatchHooks(ctx.api, ctx.me, enabledGroup, msg, recorded.topic, edited);
  }

  // People often send a question, then edit it to add the @mention they forgot.
  // An edited message is answered only for that case: a mention, and only once.
  const lastTouched = edited ? (msg.edit_date ?? msg.date) : msg.date;
  const fresh = Date.now() / 1000 - lastTouched <= ANSWER_MAX_AGE_SECONDS;
  if (edited) {
    const editTrigger = detectTrigger(msg, { id: ctx.me.id, username: ctx.me.username ?? '' });
    if (!enabledGroup || !fresh || editTrigger?.kind !== 'ask' || editTrigger.via !== 'mention' || !editTrigger.question) return;
    if (!markTakenUp(msg)) return;
    answerInBackground(ctx.api, ctx.me, enabledGroup, msg, recorded.topic, { question: editTrigger.question });
    return;
  }

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

  markTakenUp(msg);
  answerInBackground(ctx.api, ctx.me, group, msg, recorded.topic, { question, previousMessageAt: recorded.previousMessageAt });
}
