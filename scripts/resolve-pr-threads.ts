#!/usr/bin/env tsx
/*
 * Resolve (or unresolve) PR review threads and optionally tag AI agents.
 *
 * MODES
 *   Manual:  reads the sidecar .threads-<prNumber>.json written by pr-review
 *   Auto:    re-fetches live thread state from GitHub, resolves only threads
 *            where isOutdated=true or suggestion blocks match current file content
 *
 * USAGE
 *   pnpm run pr-resolve                        — latest .threads-*.json
 *   pnpm run pr-resolve -- 42                  — explicit PR number
 *   pnpm run pr-resolve -- 42 --auto           — smart auto-resolve (re-fetches from GitHub)
 *   pnpm run pr-resolve -- 42 --auto --dry-run — preview auto-resolve classifications
 *   pnpm run pr-resolve -- 42 --auto --tag-agents — auto-resolve + tag agents
 *   pnpm run pr-resolve -- 42 --dry-run        — preview without mutating
 *   pnpm run pr-resolve -- 42 --tag-agents     — resolve + post @mention comment
 *   pnpm run pr-resolve -- 42 --tag-agents --comment "Fixed in abc123"
 *   pnpm run pr-resolve -- 42 --unresolve      — re-open resolved threads
 *
 * CONFIG  (.pr-prism.json in repo root)
 *   { "agentMentions": ["cubic-dev-ai", "coderabbitai"] }
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT_DIR = "pr-reviews";
const CONFIG_FILE = ".pr-prism.json";
const DEFAULT_AGENT_MENTIONS = ["cubic-dev-ai"];

interface ThreadsSidecar { prNumber: number; owner: string; repo: string; threadIds: string[]; }
interface PrPrismConfig { agentMentions?: string[]; }

interface AutoThreadComment {
  databaseId: number;
  author: { login: string };
  body: string;
  path: string;
  outdated: boolean;
}

interface AutoThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: { nodes: AutoThreadComment[] };
}

interface AutoPayload {
  data: {
    repository: {
      pullRequest: {
        headRefOid: string;
        reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: AutoThread[] };
      };
    };
  };
}

type ResolutionReason = "lines-changed" | "suggestion-applied";

interface ClassifiedThread {
  thread: AutoThread;
  action: "resolve" | "skip";
  reason: ResolutionReason | "no-signal";
}

const AUTO_GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated
          path line originalLine
          comments(first: 20) {
            nodes {
              databaseId
              author { login }
              body
              path
              outdated
            }
          }
        }
      }
    }
  }
}`.trim();

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function loadConfig(): PrPrismConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as PrPrismConfig; } catch { return {}; }
}

function runScrape(prNumber: number | null): void {
  const args = ["scripts/scrape-pr-reviews.ts"];
  if (prNumber !== null) args.push(String(prNumber));
  const result = spawnSync(join("node_modules", ".bin", "tsx"), args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findSidecar(prNumber: number | null): string | null {
  if (!existsSync(OUT_DIR)) return null;
  if (prNumber !== null) {
    const f = join(OUT_DIR, `.threads-${prNumber}.json`);
    return existsSync(f) ? f : null;
  }
  const files = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(".threads-") && f.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? join(OUT_DIR, files[0]) : null;
}

function mutateThread(threadId: string, unresolve: boolean): boolean {
  const mutation = unresolve
    ? `mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`
    : `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}`;
  const reqFile = join(tmpdir(), ".pr-resolve-req.json");
  writeFileSync(reqFile, JSON.stringify({ query: mutation, variables: { id: threadId } }), "utf-8");
  try {
    const result = JSON.parse(run(`gh api https://api.github.com/graphql --input ${reqFile}`));
    const key = unresolve ? "unresolveReviewThread" : "resolveReviewThread";
    return result.data?.[key]?.thread != null;
  } catch {
    return false;
  } finally {
    unlinkSync(reqFile);
  }
}

function postComment(prNumber: number, owner: string, repo: string, message: string): void {
  const bodyFile = join(tmpdir(), ".pr-comment-body.txt");
  writeFileSync(bodyFile, message, "utf-8");
  try {
    run(`gh pr comment ${prNumber} --repo ${owner}/${repo} --body-file ${bodyFile}`);
  } finally {
    unlinkSync(bodyFile);
  }
}

function fetchThreadsLive(owner: string, repo: string, prNumber: number): AutoPayload {
  const reqFile = join(tmpdir(), ".pr-auto-resolve-req.json");
  writeFileSync(reqFile, JSON.stringify({ query: AUTO_GRAPHQL_QUERY, variables: { owner, repo, prNumber } }), "utf-8");
  try {
    return JSON.parse(run(`gh api https://api.github.com/graphql --input ${reqFile}`)) as AutoPayload;
  } catch (err) {
    console.error("gh API failed fetching threads. Is gh authenticated?");
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    unlinkSync(reqFile);
  }
}

function extractSuggestions(body: string): string[] {
  const suggestions: string[] = [];
  const regex = /```suggestion\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    suggestions.push(match[1].trimEnd());
  }
  return suggestions;
}

function fetchFileAtHead(owner: string, repo: string, path: string, headSha: string): string | null {
  try {
    const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");
    const raw = run(`gh api repos/${owner}/${repo}/contents/${encodedPath}?ref=${headSha}`);
    const parsed = JSON.parse(raw) as { content?: string; encoding?: string };
    if (parsed.encoding === "base64" && parsed.content) {
      return Buffer.from(parsed.content.replace(/\n/g, ""), "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function matchesSuggestion(fileContent: string, suggestion: string): boolean {
  const suggestionLines = suggestion.split("\n").map(normalizeLine).filter((l) => l.length > 0);
  if (suggestionLines.length === 0) return false;
  const fileLines = fileContent.split("\n").map(normalizeLine);

  for (let i = 0; i <= fileLines.length - suggestionLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < suggestionLines.length; j++) {
      if (fileLines[i + j] !== suggestionLines[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

function classifyThreads(
  threads: AutoThread[],
  owner: string,
  repo: string,
  headSha: string,
): ClassifiedThread[] {
  const fileCache = new Map<string, string | null>();

  function getFile(path: string): string | null {
    if (!fileCache.has(path)) {
      fileCache.set(path, fetchFileAtHead(owner, repo, path, headSha));
    }
    return fileCache.get(path) ?? null;
  }

  return threads
    .filter((t) => !t.isResolved)
    .map((thread): ClassifiedThread => {
      if (thread.isOutdated || thread.line === null) {
        return { thread, action: "resolve", reason: "lines-changed" };
      }

      for (const comment of thread.comments.nodes) {
        const suggestions = extractSuggestions(comment.body);
        if (suggestions.length === 0) continue;

        const filePath = comment.path ?? thread.path;
        if (!filePath) continue;

        const fileContent = getFile(filePath);
        if (fileContent === null) {
          return { thread, action: "resolve", reason: "lines-changed" };
        }

        const allMatch = suggestions.every((s) => matchesSuggestion(fileContent, s));
        if (allMatch) {
          return { thread, action: "resolve", reason: "suggestion-applied" };
        }
      }

      return { thread, action: "skip", reason: "no-signal" };
    });
}

async function runAutoResolve(
  prNumber: number,
  owner: string,
  repo: string,
  isDryRun: boolean,
  shouldTag: boolean,
  customComment: string | null,
): Promise<void> {
  console.log(`\nAuto-resolving threads in ${owner}/${repo} #${prNumber}${isDryRun ? " [DRY RUN]" : ""}…\n`);

  const payload = fetchThreadsLive(owner, repo, prNumber);
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) {
    console.error(`Could not fetch PR #${prNumber} from ${owner}/${repo}. Check the PR number and token permissions.`);
    process.exit(1);
  }
  const headSha = pr.headRefOid;
  if (pr.reviewThreads.pageInfo.hasNextPage) {
    console.log("  Warning: PR has >100 review threads. Only the first 100 are processed.\n");
  }
  const allThreads = pr.reviewThreads.nodes;
  const unresolvedCount = allThreads.filter((t) => !t.isResolved).length;

  if (unresolvedCount === 0) {
    console.log("No unresolved threads found.");
    return;
  }

  const classified = classifyThreads(allThreads, owner, repo, headSha);
  const toResolve = classified.filter((c) => c.action === "resolve");
  const toSkip = classified.filter((c) => c.action === "skip");
  const linesChanged = toResolve.filter((c) => c.reason === "lines-changed").length;
  const suggestionApplied = toResolve.filter((c) => c.reason === "suggestion-applied").length;

  console.log(`  Unresolved threads: ${unresolvedCount}`);
  console.log(`  Will auto-resolve:  ${toResolve.length} (${linesChanged} lines changed, ${suggestionApplied} suggestion applied)`);
  console.log(`  Will skip:          ${toSkip.length}\n`);

  let ok = 0;
  let failed = 0;

  for (const { thread, reason } of toResolve) {
    const label = reason === "suggestion-applied" ? "suggestion applied" : "lines changed";
    if (isDryRun) {
      console.log(`  [dry-run] would resolve ${thread.id} (${label})`);
      ok++;
      continue;
    }
    if (mutateThread(thread.id, false)) {
      console.log(`  auto-resolved ${thread.id} (${label})`);
      ok++;
    } else {
      console.log(`  ${thread.id} — already resolved or mutation failed`);
      failed++;
    }
  }

  for (const { thread } of toSkip) {
    console.log(`  skipped ${thread.id} (no signal)`);
  }

  console.log(`\n${ok} auto-resolved${failed > 0 ? `, ${failed} failed` : ""}${toSkip.length > 0 ? `, ${toSkip.length} skipped` : ""}`);

  if (!isDryRun && ok > 0) {
    const config = loadConfig();
    const mentions = shouldTag
      ? " " + (config.agentMentions ?? DEFAULT_AGENT_MENTIONS).map((a) => `@${a}`).join(" ")
      : "";

    const lines = [
      `**pr-prism auto-resolve** — ${ok} of ${unresolvedCount} threads resolved`,
      "",
    ];
    if (linesChanged > 0) lines.push(`**Auto-resolved (lines changed):** ${linesChanged}`);
    if (suggestionApplied > 0) lines.push(`**Auto-resolved (suggestion applied):** ${suggestionApplied}`);
    if (toSkip.length > 0) lines.push(`**Remaining (needs manual review):** ${toSkip.length}`);
    if (mentions.trim()) lines.push("", `${mentions.trim()} please re-review.`);
    if (customComment) lines.push("", customComment);

    const message = lines.join("\n");
    postComment(prNumber, owner, repo, message);
    console.log(`\nPosted summary comment.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isUnresolve = args.includes("--unresolve");
  const isAuto = args.includes("--auto");
  const shouldTag = args.includes("--tag-agents");
  const commentIdx = args.indexOf("--comment");
  const customComment = commentIdx !== -1 ? args[commentIdx + 1] : null;
  const prArg = args.find((a) => /^\d+$/.test(a));
  const prNumber = prArg != null ? parseInt(prArg, 10) : null;

  if (isAuto) {
    if (prNumber === null) {
      console.error("--auto requires a PR number. Usage: pnpm run pr-resolve -- <PR> --auto");
      process.exit(1);
    }
    if (isUnresolve) {
      console.error("--auto and --unresolve are incompatible.");
      process.exit(1);
    }
    let owner: string;
    let repo: string;
    const sidecarPath = findSidecar(prNumber);
    if (sidecarPath) {
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as ThreadsSidecar;
      owner = sidecar.owner;
      repo = sidecar.repo;
    } else {
      const remote = run("git remote get-url origin");
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/\s.]+)/);
      if (!m) { console.error("Could not detect GitHub repo."); process.exit(1); }
      owner = m[1];
      repo = m[2].replace(/\.git$/, "");
    }
    await runAutoResolve(prNumber, owner, repo, isDryRun, shouldTag, customComment);
    return;
  }

  let sidecarPath = findSidecar(prNumber);
  if (!sidecarPath) {
    console.log("\n⚡ No sidecar found — running pr-review to generate it…\n");
    runScrape(prNumber);
    sidecarPath = findSidecar(prNumber);
    if (!sidecarPath) {
      console.log("ℹ️  pr-review ran but found no inline review threads to resolve.");
      process.exit(0);
    }
  }

  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as ThreadsSidecar;
  const { threadIds, owner, repo } = sidecar;
  const resolvedPr = sidecar.prNumber;
  const action = isUnresolve ? "Unresolve" : "Resolve";

  console.log(`\n${action} ${threadIds.length} thread(s) in ${owner}/${repo} #${resolvedPr}${isDryRun ? " [DRY RUN]" : ""}\n`);

  let ok = 0;
  let failed = 0;

  for (const id of threadIds) {
    if (isDryRun) {
      console.log(`  [dry-run] would ${action.toLowerCase()} ${id}`);
      ok++;
      continue;
    }
    if (mutateThread(id, isUnresolve)) {
      console.log(`  ✅ ${id}`);
      ok++;
    } else {
      console.log(`  ⚠️  ${id} — already ${action.toLowerCase()}d or failed`);
      failed++;
    }
  }

  console.log(`\n${ok} ${action.toLowerCase()}d${failed > 0 ? `, ${failed} skipped` : ""}`);

  if (shouldTag && !isDryRun) {
    const config = loadConfig();
    const mentions = (config.agentMentions ?? DEFAULT_AGENT_MENTIONS).map((a) => `@${a}`).join(" ");
    const message = customComment ?? `All feedback addressed. ${mentions} please re-review.`;
    postComment(resolvedPr, owner, repo, message);
    console.log(`\n💬 Posted: "${message}"`);
  }
}

main().catch((err: unknown) => { console.error((err as Error).message); process.exit(1); });
