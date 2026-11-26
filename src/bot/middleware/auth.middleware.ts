import { Context, NextFunction } from 'grammy';
import { isOwner } from '../../secretary/state.js';

/**
 * Log authentication attempt for security auditing.
 * Avoids logging message content to protect privacy.
 */
function logAuthAttempt(
  success: boolean,
  userId: number | undefined,
  username: string | undefined,
  chatType: string | undefined
): void {
  const timestamp = new Date().toISOString();
  const userInfo = userId ? `user:${userId}` : 'user:unknown';
  const usernameInfo = username ? `@${username}` : '';
  const status = success ? 'ALLOWED' : 'DENIED';
  console.log(`[auth] ${timestamp} ${status} ${userInfo} ${usernameInfo} chat:${chatType || 'unknown'}`);
}

// Strangers get one "not authorized" reply per hour, not one per message.
const DENIAL_NOTICE_INTERVAL_MS = 60 * 60 * 1000;
const lastDenialNotice = new Map<number, number>();

/**
 * Gate for the private-chat assistant (full Claude Code access): owners only.
 * Group traffic never gets here; the secretary middleware handles it earlier.
 */
export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const chatType = ctx.chat?.type;

  if (chatType !== 'private') {
    return;
  }

  if (!userId || !isOwner(userId)) {
    logAuthAttempt(false, userId, username, chatType);
    if (userId) {
      const now = Date.now();
      if (now - (lastDenialNotice.get(userId) ?? 0) > DENIAL_NOTICE_INTERVAL_MS) {
        if (lastDenialNotice.size > 5000) lastDenialNotice.clear();
        lastDenialNotice.set(userId, now);
        await ctx.reply('⛔ This is a private bot. In a group where I work as secretary, mention me there instead.');
      }
    }
    return;
  }

  logAuthAttempt(true, userId, username, chatType);
  await next();
}
