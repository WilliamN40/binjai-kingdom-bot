<div align="center">

# Claudegram

**Your personal AI agent, running on your machine, controlled from Telegram.**

[![Website](https://img.shields.io/badge/Website-claudegram.com-00ffd5?logo=googlechrome&logoColor=white)](https://claudegram.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  Claude Agent SDK  ──▶  Your Machine
  text           command router     agentic runtime       bash, files, code
```

</div>

---

## What is this?

Claudegram bridges Telegram to a **full Claude Code agent** running locally on your machine. Send a message in Telegram — Claude reads your files, runs commands, writes code, browses Reddit, and fetches Medium articles. All from your phone.

This is not a simple API wrapper. It's the real Claude Code agent with tool access — Bash, file I/O, code editing, web browsing — packaged behind a Telegram interface with streaming responses, session memory, and rich output formatting.

---

> **Binjai Kingdom Bot** is a fork of [NachoSEO/claudegram](https://github.com/NachoSEO/claudegram). It adds the group secretary described below, a sandbox for running scripts, reminders, and a Docker deployment, updates everything to current Claude models and libraries, and removes the features that needed other paid services (text-to-speech, voice transcription, media extraction, OpenCode).

## Group secretary

This fork adds a second mode on top of the private-chat coding agent: in a Telegram group the bot acts as a **secretary**. It keeps a written record of everything said in the group and answers questions about it.

**What it does in a group**

- Records every message (text, captions, replies, edits, joins, pins, polls, forwarded messages, media as tags) to plain text, one file per day **per group**. In forum groups every line is tagged with its topic, and all topics share one record, so a question asked in one topic can be answered from what was said in another.
- Answers when it is **@mentioned**, when someone **replies to it**, or via **`/ask`**. Everything else is recorded silently. Anyone in the group can ask; there are no rate limits.
- `/summary [period or focus]` for a recap, `/catchup` for "what happened since I last wrote here".
- Remembers things on request ("remember that the AGM moved to 20 Dec") in the group's notes, and edits or removes a note when it is outdated (people change their own notes; the owner or a manager any).
- **Background jobs**: work that takes longer than an answer (a booking flow, a big scrape, research across many sites) runs in the background for up to an hour and posts its result as a reply when done; `/stop` cancels it.
- **Polls it posts record every vote** (who voted for what) and the final result, so it can tell you later. Telegram only reports votes on the bot's own, non-anonymous polls.
- **Reminders, recurring tasks and scheduled scripts**: "remind us Friday 6pm to bring the banner", "post a recap every Monday at 9am", or a script from the workspace run on a timer with no Claude involved. Repeats can be by cron or every N seconds (e.g. a ping every 30 s "until 19:30"); the shortest gaps are group settings the owner or a manager can change (defaults: 10 s for reminders and scripts, 15 min for Claude tasks). A task can carry its own effort level. `/reminders` lists them.
- **Hooks**: scripts in the workspace that the bot runs on every message and that can reply, react, pin, delete, save a note or hand the message to the secretary. Ask for one in plain words ("make a hook that deletes messages containing X"); `/hooks` lists them and `/hooks off <name>` switches one off.
- **GitHub**: `git` and `gh` are in the workspace, with an optional token for the group's repositories. With `BOT_REPO_URL` set, the secretary can propose changes to its own code as pull requests.
- **Long-term memory**: a small model writes a digest of each finished day (decisions, to-dos, links, keywords), which the secretary searches before the raw transcript.
- **Housekeeping**: `/usage [days]` shows who used how much Claude; the owners get a weekly backup of all records in their private chat (`/backup` for one now) and a message if answers start failing.
- **A sandboxed workspace**: it can run scripts, install tools, build spreadsheets and charts, convert files, and send the result into the chat. Reply to a file (PDF, Word, Excel, video, audio) and mention it to have the file processed.
- Looks at photos it is asked about, and at photos posted earlier in the group (by message number); posts pictures as real photos. Can search the web and drive a headless Chromium.
- `/welcome <text>` (admins) greets new members; `/stop` cancels an answer in progress.

**Changing it from the chat** (no code change, no redeploy)

The point of this fork is that a group can reshape its secretary by talking to it:

- **Settings**: the owner, or a member the owner made a manager (`/manager add @user`), just asks: "send all answers to #bot", "answer everyone in English", "use sonnet", "think harder". `/settings` shows them all; `/answerhere`, `/model` and `/effort` are shortcuts. Group-wide house rules are applied to every answer.
- **Keys**: `/secret NAME value` (best in a private chat with the bot) stores an API key for the group. The message is deleted and never recorded; the key becomes an environment variable for the group's commands, hooks, scripts and MCP servers. Anyone who can ask the secretary to run commands can use it, so only add keys the whole group may use.
- **NTU campus buses, built in**: `ntubus` ships in the sandbox image and reads NTU's own bus app live (nothing about the network is hard-coded, so temporary routes just appear). With `SECRETARY_BUILTIN_MCP="ntubus=ntubus mcp"` every group can ask "when's the next Red at Hall 1?", "how do I get from Hall 2 to NIE?", "how full are the Blue buses?" or "tell me when the bus is 3 minutes from my stop" (a scheduled script that checks every 20 seconds and posts once, with no Claude involved). The same tool is a command for hooks and scripts: `ntubus arrivals <stop>`, `ntubus plan <from> <to>`, `ntubus live [route]`, `ntubus routes`, `ntubus news`, `ntubus alert …`, each with `--json`. Any other tool installed in the image can be made a built-in server the same way.
- **New tools**: the secretary can connect MCP servers itself (any stdio server: an npm or pip package, a script, or `mcp-remote` for one on the web). They run inside the group's sandbox, never in the bot's container, and their tools are available from the next question.
- **Its own machine** (`SANDBOX_BACKEND=workbench`): each group gets a Linux machine under gVisor where the secretary is root, can `apt-get install` anything and keep services running between questions. `/machine` shows it, `/machine reset` rebuilds it from a clean image (workspace files stay; `~/.setup.sh` re-runs).
- **Its own code**: with a GitHub token (`/secret GH_TOKEN …`) it opens pull requests on `BOT_REPO_URL`. With the host deployer installed (`deploy/install-deployer.sh`, `DEPLOY_FROM_CHAT=true`), the owner sends `/deploy [branch]`, reads the commit and file list (changes to containers, the sandbox or the deploy setup are flagged), and confirms with `/deploy confirm <sha>`. The server checks out exactly that commit, rebuilds, rolls back if the bot does not come up, and the result is posted back in the chat. `/version` shows what is running.
- **Every Telegram feature**: the secretary can call any Bot API method in its group (polls, quizzes, inline buttons, dice, stickers, albums, reactions, editing its messages, pins, topics; moderation and group settings for the owner or managers; bot-wide methods for the owner). `chat_id` is always forced to the group, and `"workspace:<path>"` uploads a file from the workspace. Button presses, reactions and poll votes reach the hooks as events.
- **Files from the record**: it can look at earlier photos and pull any earlier file (PDF, spreadsheet, voice note, video) into its workspace by message number (up to Telegram's 20 MB bot limit).
- **Automation**: hooks can reply, react, pin, delete (also an earlier message by id), post photos, save notes, call everyday Bot API methods (`{"do":"api",...}`) or hand a message to the secretary; scheduled scripts can print the same actions instead of text.

Rights are checked by Telegram user id in the code, never from what a message claims: settings, secrets, MCP servers and deploys need the owner (or a manager, except managers and deploys). Hooks and scheduled tasks never carry anyone's rights.

**Setting it up**

1. Start the bot (see *Deployment* below). On first start the log prints a one-time code: send `/claim <code>` to the bot in a private chat to become its owner.
2. Add the bot to your group and **make it an admin** (or disable privacy mode in @BotFather with `/setprivacy` before adding it). Otherwise Telegram only shows it commands and mentions, and the record will have gaps.
3. Send `/enable` in the group. The bot announces that it is now recording. `/disable` pauses it; `/forget confirm` erases everything it holds for that group.

**How it is confined**

Anyone in the group can talk to the secretary, so it is built to be safe to expose:

- The Claude process answering a group gets read-only access to **that group's record folder only**, checked on every tool call. It has no shell and no file-writing tools of its own, and it is not given the Telegram token.
- Commands and file writes happen in a **separate sandbox container**: no secrets in it (only the group's own `/secret` keys), read-only system files, capped CPU, memory, process count and disk (8 GB per group by default, `SANDBOX_QUOTA_MB`), and **one Linux user per group** so groups cannot see each other's files.
- With `SANDBOX_BACKEND=workbench` each group instead gets its own container under **gVisor** (a user-space kernel between the machine and the host), so being root inside it does not reach the server. The runner then manages these containers through the Docker socket, which makes the runner itself root-equivalent: only the bot can reach it, and it never runs group commands itself. The host firewall for the machines' network is `deploy/workbench-firewall.sh`.
- The sandbox can reach the public internet, but a firewall inside it rejects every private address, so it cannot reach the host, other containers, the local network or the cloud metadata service. Outbound mail ports are blocked. Every command it runs is written to the bot's log.
- Reminders are delivered by the bot itself. In the shared sandbox nothing keeps running between commands; on a workbench machine background services may.

What that leaves: a script in the sandbox can send a group's **own** record and files out to the internet, and what it does online comes from your server's address. For a sandbox with no network at all, see the comment in `docker-compose.yml`.

**Where things live** (`DATA_DIR`, `./data` in the Docker setup)

```
data/
├── state.json                     owners, enabled groups and their settings
├── secrets.json                   /secret keys per group (0600, not visible to the sandbox)
├── deploy/                        /deploy requests and results, current.json
├── groups/group_<id>/
│   ├── transcript/2026-11-26.txt  [2026-11-26 21:33] [#Topic] Alice (@alice) [msg 4521]: …
│   ├── notes.md                   things it was asked to remember
│   ├── digests/2026-11-26.md      one short summary per finished day
│   ├── schedules.json             reminders, recurring tasks, scheduled scripts
│   ├── hooks.json                 which hook scripts are registered and on
│   ├── mcp.json                   the group's MCP servers
│   ├── media.jsonl                file ids of pictures, by message number
│   ├── usage.jsonl                one line per Claude run
│   ├── members.json               who has spoken, message counts
│   └── topics.json                forum topic names
└── sandbox/group_<id>/            the group's workspace files
```

**Good to know**

- The record starts when the bot is enabled. Telegram gives bots no access to earlier history, and does not tell bots when a message is deleted.
- Topic names are learned from Telegram's service messages. A topic renamed before the bot arrived shows its original name until it is renamed again.
- Telegram keeps undelivered messages for about 24 hours, so short downtime leaves no gap. Bots never see messages from other bots.
- Bots can download files up to 20 MB and send files up to about 50 MB.
- Long answers are sent as normal messages; Telegraph publishing is off in the Docker setup because those pages are public.

### Deployment (Docker)

```bash
cp .env.example .env      # set TELEGRAM_BOT_TOKEN and Claude credentials
mkdir -p data/groups data/workspace data/sandbox
sudo chown 1000:1000 data data/groups data/workspace   # the bot runs as uid 1000
sudo chown root:root data/sandbox && sudo chmod 711 data/sandbox
sudo docker compose up -d --build
sudo docker compose logs -f bot                        # shows the /claim code on first start
```

Past history: export the chat from Telegram Desktop as JSON, copy `result.json` into `data/`, and run `sudo docker exec binjaibot node dist/import-cli.js /data/result.json --chat-id <id>` (add `--dry-run` first to see what it would do).

Deploy from the chat (once, on the host): `sudo bash deploy/install-deployer.sh`, then `docker compose up -d --build`. Own machines per group: install gVisor (`runsc`) and register it in `/etc/docker/daemon.json` (`systemctl reload docker` is enough), run `sudo bash deploy/workbench-firewall.sh` (and enable `deploy/binjaibot-workbench-firewall.service`), set `SANDBOX_BACKEND=workbench`, `HOST_DATA_DIR=<absolute path of ./data>` and `SANDBOX_DOCKER_SOCKET=/var/run/docker.sock` in `.env`, then `docker compose --profile image build workbench-image && docker compose up -d --build`.

Tests: `npm test` (unit), `npx tsx scripts/smoke-secretary.ts` (live, asks Claude real questions against a throwaway group). Inside the running container: `scripts/sandbox-check.mjs`, `scripts/e2e-check.mjs`, `scripts/resume-check.mjs` and `scripts/hooks-check.mjs` (usage in each file's header).

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Agent Core
- Full Claude Code with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Session resume across messages — Claude remembers everything
- Project-based working directories
- Streaming responses with live-updating messages
- Model picker: Sonnet · Opus · Haiku
- Plan mode, explore mode, loop mode

### Reddit Integration
- `/reddit` — posts, subreddits, user profiles
- `/vreddit` — download & send Reddit-hosted videos
- Auto-compression for videos > 50 MB (CRF → two-pass)
- Original oversized videos archived locally
- Large threads auto-export to JSON

### Medium Integration
- `/medium` — fetch paywalled articles via Freedium
- Telegraph Instant View, save as Markdown, or both
- Pure TypeScript, no Python/Playwright needed

</td>
<td width="50%" valign="top">

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses & tables
- Smart chunking that preserves code blocks
- ForceReply interactive prompts for multi-step commands
- `/teleport` — fork session to terminal for continued work
- Inline keyboards for settings (model, mode, clear)

### Terminal UI
- Terminal-style display with tool status spinners
- Shows what Claude is doing in real time
- Toggle with `/terminalui`

### MCP Tools (Intelligent Routing)
- Talk naturally — Claude auto-uses the right tools
- Reddit, Medium, project management via MCP
- No explicit commands needed for common tasks

### Forum Topic Sessions
- Each forum topic runs as an independent session
- Work on multiple projects in parallel across topics

### Image Uploads
- Send photos or image docs in chat
- Saved to project under `.claudegram/uploads/`
- Claude is notified with path + caption

</td>
</tr>
</table>

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | with npm |
| **Claude Code CLI** | installed and authenticated — `claude` in your PATH |
| **Telegram bot token** | from [@BotFather](https://t.me/botfather) |
| **Your Telegram user ID** | from [@userinfobot](https://t.me/userinfobot) |

### Setup

```bash
git clone https://github.com/NachoSEO/claudegram.git
cd claudegram
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

### Run

```bash
npm install
npm run dev        # dev mode with hot reload
```

Open your bot in Telegram → `/start`

---

## Commands

### Session
| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/project` | Set working directory (interactive picker) |
| `/newproject <name>` | Create and switch to a new project |
| `/clear` | Clear conversation + session |
| `/status` | Current session info |
| `/sessions` | List saved sessions |
| `/resume` | Pick from recent sessions |
| `/continue` | Resume most recent session |
| `/teleport` | Move session to terminal (forked) |

### Agent Modes
| Command | Description |
|---------|-------------|
| `/plan` | Plan mode for complex tasks |
| `/explore` | Explore codebase to answer questions |
| `/loop` | Run iteratively until task complete |
| `/model` | Switch Sonnet / Opus / Haiku |
| `/mode` | Toggle streaming / wait |
| `/terminalui` | Toggle terminal-style display |

### Content
| Command | Description |
|---------|-------------|
| `/reddit` | Fetch Reddit posts, subreddits, profiles |
| `/vreddit` | Download Reddit-hosted videos |
| `/medium` | Fetch Medium articles via Freedium |
| `/file` | Download a project file |
| `/telegraph` | Toggle Instant View for long responses |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Health check |
| `/context` | Show Claude context / token usage |
| `/botstatus` | Bot process status |
| `/restartbot` | Restart the bot |
| `/cancel` | Cancel current request |
| `/commands` | Show all commands |
| `/softreset` | Soft reset (cancel + clear session) |

---

## Optional Integrations

<details>
<summary><strong>Reddit — <code>/reddit</code> & <code>/vreddit</code></strong></summary>

`/reddit` is now a pure TypeScript module using Reddit's OAuth2 API directly — no external Python dependency.

```bash
# .env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=bot_account
REDDIT_PASSWORD=bot_password
```

Create a "script" app at https://www.reddit.com/prefs/apps/. Use a dedicated bot account — NOT your personal credentials. Video downloads need `ffmpeg` and `ffprobe` on your PATH.

</details>

<details>
<summary><strong>Medium — <code>/medium</code></strong></summary>

Pure TypeScript via Freedium mirror — no extra dependencies.

```bash
# .env (optional tuning)
FREEDIUM_HOST=freedium-mirror.cfd
MEDIUM_TIMEOUT_MS=15000
```

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `BOT_NAME` | `Claudegram` | Bot name in system prompt |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |
| `CANCEL_ON_NEW_MESSAGE` | `false` | Auto-cancel running query on new message |
| `CLAUDE_SDK_LOG_LEVEL` | `off` | SDK log level: off, basic, verbose, trace |

### Reddit

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDIT_CLIENT_ID` | — | Reddit OAuth2 client ID |
| `REDDIT_CLIENT_SECRET` | — | Reddit OAuth2 client secret |
| `REDDIT_USERNAME` | — | Reddit bot account username |
| `REDDIT_PASSWORD` | — | Reddit bot account password |
| `REDDIT_VIDEO_MAX_SIZE_MB` | `50` | Max video size before compression |
| `REDDITFETCH_TIMEOUT_MS` | `30000` | Execution timeout |
| `REDDITFETCH_JSON_THRESHOLD_CHARS` | `8000` | Auto-switch to JSON output |

### Medium / Freedium

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEDIUM_HOST` | `freedium-mirror.cfd` | Freedium mirror host |
| `MEDIUM_TIMEOUT_MS` | `15000` | Fetch timeout |
| `MEDIUM_FILE_THRESHOLD_CHARS` | `8000` | File save threshold |

---

## Architecture

```
src/
├── bot/
│   ├── bot.ts                     # Bot setup, handler registration
│   ├── handlers/
│   │   ├── command.handler.ts     # All slash commands + inline keyboards
│   │   ├── message.handler.ts     # Text routing, ForceReply dispatch
│   │   └── photo.handler.ts       # Image save + agent notification
│   └── middleware/
│       ├── auth.middleware.ts      # User whitelist + group chat auth
│       └── stale-filter.ts        # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                   # Claude Agent SDK, session resume, system prompt
│   ├── mcp-tools.ts              # MCP server: Reddit, Medium, Telegraph tools
│   ├── session-manager.ts         # Per-chat session state
│   ├── session-history.ts         # Session persistence and history
│   ├── request-queue.ts           # Sequential request queue
│   ├── command-parser.ts          # Help text + command descriptions
│   └── agent-watchdog.ts          # Watchdog for long-running agent tasks
├── reddit/
│   ├── redditfetch.ts             # Native TypeScript Reddit client (OAuth2)
│   └── vreddit.ts                 # Reddit video download + compression pipeline
├── medium/
│   └── freedium.ts                # Freedium article fetcher
├── telegram/
│   ├── message-sender.ts          # Streaming, chunking, Telegraph routing
│   ├── markdown.ts                # MarkdownV2 escaping
│   ├── telegraph.ts               # Telegraph Instant View client
│   ├── telegraph-settings.ts      # Per-chat Telegraph toggle
│   ├── terminal-renderer.ts       # Terminal-style UI renderer
│   ├── terminal-settings.ts       # Per-chat terminal UI toggle
│   └── deduplication.ts           # Message dedup
├── utils/
│   ├── download.ts                # URL download with SSRF protection
│   ├── sanitize.ts                # Path and error sanitization
│   ├── workspace-guard.ts         # Workspace boundary enforcement
│   ├── url-guard.ts               # URL validation (protocol, SSRF)
│   ├── file-type.ts               # File content validation
│   ├── caffeinate.ts              # macOS sleep prevention
│   ├── session-key.ts             # Session key generation (DM + forum topics)
│   ├── agent-timer.ts             # Agent execution timing
│   └── debug-agent.ts             # Debug utilities
├── config.ts                      # Zod-validated environment config
└── index.ts                       # Entry point
```

---

## Development

```bash
npm run dev          # Dev mode with hot reload (tsx watch)
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm start            # Run compiled build
```

### Bot Control Script

```bash
./scripts/claudegram-botctl.sh dev start      # Start dev mode
./scripts/claudegram-botctl.sh dev restart     # Restart dev
./scripts/claudegram-botctl.sh prod start      # Start production
./scripts/claudegram-botctl.sh dev log         # Tail logs
./scripts/claudegram-botctl.sh dev status      # Check if running
```

### Self-Editing Workflow

If Claudegram is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
./scripts/claudegram-botctl.sh prod start      # No hot reload
# ... let Claude edit files ...
./scripts/claudegram-botctl.sh prod restart     # Apply changes
```

Then `/continue` or `/resume` in Telegram to restore your session.

---

## Security

- **User whitelist** — only approved Telegram IDs can interact
- **Project sandbox** — Claude operates within the configured working directory
- **Permission mode** — uses `acceptEdits` by default
- **Dangerous mode** — opt-in auto-approve for all tool permissions
- **Secrets** — loaded from `.env` (gitignored), never committed

---

## Credits

Original project by [NachoSEO](https://github.com/NachoSEO/claudegram). Extended with Reddit video downloads, Medium integration, Telegraph output, image uploads, and session continuity.

## License

MIT
