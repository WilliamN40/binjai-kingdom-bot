import * as fs from 'fs';
import { run } from '@grammyjs/runner';
import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';
import { getOwnerIds, getPendingClaimCode, listGroups } from './secretary/state.js';
import { flushMembers } from './secretary/transcript.js';
import { answersInFlight, createScheduleDeliverer, resumePendingAnswers } from './secretary/group.js';
import { startScheduler, stopScheduler } from './secretary/schedule.js';
import { sandboxEnabled } from './secretary/sandbox.js';
import { startDigests, stopDigests } from './secretary/digest.js';
import { startBackups, stopBackups } from './secretary/backup.js';

// Telegram remembers the update types of whoever configured the bot last, so
// ask for ours explicitly. edited_message is needed to record edits, and
// my_chat_member tells us when the bot is added to or removed from a group.
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'] as const;

// How long a shutdown waits for answers in progress. Keep it under stop_grace_period in docker-compose.yml.
const SHUTDOWN_WAIT_MS = 150_000;

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);
  console.log(`🧠 Model: ${config.CLAUDE_MODEL} (secretary: ${config.SECRETARY_MODEL || config.CLAUDE_MODEL}, effort ${config.SECRETARY_EFFORT})`);
  console.log(`🗂️ Data directory: ${config.DATA_DIR}`);

  if (!config.ANTHROPIC_API_KEY && !config.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn('⚠️ No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set: relying on a Claude Code login on this machine.');
  }

  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.mkdirSync(config.WORKSPACE_DIR, { recursive: true });

  // Prevent system sleep on macOS
  preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot started as @${bot.botInfo.username}`);

  // Long polling cannot run while a webhook is registered. A webhook means some
  // other service is currently driving this bot, so taking over is opt-in.
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url) {
    const host = new URL(webhook.url).host;
    if (!config.TELEGRAM_TAKE_OVER_WEBHOOK) {
      console.error(`❌ This bot token is connected to a webhook at ${host}.`);
      console.error('   Another service is receiving its messages. Set TELEGRAM_TAKE_OVER_WEBHOOK=true to disconnect it and run here.');
      process.exit(1);
    }
    console.warn(`⚠️ Removing webhook at ${host} (TELEGRAM_TAKE_OVER_WEBHOOK=true)`);
    await bot.api.deleteWebhook();
  }

  const owners = getOwnerIds();
  const claimCode = getPendingClaimCode();
  if (claimCode) {
    console.log('🔑 No owner yet. In a private chat with the bot, send:');
    console.log(`   /claim ${claimCode}`);
  } else {
    console.log(`👤 Owners: ${owners.join(', ')}`);
  }

  const groups = listGroups().filter((g) => g.enabled);
  console.log(`📒 Recording ${groups.length} group(s)${groups.length ? `: ${groups.map((g) => g.title).join(', ')}` : ''}`);
  if (!bot.botInfo.can_read_all_group_messages) {
    console.warn('⚠️ Privacy mode is ON: in groups where the bot is not an admin it only sees commands, mentions and replies.');
    console.warn('   Make the bot a group admin, or disable privacy mode in @BotFather (/setprivacy) and re-add it.');
  }

  console.log(`🧰 Sandbox workspace: ${sandboxEnabled() ? `on (${config.SANDBOX_SOCKET})` : 'off'}`);

  // Reminders and recurring tasks. Anything that came due while the bot was down fires now.
  startScheduler(createScheduleDeliverer(bot.api, bot.botInfo));

  // Daily digests for long-term recall, and a weekly backup of the records to the owners.
  startDigests();
  startBackups(bot.api);

  // Questions that a restart or crash cut off are answered now.
  const resumed = resumePendingAnswers(bot.api, bot.botInfo);
  if (resumed) console.log(`↩️ Resuming ${resumed} question(s) that were interrupted`);

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  const runner = run(bot, { runner: { fetch: { allowed_updates: ALLOWED_UPDATES } } });

  // Graceful shutdown (guarded against duplicate signals)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n👋 Shutting down...');
    allowSleep();
    stopCleanup();
    stopScheduler();
    stopDigests();
    stopBackups();
    // Stop taking new messages (Telegram keeps them for the next start), then let the
    // answers already in progress finish. Whatever is still running at the deadline
    // stays saved on disk and is resumed on the next start.
    await runner.stop();
    if (answersInFlight() > 0) console.log(`⏳ Waiting for ${answersInFlight()} answer(s) to finish...`);
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (answersInFlight() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    flushMembers();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
