/**
 * The whole Telegram Bot API for the secretary, its hooks and its scripts,
 * always pointed at the group it is working for.
 *
 * Any method can be called by name with Telegram's own parameters. What keeps
 * it safe is not a short list of features but three rules applied to every call:
 *  - chat_id (and from_chat_id) are always this group: nothing reaches another chat.
 *  - each method has a level: "open" for anyone (sending, reacting, reading),
 *    "managed" for the owner or a manager (moderation, group settings),
 *    "owner" for the bot's owner (anything that changes the bot everywhere, and
 *    any method not listed here), "forbidden" for what would break the bot.
 *  - a string parameter "workspace:<path>" is uploaded from the group's workspace.
 */

import { InputFile, type Api } from 'grammy';

export type MethodLevel = 'open' | 'managed' | 'owner' | 'forbidden';

const OPEN = new Set([
  'getMe', 'getChat', 'getChatMember', 'getChatAdministrators', 'getChatMemberCount', 'getUserProfilePhotos',
  'getStickerSet', 'getCustomEmojiStickers', 'getForumTopicIconStickers', 'getUserChatBoosts', 'getAvailableGifts',
  'sendMessage', 'sendPhoto', 'sendAudio', 'sendDocument', 'sendVideo', 'sendAnimation', 'sendVoice', 'sendVideoNote',
  'sendMediaGroup', 'sendLocation', 'sendVenue', 'sendContact', 'sendPoll', 'sendDice', 'sendSticker', 'sendChatAction',
  'sendPaidMedia', 'sendChecklist',
  'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages',
  'editMessageText', 'editMessageCaption', 'editMessageMedia', 'editMessageReplyMarkup', 'editMessageLiveLocation',
  'stopMessageLiveLocation', 'editMessageChecklist', 'stopPoll', 'setMessageReaction', 'answerCallbackQuery',
  'pinChatMessage', 'unpinChatMessage',
]);

const MANAGED = new Set([
  'deleteMessage', 'deleteMessages',
  'banChatMember', 'unbanChatMember', 'restrictChatMember', 'setChatAdministratorCustomTitle',
  'banChatSenderChat', 'unbanChatSenderChat', 'setChatPermissions',
  'exportChatInviteLink', 'createChatInviteLink', 'editChatInviteLink', 'revokeChatInviteLink',
  'createChatSubscriptionInviteLink', 'editChatSubscriptionInviteLink', 'approveChatJoinRequest', 'declineChatJoinRequest',
  'setChatPhoto', 'deleteChatPhoto', 'setChatTitle', 'setChatDescription', 'unpinAllChatMessages',
  'setChatStickerSet', 'deleteChatStickerSet',
  'createForumTopic', 'editForumTopic', 'closeForumTopic', 'reopenForumTopic', 'deleteForumTopic',
  'unpinAllForumTopicMessages', 'editGeneralForumTopic', 'closeGeneralForumTopic', 'reopenGeneralForumTopic',
  'hideGeneralForumTopic', 'unhideGeneralForumTopic', 'unpinAllGeneralForumTopicMessages',
]);

/**
 * Would cut the bot off from Telegram, hand out what only the bot may hold, or (leaving the
 * group, making admins) be hard to undo if text written by members steered a run. People do
 * these in the Telegram app instead.
 */
const FORBIDDEN = new Set(['getUpdates', 'setWebhook', 'deleteWebhook', 'getWebhookInfo', 'logOut', 'close', 'getFile', 'leaveChat', 'promoteChatMember']);

export function methodLevel(method: string): MethodLevel {
  if (FORBIDDEN.has(method)) return 'forbidden';
  if (OPEN.has(method)) return 'open';
  if (MANAGED.has(method)) return 'managed';
  return 'owner';
}

const WORKSPACE_PREFIX = 'workspace:';

/**
 * Point a call at this group and turn "workspace:<path>" strings into uploads.
 * Throws with a readable reason when the call cannot be made as asked.
 */
export async function prepareCall(
  method: string,
  params: Record<string, unknown>,
  where: { chatId: number; threadId?: number },
  readFile: (path: string) => Promise<Buffer>,
): Promise<Record<string, unknown>> {
  if (!/^[a-zA-Z]{2,60}$/.test(method)) throw new Error(`"${method}" is not a Telegram method name.`);
  if (methodLevel(method) === 'forbidden') throw new Error(`${method} is not available: it would cut the bot off or expose its token.`);
  if ('inline_message_id' in params || 'business_connection_id' in params) {
    throw new Error('Only messages in this group can be used (no inline_message_id or business_connection_id).');
  }

  const payload: Record<string, unknown> = { ...params, chat_id: where.chatId };
  // A reply may only quote a message of this group.
  if (payload.reply_parameters && typeof payload.reply_parameters === 'object') {
    payload.reply_parameters = { ...(payload.reply_parameters as Record<string, unknown>), chat_id: where.chatId };
  }
  if (method === 'forwardMessage' || method === 'forwardMessages' || method === 'copyMessage' || method === 'copyMessages') {
    payload.from_chat_id = where.chatId;
  }
  // Sending defaults to the topic the conversation is in.
  if (/^send/.test(method) && payload.message_thread_id === undefined && where.threadId !== undefined) {
    payload.message_thread_id = where.threadId;
  }
  // Methods that do not take a chat (getMe, answerCallbackQuery, sticker lookups, ...).
  if (CHATLESS.has(method)) delete payload.chat_id;

  const convert = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string' && value.startsWith(WORKSPACE_PREFIX)) {
      const file = value.slice(WORKSPACE_PREFIX.length).replace(/^\.\//, '');
      return new InputFile(await readFile(file), file.split('/').pop());
    }
    if (Array.isArray(value)) return Promise.all(value.map(convert));
    if (value && typeof value === 'object' && !(value instanceof InputFile)) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = await convert(inner);
      return out;
    }
    return value;
  };
  return (await convert(payload)) as Record<string, unknown>;
}

const CHATLESS = new Set([
  'getMe', 'getUserProfilePhotos', 'getStickerSet', 'getCustomEmojiStickers', 'getForumTopicIconStickers',
  'answerCallbackQuery', 'getAvailableGifts', 'setMyCommands', 'deleteMyCommands', 'getMyCommands', 'setMyName',
  'getMyName', 'setMyDescription', 'getMyDescription', 'setMyShortDescription', 'getMyShortDescription',
  'setMyDefaultAdministratorRights', 'getMyDefaultAdministratorRights',
]);

/** Call any Bot API method through grammY's raw API. */
export async function callTelegram(api: Api, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const raw = api.raw as unknown as Record<string, ((p: Record<string, unknown>) => Promise<unknown>) | undefined>;
  const fn = raw[method];
  if (typeof fn !== 'function') throw new Error(`${method} is not a Telegram method (or this library is too old for it).`);
  return fn.call(api.raw, payload);
}

/** The messages a call produced, so they can be written to the record. */
export function sentMessages(result: unknown): Array<{ message_id: number; date: number; text?: string; caption?: string; chat: { id: number } }> {
  const list = Array.isArray(result) ? result : [result];
  return list.filter(
    (m): m is { message_id: number; date: number; text?: string; caption?: string; chat: { id: number } } =>
      !!m && typeof m === 'object' && typeof (m as { message_id?: unknown }).message_id === 'number' && typeof (m as { date?: unknown }).date === 'number',
  );
}
