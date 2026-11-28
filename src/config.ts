import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '..', '.env');
const envPath = process.env.CLAUDEGRAM_ENV_PATH || defaultEnvPath;
loadEnv({ path: envPath });

const toBool = (val: string) => val.toLowerCase() === 'true';

const toIdList = (val: string) =>
  val
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => Number.isFinite(id));

const toInt = (val: string) => parseInt(val, 10);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  // Optional: owners can also be registered at runtime with /claim <code> in a private chat.
  ALLOWED_USER_IDS: z.string().default('').transform(toIdList),
  // Optional: groups can also be enabled at runtime by an owner sending /enable in the group.
  ALLOWED_GROUP_IDS: z.string().default('').transform(toIdList),
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude subscription login if not set
  // Long-lived subscription token from `claude setup-token` (read by the Claude Code subprocess)
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  // Default Claude model for private chats and for the group secretary
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),

  // If the token is connected to another service's webhook, disconnect it and poll here instead
  TELEGRAM_TAKE_OVER_WEBHOOK: z.string().default('false').transform(toBool),

  // ── Group secretary ────────────────────────────────────────────
  // Where transcripts, notes and bot state live
  DATA_DIR: z.string().default(path.resolve(__dirname, '..', 'data')),
  // One-time code for `/claim <code>`; generated and logged on first start if unset
  OWNER_CLAIM_CODE: z.string().optional(),
  // Model for group answers (empty = CLAUDE_MODEL)
  SECRETARY_MODEL: z.string().default(''),
  SECRETARY_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  // Extra house rules for the secretary's replies (tone, words to avoid, language), in plain words
  SECRETARY_INSTRUCTIONS: z.string().default(''),
  // Timezone used for transcript timestamps and daily file boundaries
  SECRETARY_TIMEZONE: z.string().default('Asia/Singapore'),
  // Let the secretary search the web for questions that are not about the group
  SECRETARY_WEB_SEARCH: z.string().default('true').transform(toBool),
  SECRETARY_MAX_TURNS: z.string().default('80').transform(toInt),
  SECRETARY_TIMEOUT_MS: z.string().default('1200000').transform(toInt),
  // How much recent transcript is placed directly in each prompt (older history is searched on demand)
  SECRETARY_CONTEXT_CHARS: z.string().default('40000').transform(toInt),
  SECRETARY_MAX_CONCURRENT: z.string().default('4').transform(toInt),
  // Attach the photo when someone asks about an image (caption mention or reply to a photo)
  SECRETARY_VISION: z.string().default('true').transform(toBool),
  // Unix socket of the sandbox runner. When set, the secretary can run commands and
  // save files inside the sandbox container. Empty = those tools are not offered.
  SANDBOX_SOCKET: z.string().default(''),
  // Reminders and recurring tasks the secretary can set for a group
  SECRETARY_SCHEDULES: z.string().default('true').transform(toBool),
  // A recurring schedule may not fire more often than this (minutes)
  SECRETARY_MIN_REPEAT_MINUTES: z.string().default('15').transform(toInt),
  SECRETARY_MAX_SCHEDULES_PER_GROUP: z.string().default('100').transform(toInt),
  // Scheduled scripts use no Claude, so they may repeat more often (minutes)
  SECRETARY_MIN_SCRIPT_REPEAT_MINUTES: z.string().default('5').transform(toInt),
  // Hooks: scripts in the sandbox that react to every message
  SECRETARY_HOOKS: z.string().default('true').transform(toBool),
  // How many times per hour hooks may hand a message to the secretary (the only hook action that uses Claude)
  SECRETARY_HOOK_ASKS_PER_HOUR: z.string().default('30').transform(toInt),
  // Daily digests of each group's chat, written by a small model, for long-term recall
  SECRETARY_DIGESTS: z.string().default('true').transform(toBool),
  SECRETARY_DIGEST_MODEL: z.string().default('claude-haiku-5-5'),
  // Weekly backup of all records, sent to the owners' private chats
  SECRETARY_BACKUPS: z.string().default('true').transform(toBool),
  // MCP servers every group gets, as "name=command; other=command". The commands are tools
  // installed in the sandbox image, e.g. "ntubus=ntubus mcp" for NTU campus buses.
  SECRETARY_BUILTIN_MCP: z.string().default(''),
  // The bot's own repository, so the secretary can propose changes to itself as pull requests
  BOT_REPO_URL: z.string().default(''),
  // Let the owner deploy a commit from the chat with /deploy (needs deploy/install-deployer.sh on the host)
  DEPLOY_FROM_CHAT: z.string().default('false').transform(toBool),
  // How the sandbox runs group commands: "local" (shared container, unprivileged users) or
  // "workbench" (each group gets its own gVisor machine with root). Set on both containers.
  SANDBOX_BACKEND: z.enum(['local', 'workbench']).default('local'),
  // GitHub token made available inside the sandbox (also set on the sandbox container)
  SANDBOX_GITHUB_TOKEN: z.string().optional(),
  WORKSPACE_DIR: z.string().default(process.env.HOME || '.'),
  CLAUDE_EXECUTABLE_PATH: z.string().default('claude'),
  CLAUDE_USE_BUNDLED_EXECUTABLE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_SDK_LOG_LEVEL: z.enum(['off', 'basic', 'verbose', 'trace']).default('basic'),
  CLAUDE_SDK_INCLUDE_PARTIAL: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_REASONING_SUMMARY: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  BOT_NAME: z.string().default('Claudegram'),
  BOT_MODE: z.enum(['dev', 'prod']).default('dev'),
  STREAMING_MODE: z.enum(['streaming', 'wait']).default('streaming'),
  STREAMING_DEBOUNCE_MS: z
    .string()
    .default('500')
    .transform((val) => parseInt(val, 10)),
  MAX_MESSAGE_LENGTH: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  IMAGE_MAX_FILE_SIZE_MB: z
    .string()
    .default('20')
    .transform((val) => parseInt(val, 10)),
  // New config options
  DANGEROUS_MODE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  MAX_LOOP_ITERATIONS: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_JSON_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  // Reddit API credentials (native TypeScript module)
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USERNAME: z.string().optional(),
  REDDIT_PASSWORD: z.string().optional(),
  // Reddit fetch configuration
  REDDIT_ENABLED: z.string().default('true').transform(toBool),
  // DEPRECATED: REDDITFETCH_PATH — replaced by native TypeScript module; kept for reference only
  REDDITFETCH_PATH: z.string().default(''),
  REDDITFETCH_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_LIMIT: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_DEPTH: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  // Reddit video download
  VREDDIT_ENABLED: z.string().default('true').transform(toBool),
  REDDIT_VIDEO_MAX_SIZE_MB: z
    .string()
    .default('50')
    .transform((val) => parseInt(val, 10)),
  // Telegraph (Instant View for long messages)
  TELEGRAPH_ENABLED: z.string().default('true').transform(toBool),
  // Medium / Freedium configuration
  MEDIUM_ENABLED: z.string().default('true').transform(toBool),
  MEDIUM_TIMEOUT_MS: z
    .string()
    .default('15000')
    .transform((val) => parseInt(val, 10)),
  MEDIUM_FILE_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  FREEDIUM_HOST: z.string().default('freedium-mirror.cfd'),
  FREEDIUM_RATE_LIMIT_MS: z
    .string()
    .default('2000')
    .transform((val) => parseInt(val, 10)),
  // Context visibility
  CONTEXT_SHOW_USAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CONTEXT_NOTIFY_COMPACTION: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Terminal UI mode
  TERMINAL_UI_DEFAULT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  ALLOW_PRIVATE_NETWORK_URLS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Logging: show SDK hook JSON dumps (PreToolUse, PostToolUse, stderr, etc.)
  // When false (default), verbose mode shows clean operational logs without hook noise.
  // When true, verbose mode includes full hook JSON payloads and stderr output.
  LOG_AGENT_HOOKS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Cancel behaviour: auto-cancel running query when user sends a new message
  CANCEL_ON_NEW_MESSAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Agent watchdog: detect stuck/unresponsive agent queries
  AGENT_WATCHDOG_ENABLED: z.string().default('true').transform(toBool),
  AGENT_WATCHDOG_WARN_SECONDS: z
    .string()
    .default('30')
    .transform((val) => parseInt(val, 10)),
  AGENT_WATCHDOG_LOG_SECONDS: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  AGENT_QUERY_TIMEOUT_MS: z
    .string()
    .default('0')
    .transform((val) => parseInt(val, 10)), // 0 = disabled
  // HTTP proxy for Telegram API requests (e.g. socks5://127.0.0.1:1080 or http://proxy:8080)
  TELEGRAM_PROXY_URL: z.string().optional(),
  // Completion notification (send a new message after long streaming tasks)
  NOTIFICATION_ENABLED: z.string().default('true').transform(toBool),
  NOTIFICATION_THRESHOLD_SECONDS: z
    .string()
    .default('60')
    .transform((val) => parseInt(val, 10)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.message);
  process.exit(1);
}

export const config = parsed.data;

export type Config = typeof config;
