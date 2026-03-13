# pr-prism

> Filter the noise. Focus on what matters.

**pr-prism** is a stateful GitHub PR review scraper built for AI agent workflows. It fetches review comments directly via the GitHub GraphQL API, filters out bots and noise, and emits only what's actionable — once per comment, forever cached.

---

## The Problem

Running an AI agent in a PR-fix loop has one brutal problem: **statefulness**.

Every re-run, the agent re-reads the same resolved comments, outdated threads, and bot spam — wasting tokens, inflating context, and confusing what actually needs fixing right now.

## The Solution

pr-prism solves this with a simple **ID cache**. Once a comment ID is processed, it's written to `pr-reviews/.scraped-ids.json`. Re-runs skip everything already seen and emit only what's new.

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

```bash
# List open PRs interactively (arrow-key select)
pnpm run pr-review

# Process a specific PR by number
pnpm run pr-review -- 42

# Process by full GitHub PR URL
pnpm run pr-review -- https://github.com/owner/repo/pull/42
```

---

## Output

| File | Description |
|---|---|
| `pr-reviews/new-<timestamp>.md` | New actionable comments since last run |
| `pr-reviews/.scraped-ids.json` | Persistent ID cache — **commit this file** |

The output file is clean Markdown. Pipe it to any AI agent, paste it into a chat window, or read it yourself.

---

## The AI Agent Loop

```
1.  pnpm run pr-review -- <PR number>
2.  Agent reads  pr-reviews/new-<timestamp>.md
3.  Agent implements fixes, commits, pushes
4.  Repeat from step 1
        → Only new reviewer replies appear each run
        → Resolved threads stay invisible
        → Bots stay out of the way
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
