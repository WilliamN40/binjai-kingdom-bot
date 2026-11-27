/**
 * Deploying the bot from the chat.
 *
 * The owner sends /deploy: the bot looks up what would go live (commits and
 * changed files, from GitHub) and asks for confirmation. /deploy confirm <sha>
 * writes DATA_DIR/deploy/request.json. A systemd unit on the host
 * (deploy/binjaibot-deploy.path) notices the file and runs deploy/deploy.sh,
 * which checks out exactly that commit, rebuilds and restarts the containers,
 * rolls back if the bot does not come up, and writes result.json. The bot posts
 * the result in the chat that asked, after its restart if there was one.
 *
 * The bot itself never builds or runs anything on the host: it can only ask
 * for one specific commit, and only after the owner confirmed it in the chat.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface DeployRequest {
  sha: string;
  ref: string;
  requestedBy: string;
  chatId: number;
  threadId?: number;
  at: string;
}

export interface DeployResult {
  ok: boolean;
  sha: string;
  previous?: string;
  message: string;
  chatId: number;
  threadId?: number;
  finishedAt: string;
}

export interface DeployPlan {
  sha: string;
  ref: string;
  current?: string;
  commits: Array<{ sha: string; title: string; author: string }>;
  files: string[];
  sensitive: string[];
  behind: boolean;
}

/** Files whose change alters the containers, the sandbox or the deploy itself, not just the bot's code. */
const SENSITIVE = /^(Dockerfile|docker-compose\.yml|package(-lock)?\.json|sandbox\/|deploy\/|\.env\.example)/;
const PLAN_TTL_MS = 15 * 60_000;

const pendingPlans = new Map<number, DeployPlan & { expires: number }>();

function deployDir(): string {
  return path.join(config.DATA_DIR, 'deploy');
}

export function deployEnabled(): boolean {
  return config.DEPLOY_FROM_CHAT && /github\.com\/[^/]+\/[^/]+/.test(config.BOT_REPO_URL);
}

/** The commit running now, as recorded by the host's deploy script. */
export function currentVersion(): { sha: string; deployedAt?: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(deployDir(), 'current.json'), 'utf8')) as { sha?: string; deployedAt?: string };
    return raw.sha ? { sha: raw.sha, deployedAt: raw.deployedAt } : undefined;
  } catch {
    return undefined;
  }
}

function repoPath(): string {
  const match = config.BOT_REPO_URL.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) throw new Error('BOT_REPO_URL is not a GitHub repository.');
  return `${match[1]}/${match[2]}`;
}

async function github<T>(endpoint: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repoPath()}/${endpoint}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'binjaibot-deploy' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${endpoint.split('?')[0]}`);
  return (await response.json()) as T;
}

/** What deploying `ref` (a branch, tag or commit; default main) would change. */
export async function planDeploy(chatId: number, ref: string): Promise<DeployPlan> {
  if (!/^[\w./-]{1,100}$/.test(ref)) throw new Error('That is not a branch name or commit.');
  const commit = await github<{ sha: string }>(`commits/${encodeURIComponent(ref)}`);
  const current = currentVersion()?.sha;
  let commits: DeployPlan['commits'] = [];
  let files: string[] = [];
  let behind = false;
  if (current && current !== commit.sha) {
    const compare = await github<{
      status: string;
      commits: Array<{ sha: string; commit: { message: string; author?: { name?: string } } }>;
      files?: Array<{ filename: string }>;
    }>(`compare/${current}...${commit.sha}`);
    behind = compare.status === 'behind' || compare.status === 'diverged';
    commits = compare.commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      title: c.commit.message.split('\n')[0].slice(0, 100),
      author: c.commit.author?.name ?? '?',
    }));
    files = (compare.files ?? []).map((f) => f.filename);
  }
  const plan: DeployPlan = {
    sha: commit.sha,
    ref,
    current,
    commits,
    files,
    sensitive: files.filter((f) => SENSITIVE.test(f)),
    behind,
  };
  pendingPlans.set(chatId, { ...plan, expires: Date.now() + PLAN_TTL_MS });
  return plan;
}

export function describePlan(plan: DeployPlan): string {
  const short = plan.sha.slice(0, 7);
  if (plan.current === plan.sha) return `${plan.ref} (${short}) is already running. Nothing to deploy.`;
  const lines = [`Deploy ${plan.ref} at ${short}${plan.current ? `, replacing ${plan.current.slice(0, 7)}` : ''}?`];
  if (plan.commits.length) {
    lines.push('', `${plan.commits.length} commit(s):`);
    for (const c of plan.commits.slice(-15)) lines.push(`• ${c.sha} ${c.title} (${c.author})`);
    if (plan.commits.length > 15) lines.push(`• … and ${plan.commits.length - 15} earlier`);
  } else if (!plan.current) {
    lines.push('', "I don't know which version is running now, so I can't list the changes.");
  }
  if (plan.behind) lines.push('', '⚠️ This goes back to an older version than the one running.');
  if (plan.files.length) lines.push('', `${plan.files.length} file(s) changed.`);
  if (plan.sensitive.length) {
    lines.push(
      '',
      `⚠️ Changes to the containers, sandbox or deploy setup (these run with more power on the server, so read them first): ${plan.sensitive.slice(0, 15).join(', ')}`,
    );
  }
  lines.push('', `To go ahead, the owner sends: /deploy confirm ${short}`, 'The bot restarts for a minute or two; answers in progress are finished first.');
  return lines.join('\n');
}

/** Turn a confirmed plan into a request for the host. Returns an error message instead if it does not match. */
export function confirmDeploy(chatId: number, shortSha: string, requestedBy: string, threadId?: number): string | undefined {
  const plan = pendingPlans.get(chatId);
  if (!plan || plan.expires < Date.now()) return 'There is no deploy waiting for confirmation here. Send /deploy first.';
  if (!shortSha || !plan.sha.startsWith(shortSha.toLowerCase()) || shortSha.length < 7) {
    return `That does not match the deploy I showed (${plan.sha.slice(0, 7)}). Send /deploy again if things changed.`;
  }
  const request: DeployRequest = { sha: plan.sha, ref: plan.ref, requestedBy, chatId, threadId, at: new Date().toISOString() };
  fs.mkdirSync(deployDir(), { recursive: true });
  atomicWriteFileSync(path.join(deployDir(), 'request.json'), JSON.stringify(request, null, 2));
  pendingPlans.delete(chatId);
  return undefined;
}

/** A finished deploy the host reported, taken out of the folder so it is announced once. */
export function takeDeployResult(): DeployResult | undefined {
  const file = path.join(deployDir(), 'result.json');
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8')) as DeployResult;
    fs.rmSync(file, { force: true });
    return result;
  } catch {
    return undefined;
  }
}
