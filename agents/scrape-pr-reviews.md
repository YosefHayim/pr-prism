---
name: scrape-pr-reviews
description: >
  Fetches open PRs from the current repo via gh CLI, lets you pick one interactively,
  and writes only new/unresolved human review comments to a Markdown file.
  After fixes, pr-resolve closes handled threads and optionally tags AI agents for re-review.
  Requires gh CLI authenticated (gh auth login).
tools: ["Bash", "Read"]
model: haiku
---

## Purpose

Auto-detects the GitHub repo from the local git remote, lists open PRs, and
processes the selected PR into a clean Markdown file. Re-runs skip already-seen
comment IDs so each file contains only what's new since the last run.
After fixes are pushed, `pr-resolve` closes handled threads via the GitHub GraphQL
API and can post a comment tagging AI agents for re-review.

## Prerequisites

- `gh` CLI installed and authenticated: `gh auth login`
- `pnpm install` (prompts is a devDependency)

## Commands

```bash
# Scrape new review comments
pnpm run pr-review                        # list open PRs → interactive select
pnpm run pr-review -- 42                  # process PR #42 directly
pnpm run pr-review -- https://github.com/owner/repo/pull/42

# Resolve handled threads + tag agents
pnpm run pr-resolve -- 42                 # resolve all threads from last scrape
pnpm run pr-resolve -- 42 --auto          # smart auto-resolve (detects addressed threads)
pnpm run pr-resolve -- 42 --auto --dry-run # preview auto-resolve classifications
pnpm run pr-resolve -- 42 --auto --tag-agents # auto-resolve + tag agents
pnpm run pr-resolve -- 42 --dry-run       # preview without mutating
pnpm run pr-resolve -- 42 --tag-agents    # resolve + post @mention comment
pnpm run pr-resolve -- 42 --tag-agents --comment "Fixed in abc123"
pnpm run pr-resolve -- 42 --unresolve     # re-open threads if needed
```

## Output files

| File | Description |
|------|-------------|
| `pr-reviews/new-<timestamp>.md` | New comments only since last run |
| `pr-reviews/.scraped-ids.json` | Persistent ID cache — commit this file |
| `pr-reviews/.threads-<pr>.json` | Thread IDs for `pr-resolve` — auto-generated |

## What gets filtered (pr-review)

| Case | Detection | Behaviour |
|------|-----------|-----------|
| Already-seen comment | ID in `.scraped-ids.json` | Silently skipped |
| Resolved thread | GraphQL `isResolved: true` | Skipped + ID cached |
| Bot comment | Author ends in `[bot]` or matches `KNOWN_BOTS` | Skipped + ID cached |

## What gets annotated (pr-review)

| Case | Detection | Output annotation |
|------|-----------|-------------------|
| Outdated thread | GraphQL `isOutdated: true` | `### ⚠️ OUTDATED / SUPERSEDED` |
| Suggested change | ` ```suggestion ` block in body | ` ```diff ` with `+` lines |
| File context | Thread `path` field | `### 📄 File: \`path/to/file.ts\`` |
| Thread ID | First comment of each thread | `<!-- thread-id: PRRT_xxx -->` |

## Iterative agent workflow

```
1. pnpm run pr-review -- <PR number>
2. Agent reads pr-reviews/new-<timestamp>.md
3. Agent implements fixes, commits, pushes
4. pnpm run pr-resolve -- <PR number> --auto --tag-agents
   → Re-fetches live thread state from GitHub
   → Auto-resolves: isOutdated threads + matched suggestions
   → Posts: "Auto-resolved 6/8 threads. 2 remain."
   → Tags agents for re-review
5. Repeat from step 1 — only new reviewer replies appear
```

## Config (.pr-prism.json in repo root)

```json
{
  "agentMentions": ["cubic-dev-ai", "coderabbitai"]
}
```

Overrides `DEFAULT_AGENT_MENTIONS` in `resolve-pr-threads.ts` without editing source.
