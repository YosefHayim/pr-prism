#!/usr/bin/env tsx
/*
 * PR review scraper — auto-detects repo, lists open PRs, processes selected PR.
 *
 * REQUIRES: gh CLI authenticated (gh auth login)
 * FEATURES: ID cache · resolved/outdated skip · bot filter · suggested diff · file path
 *
 * USAGE
 *   pnpm run pr-review              — detect repo, list open PRs, interactive select
 *   pnpm run pr-review -- 42        — detect repo, process PR #42 directly
 *   pnpm run pr-review -- <url>     — process by full GitHub PR URL
 *
 * OUTPUT
 *   pr-reviews/new-<timestamp>.md         — new comments only since last run
 *   pr-reviews/.scraped-ids.json          — persistent ID cache (commit this file)
 *   pr-reviews/.threads-<prNumber>.json   — thread IDs for pr-resolve
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import prompts from "prompts";

const KNOWN_BOTS = ["github-actions", "dependabot", "coderabbitai", "changeset-bot", "codeantai"];
const OUT_DIR = "pr-reviews";
const CACHE_FILE = join(OUT_DIR, ".scraped-ids.json");

const GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated
          comments(first: 20) {
            nodes { databaseId author { login } body path }
          }
        }
      }
      reviews(first: 50) {
        nodes { databaseId author { login } body state }
      }
      comments(first: 100) {
        nodes { databaseId author { login } body }
      }
    }
  }
}`.trim();

interface GhComment { databaseId: number; author: { login: string }; body: string; path?: string; state?: string; }
interface ReviewThread { id: string; isResolved: boolean; isOutdated: boolean; comments: { nodes: GhComment[] }; }
interface ThreadsSidecar { prNumber: number; owner: string; repo: string; threadIds: string[]; }
interface PrPayload { data: { repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] }; reviews: { nodes: GhComment[] }; comments: { nodes: GhComment[] }; }; }; }; }
interface PrListItem { number: number; title: string; author: { login: string }; }
interface IdCache { seen: string[]; }

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function detectRepo(): { owner: string; repo: string } {
  try {
    const remote = run("git remote get-url origin");
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/\s.]+)/);
    if (!m) throw new Error();
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  } catch {
    console.error("❌ Could not detect GitHub repo. Run from a GitHub repo or pass a URL.");
    process.exit(1);
  }
}

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) { console.error(`❌ Invalid GitHub PR URL: ${url}`); process.exit(1); }
  return { owner: m[1], repo: m[2], prNumber: parseInt(m[3], 10) };
}

function listOpenPrs(owner: string, repo: string): PrListItem[] {
  const out = run(`gh pr list --repo ${owner}/${repo} --state open --json number,title,author --limit 50`);
  return JSON.parse(out) as PrListItem[];
}

async function selectPr(prs: PrListItem[]): Promise<number> {
  if (prs.length === 0) { console.log("No open PRs found."); process.exit(0); }
  const { value } = await prompts({
    type: "select",
    name: "value",
    message: "Select a PR:",
    choices: prs.map((p) => ({ title: `#${p.number}  ${p.title}  (${p.author.login})`, value: p.number })),
  });
  if (value === undefined) process.exit(0);
  return value as number;
}

function fetchPr(owner: string, repo: string, prNumber: number): PrPayload {
  const reqFile = join(tmpdir(), ".pr-review-req.json");
  writeFileSync(reqFile, JSON.stringify({ query: GRAPHQL_QUERY, variables: { owner, repo, prNumber } }), "utf-8");
  try {
    return JSON.parse(run(`gh api https://api.github.com/graphql --input ${reqFile}`)) as PrPayload;
  } catch (err) {
    console.error("❌ gh API failed. Is gh authenticated? Run: gh auth login");
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    unlinkSync(reqFile);
  }
}

function loadCache(): Set<string> {
  if (!existsSync(CACHE_FILE)) return new Set();
  try { return new Set((JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as IdCache).seen); } catch { return new Set(); }
}
function saveCache(seen: Set<string>): void { writeFileSync(CACHE_FILE, JSON.stringify({ seen: [...seen] }, null, 2), "utf-8"); }
function isBot(login: string): boolean { const l = login.toLowerCase(); return l.endsWith("[bot]") || KNOWN_BOTS.some((b) => l.includes(b)); }

const NOISE_DOMAINS = [
  "twitter.com/intent", "x.com/intent",
  "reddit.com/submit",
  "linkedin.com/sharing",
  "app.codeant.ai", "codeant.ai/feedback",
];

function stripNoise(body: string): string {
  return body
    .replace(/<a\s[^>]*href=['"]([^'"]+)['"][^>]*>[\s\S]*?<\/a>/gi, (match, url: string) =>
      NOISE_DOMAINS.some((d) => url.includes(d)) ? "" : match,
    )
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (match, _text, url: string) =>
      NOISE_DOMAINS.some((d) => url.includes(d)) ? "" : match,
    )
    .replace(/^[\s·|—\-]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderSuggestions(body: string): string {
  return body.replace(/```suggestion\n([\s\S]*?)```/g, (_, code: string) => {
    const lines = code.trimEnd().split("\n").map((l: string) => `+ ${l}`).join("\n");
    return `\n**SUGGESTED CHANGE:**\n\`\`\`diff\n${lines}\n\`\`\`\n`;
  });
}

function appendComment(out: string, c: GhComment, prefix: string): string {
  const body = renderSuggestions(stripNoise(c.body)).trim();
  return body ? out + prefix + `## 💬 **${c.author.login}**\n\n${body}\n\n---\n\n` : out;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  let owner: string, repo: string, prNumber: number;

  if (arg?.startsWith("http")) {
    ({ owner, repo, prNumber } = parsePrUrl(arg));
  } else if (arg && /^\d+$/.test(arg)) {
    ({ owner, repo } = detectRepo());
    prNumber = parseInt(arg, 10);
  } else {
    ({ owner, repo } = detectRepo());
    const prs = listOpenPrs(owner, repo);
    console.log(`\nFound ${prs.length} open PR(s) in ${owner}/${repo}\n`);
    prNumber = await selectPr(prs);
  }

  console.log(`\nFetching PR #${prNumber} from ${owner}/${repo}…`);
  const pr = fetchPr(owner, repo, prNumber).data.repository.pullRequest;

  mkdirSync(OUT_DIR, { recursive: true });
  const cache = loadCache();
  let output = `# PR Review — ${owner}/${repo} #${prNumber}\n\n`;
  let count = 0;
  const emittedThreadIds: string[] = [];

  for (const thread of pr.reviewThreads.nodes) {
    let firstInThread = true;
    for (const c of thread.comments.nodes) {
      const key = String(c.databaseId);
      if (thread.isResolved || isBot(c.author.login)) { cache.add(key); continue; }
      if (cache.has(key)) continue;
      const threadAnnotation = firstInThread ? `<!-- thread-id: ${thread.id} -->\n` : "";
      const filePrefix = c.path ? `### 📄 File: \`${c.path}\`\n\n` : "";
      const outdatedPrefix = thread.isOutdated ? `### ⚠️ OUTDATED / SUPERSEDED\n\n` : "";
      output = appendComment(output, c, threadAnnotation + filePrefix + outdatedPrefix);
      cache.add(key); count++;
      if (firstInThread) { emittedThreadIds.push(thread.id); firstInThread = false; }
    }
  }

  for (const c of [...pr.reviews.nodes, ...pr.comments.nodes]) {
    const key = String(c.databaseId);
    if (isBot(c.author.login) || !c.body.trim()) { cache.add(key); continue; }
    if (cache.has(key)) continue;
    output = appendComment(output, c, "");
    cache.add(key); count++;
  }

  saveCache(cache);
  const outFile = join(OUT_DIR, `new-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(outFile, output, "utf-8");

  if (emittedThreadIds.length > 0) {
    const sidecar: ThreadsSidecar = { prNumber, owner, repo, threadIds: emittedThreadIds };
    writeFileSync(join(OUT_DIR, `.threads-${prNumber}.json`), JSON.stringify(sidecar, null, 2), "utf-8");
  }

  console.log(count > 0 ? `\n✅ ${count} new comment(s) → ${outFile}` : `\n✅ No new comments since last run. → ${outFile}`);
}

main().catch((err: unknown) => { console.error((err as Error).message); process.exit(1); });
