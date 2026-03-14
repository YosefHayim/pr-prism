# pr-prism

> Filter the noise. Focus on what matters.

**pr-prism** is a stateful GitHub PR review scraper built for AI agent workflows. It fetches review comments directly via the GitHub GraphQL API, filters out bots and noise, emits only what's actionable — once per comment, forever cached — and can resolve handled threads and tag agents for re-review when fixes are pushed.

---

## The Problem

Running an AI agent in a PR-fix loop has one brutal problem: **statefulness**.

Every re-run, the agent re-reads the same resolved comments, outdated threads, and bot spam — wasting tokens, inflating context, and confusing what actually needs fixing right now.

## The Solution

pr-prism solves this with a two-command workflow:

1. **`pr-review`** — scrapes new comments, caches IDs so re-runs only show what's new
2. **`pr-resolve`** — resolves handled threads via GraphQL and tags AI agents for re-review

---

## Features

| Feature | What it does |
|---|---|
| **ID cache** | `pr-reviews/.scraped-ids.json` — re-runs emit only new comments |
| **Resolved threads** | Silently skipped via GraphQL `isResolved` |
| **Outdated threads** | Flagged with `⚠️ OUTDATED` so agents don't chase dead feedback |
| **Bot filter** | Authors ending in `[bot]` or matching `KNOWN_BOTS` are skipped |
| **Suggested changes** | ` ```suggestion ` blocks rendered as clean `diff` (REMOVE / ADD) |
| **File path** | Each inline comment prefixed with `📄 File: path/to/file.ts` |
| **Noise domains** | Social sharing links (Twitter, Reddit, LinkedIn, CodeAnt) stripped |
| **Thread resolution** | `pr-resolve` closes threads via `resolveReviewThread` mutation |
| **Auto-resolve** | `--auto` detects addressed threads via `isOutdated` + suggestion matching |
| **Agent tagging** | `--tag-agents` posts a configurable @mention comment after resolving |

---

## Requirements

- Node.js ≥ 20
- [pnpm](https://pnpm.io) (or npm / yarn)
- [gh CLI](https://cli.github.com) authenticated: `gh auth login`

---

## Installation

```bash
git clone https://github.com/YosefHayim/pr-prism
cd pr-prism
pnpm install
```

---

## Usage

### `pr-review` — scrape review comments

```bash
pnpm run pr-review                        # detect repo, list open PRs, interactive select
pnpm run pr-review -- 42                  # process PR #42 directly
pnpm run pr-review -- <url>               # process by full GitHub PR URL
```

### `pr-resolve` — resolve threads + tag agents

```bash
pnpm run pr-resolve                       # resolve threads from latest .threads-*.json
pnpm run pr-resolve -- 42                 # explicit PR number
pnpm run pr-resolve -- 42 --dry-run       # preview what would be resolved
pnpm run pr-resolve -- 42 --tag-agents    # resolve + post @mention comment
pnpm run pr-resolve -- 42 --tag-agents --comment "Fixed in abc123"
pnpm run pr-resolve -- 42 --unresolve     # re-open threads if needed
```

### `pr-resolve --auto` — smart auto-resolve

```bash
pnpm run pr-resolve -- 42 --auto              # auto-resolve addressed threads only
pnpm run pr-resolve -- 42 --auto --dry-run    # preview what would be resolved
pnpm run pr-resolve -- 42 --auto --tag-agents # auto-resolve + tag agents for re-review
```

Auto-resolve re-fetches live thread state from GitHub and resolves only threads where:
- **Lines changed** — GitHub marks the thread as `isOutdated` (commented lines were modified)
- **Suggestion applied** — a `` ```suggestion `` block in the comment matches the current file content

Threads without a strong signal are skipped. A summary comment is posted on the PR with counts per category.

---

## Output

| File | Description |
|---|---|
| `pr-reviews/new-<timestamp>.md` | New actionable comments since last run |
| `pr-reviews/.scraped-ids.json` | Persistent ID cache — **commit this file** |
| `pr-reviews/.threads-<pr>.json` | Thread IDs consumed by `pr-resolve` |

---

## The AI Agent Loop

```
1.  pnpm run pr-review -- <PR number>
        → pr-reviews/new-<timestamp>.md  (new comments only)
        → pr-reviews/.threads-<pr>.json  (thread IDs for resolve)

2.  Agent reads the markdown, implements fixes, commits, pushes

3.  pnpm run pr-resolve -- <PR number> --auto --tag-agents
        → Re-fetches live thread state from GitHub
        → Auto-resolves: isOutdated threads + matched suggestions
        → Posts: "Auto-resolved 6/8 threads. 2 remain."
        → Tags agents for re-review

4.  Repeat from step 1 — only new reviewer replies appear
```

---

## Config (`.pr-prism.json`)

Create `.pr-prism.json` in your repo root to customise agent mentions without editing source:

```json
{
  "agentMentions": ["cubic-dev-ai", "coderabbitai"]
}
```

---

## Extending the bot list

Edit `KNOWN_BOTS` at the top of `scripts/scrape-pr-reviews.ts`:

```ts
const KNOWN_BOTS = ["github-actions", "dependabot", "coderabbitai", "changeset-bot", "codeantai"];
```

## Adding noise domains

Edit `NOISE_DOMAINS` in the same file:

```ts
const NOISE_DOMAINS = [
  "twitter.com/intent", "x.com/intent",
  "reddit.com/submit",
  "linkedin.com/sharing",
  "app.codeant.ai", "codeant.ai/feedback",
];
```

---

## License

MIT
