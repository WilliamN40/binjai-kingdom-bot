/**
 * Decides whether a group message is addressed to the secretary.
 * Everything in an enabled group is recorded; only these get an answer:
 *   - a command (/ask, /summary, …), optionally suffixed with @thisbot
 *   - a message that @mentions the bot
 *   - a reply to one of the bot's own messages
 */

import type { Message, MessageEntity } from 'grammy/types';

export interface BotIdentity {
  id: number;
  username: string;
}

export type Trigger =
  | { kind: 'command'; command: string; args: string }
  | { kind: 'ask'; question: string; via: 'mention' | 'reply' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectTrigger(msg: Message, bot: BotIdentity): Trigger | null {
  const text = msg.text ?? msg.caption ?? '';
  const entities: MessageEntity[] = msg.entities ?? msg.caption_entities ?? [];
  const mentionTag = `@${bot.username}`.toLowerCase();

  // A command only counts when it is the very first thing in the message.
  const commandEntity = entities.find((e) => e.type === 'bot_command' && e.offset === 0);
  if (commandEntity) {
    const raw = text.slice(0, commandEntity.length);
    const [name, target] = raw.slice(1).split('@');
    if (target && `@${target}`.toLowerCase() !== mentionTag) return null; // meant for another bot
    return { kind: 'command', command: name.toLowerCase(), args: text.slice(commandEntity.length).trim() };
  }

  const mentioned = entities.some(
    (e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === mentionTag,
  );
  if (mentioned) {
    const question = text
      .replace(new RegExp(escapeRegExp(`@${bot.username}`), 'gi'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { kind: 'ask', question, via: 'mention' };
  }

  const reply = msg.reply_to_message;
  if (reply && !reply.forum_topic_created && reply.from?.id === bot.id) {
    return { kind: 'ask', question: text.trim(), via: 'reply' };
  }

  return null;
}
