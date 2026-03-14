# Auto-Resolve Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--auto` flag to `pr-resolve` that detects addressed review comments via GitHub's `isOutdated` signal and suggestion block matching, resolving only confirmed threads.

**Architecture:** Extend `scripts/resolve-pr-threads.ts` with a parallel auto-resolve path. When `--auto` is passed, the script fetches live thread state from GitHub GraphQL (bypassing the sidecar), classifies each thread into auto-resolve or skip buckets, executes mutations for the auto-resolve bucket, and posts a summary comment.

**Tech Stack:** TypeScript, GitHub GraphQL API via `gh` CLI, Node.js `Buffer` for base64 decoding.

**Design doc:** `docs/plans/2026-03-14-auto-resolve-design.md`

---

### Task 1: Add Types and Extended GraphQL Query

**Files:**
- Modify: `scripts/resolve-pr-threads.ts:27-28` (interfaces)
- Modify: `scripts/resolve-pr-threads.ts` (add new query constant)

**Step 1: Add new interfaces after existing ones (line 28)**

After the existing `PrPrismConfig` interface, add:

```typescript
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
        reviewThreads: { nodes: AutoThread[] };
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
```

**Step 2: Add the extended GraphQL query constant**

After the new interfaces, add:

```typescript
const AUTO_GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      reviewThreads(first: 100) {
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
```

**Step 3: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS (new types are unused but valid)

**Step 4: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add auto-resolve types and extended GraphQL query"
```

---

### Task 2: Add `fetchThreadsLive` Function

**Files:**
- Modify: `scripts/resolve-pr-threads.ts` (add function after `mutateThread`)

**Step 1: Add the function**

After the `mutateThread` function (line 74), add:

```typescript
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
```

**Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add fetchThreadsLive for auto-resolve GraphQL fetching"
```

---

### Task 3: Add Suggestion Extraction and File Fetching

**Files:**
- Modify: `scripts/resolve-pr-threads.ts` (add two functions after `fetchThreadsLive`)

**Step 1: Add `extractSuggestions` function**

```typescript
function extractSuggestions(body: string): string[] {
  const suggestions: string[] = [];
  const regex = /```suggestion\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    suggestions.push(match[1].trimEnd());
  }
  return suggestions;
}
```

**Step 2: Add `fetchFileAtHead` function**

```typescript
function fetchFileAtHead(owner: string, repo: string, path: string, headSha: string): string | null {
  try {
    const raw = run(`gh api repos/${owner}/${repo}/contents/${path}?ref=${headSha}`);
    const parsed = JSON.parse(raw) as { content?: string; encoding?: string };
    if (parsed.encoding === "base64" && parsed.content) {
      return Buffer.from(parsed.content.replace(/\n/g, ""), "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}
```

**Step 3: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add suggestion extraction and file-at-HEAD fetching"
```

---

### Task 4: Add Suggestion Matching

**Files:**
- Modify: `scripts/resolve-pr-threads.ts` (add function after `fetchFileAtHead`)

**Step 1: Add `normalizeLine` helper and `matchesSuggestion` function**

```typescript
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
```

**Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add suggestion matching with normalized line comparison"
```

---

### Task 5: Add Thread Classification

**Files:**
- Modify: `scripts/resolve-pr-threads.ts` (add function after `matchesSuggestion`)

**Step 1: Add `classifyThreads` function**

```typescript
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
      // Signal 1: GitHub-native outdated detection
      if (thread.isOutdated || thread.line === null) {
        return { thread, action: "resolve", reason: "lines-changed" };
      }

      // Signal 2: Suggestion matching
      for (const comment of thread.comments.nodes) {
        const suggestions = extractSuggestions(comment.body);
        if (suggestions.length === 0) continue;

        const filePath = comment.path ?? thread.path;
        if (!filePath) continue;

        const fileContent = getFile(filePath);
        if (fileContent === null) {
          // File deleted — treat as addressed
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
```

**Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add thread classification with outdated + suggestion signals"
```

---

### Task 6: Add Auto-Resolve Main Flow

**Files:**
- Modify: `scripts/resolve-pr-threads.ts:86-141` (extend `main` function)

**Step 1: Add `--auto` flag parsing**

In the `main` function, after line 88 (`const isDryRun`), add:

```typescript
  const isAuto = args.includes("--auto");
```

**Step 2: Add `runAutoResolve` function before `main`**

```typescript
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
  const pr = payload.data.repository.pullRequest;
  const headSha = pr.headRefOid;
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

  if (!isDryRun && (ok > 0 || toSkip.length > 0)) {
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
```

**Step 3: Wire `--auto` into `main`**

Replace the current `main` body from line 96 onward. The key change: when `--auto` is passed, detect `owner`/`repo` from sidecar or git remote, then call `runAutoResolve` instead of the sidecar-based loop.

After `const prNumber` (line 94), add the auto branch:

```typescript
  if (isAuto) {
    if (prNumber === null) {
      console.error("--auto requires a PR number. Usage: pnpm run pr-resolve -- <PR> --auto");
      process.exit(1);
    }
    // Try sidecar for owner/repo, fall back to git remote
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
```

The existing sidecar-based flow below this `if` block remains unchanged.

**Step 4: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/resolve-pr-threads.ts
git commit -m "feat: add --auto flag with smart thread classification and summary comments"
```

---

### Task 7: Update Documentation

**Files:**
- Modify: `scripts/resolve-pr-threads.ts:1-16` (file header comment)
- Modify: `README.md`
- Modify: `llms.txt`
- Modify: `agents/scrape-pr-reviews.md`

**Step 1: Update the file header comment in resolve-pr-threads.ts**

Replace lines 2-16 with:

```typescript
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
```

**Step 2: Add auto-resolve section to README.md**

In the `pr-resolve` usage section, add:

```markdown
### `pr-resolve --auto` — smart auto-resolve

```bash
pnpm run pr-resolve -- 42 --auto              # auto-resolve addressed threads only
pnpm run pr-resolve -- 42 --auto --dry-run    # preview what would be resolved
pnpm run pr-resolve -- 42 --auto --tag-agents # auto-resolve + tag agents for re-review
```

Auto-resolve re-fetches live thread state from GitHub and resolves only threads where:
- **Lines changed** — GitHub marks the thread as `isOutdated` (commented lines were modified)
- **Suggestion applied** — a `suggestion` block in the comment matches the current file content

Threads without a strong signal are skipped. A summary comment is posted on the PR:

```
pr-prism auto-resolve — 6 of 8 threads resolved

Auto-resolved (lines changed): 4
Auto-resolved (suggestion applied): 2
Remaining (needs manual review): 2
```
```

**Step 3: Update llms.txt with auto-resolve commands**

Add to the Commands section:

```
- `pnpm run pr-resolve -- 42 --auto` — smart auto-resolve: re-fetch threads, resolve only addressed ones
- `pnpm run pr-resolve -- 42 --auto --dry-run` — preview auto-resolve classifications
- `pnpm run pr-resolve -- 42 --auto --tag-agents` — auto-resolve + tag agents
```

**Step 4: Update the agent loop in README.md, llms.txt, and agents/scrape-pr-reviews.md**

Replace step 3 in the agent loop with:

```
3.  pnpm run pr-resolve -- <PR number> --auto --tag-agents
        → Re-fetches live thread state from GitHub
        → Auto-resolves: isOutdated threads + matched suggestions
        → Posts summary: "Auto-resolved 6/8 threads. 2 remain."
        → Tags agents for re-review
```

**Step 5: Commit**

```bash
git add scripts/resolve-pr-threads.ts README.md llms.txt agents/scrape-pr-reviews.md
git commit -m "docs: add --auto flag documentation to all reference files"
```

---

### Task 8: Manual Smoke Test

**Step 1: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS with zero errors

**Step 2: Dry-run test against a real PR (if available)**

Run: `pnpm run pr-resolve -- <any-open-PR> --auto --dry-run`
Expected: Should print classification output without mutating anything.

If no open PR with review threads is available, verify by reading through the code logic end-to-end — the functions are straightforward and the GraphQL/REST calls are the same patterns already proven in the codebase.

**Step 3: Commit (final)**

```bash
git add -A
git commit -m "chore: verify typecheck passes after auto-resolve implementation"
```
