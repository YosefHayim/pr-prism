#!/usr/bin/env tsx
/*
 * Resolve (or unresolve) PR review threads and optionally tag AI agents.
 * Reads the sidecar .threads-<prNumber>.json written by pr-review.
 *
 * USAGE
 *   pnpm run pr-resolve                        — latest .threads-*.json
 *   pnpm run pr-resolve -- 42                  — explicit PR number
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isUnresolve = args.includes("--unresolve");
  const shouldTag = args.includes("--tag-agents");
  const commentIdx = args.indexOf("--comment");
  const customComment = commentIdx !== -1 ? args[commentIdx + 1] : null;
  const prArg = args.find((a) => /^\d+$/.test(a));
  const prNumber = prArg != null ? parseInt(prArg, 10) : null;

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
