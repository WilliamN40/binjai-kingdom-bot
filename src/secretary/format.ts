/**
 * Turns Telegram messages into the one-line text records stored in transcripts.
 * Pure functions only: no I/O, so they are easy to test.
 */

import type { Message, MessageEntity, User } from 'grammy/types';

export interface Sender {
  id: number;
  name: string;
  username?: string;
}

function fullName(user: Pick<User, 'first_name' | 'last_name'>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'Unknown';
}

export function senderOf(msg: Message): Sender {
  const chat = msg.sender_chat;
  if (chat) {
    if (chat.id === msg.chat.id) {
      const signature = msg.author_signature ? ` "${msg.author_signature}"` : '';
      return { id: chat.id, name: `Anonymous admin${signature}` };
    }
    const title = 'title' in chat && chat.title ? chat.title : 'Channel';
    return { id: chat.id, name: title, username: 'username' in chat ? chat.username : undefined };
  }
  if (msg.from) {
    return { id: msg.from.id, name: fullName(msg.from), username: msg.from.username };
  }
  return { id: 0, name: 'Unknown' };
}

export function senderLabel(sender: Sender): string {
  return sender.username ? `${sender.name} (@${sender.username})` : sender.name;
}

function duration(seconds: number | undefined): string {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return ` ${m}:${s}`;
}

function snippet(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** URLs hidden behind link text are not part of the visible text, so list them explicitly. */
function hiddenLinks(entities: MessageEntity[] | undefined): string {
  const urls = (entities ?? [])
    .filter((e): e is MessageEntity.TextLinkMessageEntity => e.type === 'text_link')
    .map((e) => e.url);
  return urls.length ? ` (links: ${[...new Set(urls)].join(', ')})` : '';
}

function forwardedFrom(msg: Message): string {
  const origin = msg.forward_origin;
  if (!origin) return '';
  switch (origin.type) {
    case 'user':
      return `[forwarded from ${fullName(origin.sender_user)}] `;
    case 'hidden_user':
      return `[forwarded from ${origin.sender_user_name}] `;
    case 'chat':
      return `[forwarded from ${'title' in origin.sender_chat ? origin.sender_chat.title : 'a chat'}] `;
    case 'channel':
      return `[forwarded from channel ${'title' in origin.chat ? origin.chat.title : ''}] `.replace('  ', ' ');
    default:
      return '[forwarded] ';
  }
}

function mediaTag(msg: Message): string {
  if (msg.photo) return '[photo]';
  if (msg.animation) return '[GIF]';
  if (msg.video) return `[video${duration(msg.video.duration)}]`;
  if (msg.video_note) return `[video note${duration(msg.video_note.duration)}]`;
  if (msg.voice) return `[voice message${duration(msg.voice.duration)}]`;
  if (msg.audio) {
    const title = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' - ') || msg.audio.file_name || '';
    return `[audio${title ? `: ${title}` : ''}${duration(msg.audio.duration)}]`;
  }
  if (msg.document) return `[file: ${msg.document.file_name ?? 'unnamed'}]`;
  if (msg.sticker) return `[sticker${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''}]`;
  if (msg.poll) {
    const options = msg.poll.options.map((o) => o.text).join(' | ');
    return `[poll: "${msg.poll.question}" options: ${options}]`;
  }
  if (msg.venue) return `[venue: ${msg.venue.title}, ${msg.venue.address}]`;
  if (msg.location) return `[location: ${msg.location.latitude}, ${msg.location.longitude}]`;
  if (msg.contact) {
    return `[contact: ${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ')}]`;
  }
  if (msg.dice) return `[dice ${msg.dice.emoji} ${msg.dice.value}]`;
  return '';
}

/** What the message says: forwarded-from prefix, media tag, then text or caption. */
export function describeContent(msg: Message): string {
  const text = msg.text ?? msg.caption ?? '';
  const links = hiddenLinks(msg.entities ?? msg.caption_entities);
  const media = mediaTag(msg);
  const body = [media, text].filter(Boolean).join(' ') + links;
  return forwardedFrom(msg) + (body || '[unsupported message type]');
}

/** Group events (joins, pins, topic changes…) as a sentence, or null for an ordinary message. */
export function describeServiceEvent(msg: Message): string | null {
  const actor = senderOf(msg).name;

  if (msg.new_chat_members?.length) {
    const names = msg.new_chat_members.map(fullName).join(', ');
    const selfJoin = msg.new_chat_members.length === 1 && msg.new_chat_members[0].id === msg.from?.id;
    return selfJoin ? `${names} joined the group` : `${actor} added ${names} to the group`;
  }
  if (msg.left_chat_member) {
    const name = fullName(msg.left_chat_member);
    return msg.left_chat_member.id === msg.from?.id ? `${name} left the group` : `${actor} removed ${name} from the group`;
  }
  if (msg.new_chat_title) return `${actor} renamed the group to "${msg.new_chat_title}"`;
  if (msg.new_chat_photo) return `${actor} changed the group photo`;
  if (msg.delete_chat_photo) return `${actor} removed the group photo`;
  if (msg.pinned_message) {
    const pinned = msg.pinned_message;
    const preview = 'text' in pinned && pinned.text ? `: "${snippet(pinned.text)}"` : '';
    return `${actor} pinned msg ${pinned.message_id}${preview}`;
  }
  if (msg.forum_topic_created) return `${actor} created the topic "${msg.forum_topic_created.name}"`;
  if (msg.forum_topic_edited) {
    return msg.forum_topic_edited.name
      ? `${actor} renamed this topic to "${msg.forum_topic_edited.name}"`
      : `${actor} changed this topic's icon`;
  }
  if (msg.forum_topic_closed) return `${actor} closed this topic`;
  if (msg.forum_topic_reopened) return `${actor} reopened this topic`;
  if (msg.general_forum_topic_hidden) return `${actor} hid the General topic`;
  if (msg.general_forum_topic_unhidden) return `${actor} unhid the General topic`;
  if (msg.video_chat_started) return `${actor} started a video chat`;
  if (msg.video_chat_ended) return `Video chat ended after${duration(msg.video_chat_ended.duration)}`;
  if (msg.message_auto_delete_timer_changed) {
    const seconds = msg.message_auto_delete_timer_changed.message_auto_delete_time;
    return seconds ? `${actor} set messages to auto-delete after ${seconds}s` : `${actor} turned off auto-delete`;
  }
  if (msg.migrate_to_chat_id || msg.migrate_from_chat_id) return 'The group was upgraded to a supergroup';
  if (msg.group_chat_created || msg.supergroup_chat_created) return `${actor} created the group`;

  return null;
}

/**
 * Whether reply_to_message is a real reply. Inside a forum topic, Telegram sets
 * it to the topic's creation message on every message that is not a reply.
 */
function realReply(msg: Message): Message['reply_to_message'] | undefined {
  const reply = msg.reply_to_message;
  if (!reply) return undefined;
  if (reply.forum_topic_created) return undefined;
  return reply;
}

export interface FormatOptions {
  edited?: boolean;
}

/** The transcript body for one message (the timestamp and topic tag are added by the store). */
export function formatMessageBody(msg: Message, options: FormatOptions = {}): string {
  const event = describeServiceEvent(msg);
  if (event) return `* ${event}`;

  const meta = [`msg ${msg.message_id}`];
  const reply = realReply(msg);
  if (reply) {
    meta.push(`reply to msg ${reply.message_id} by ${senderOf(reply as Message).name}`);
  } else if (msg.external_reply) {
    meta.push('reply to a message from another chat');
  }
  if (options.edited) meta.push('EDITED');

  const quote = msg.quote?.text ? `(quoting "${snippet(msg.quote.text, 120)}") ` : '';

  return `${senderLabel(senderOf(msg))} [${meta.join(', ')}]: ${quote}${describeContent(msg)}`;
}

/** The topic-creation message every forum message points at, used to learn topic names lazily. */
export function topicNameFromReply(msg: Message): string | undefined {
  return msg.reply_to_message?.forum_topic_created?.name;
}
