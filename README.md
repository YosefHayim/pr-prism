# pr-prism

[![CI](https://github.com/YosefHayim/pr-prism/actions/workflows/ci.yml/badge.svg)](https://github.com/YosefHayim/pr-prism/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pr-prism)](https://www.npmjs.com/package/pr-prism)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Stateful GitHub PR review scraper for AI agent workflows. Filter noise, cache seen comments, deliver signal.

AI agents re-reading the same resolved comments, outdated threads, and bot spam on every loop — wasting tokens and losing context. pr-prism solves this with two commands: scrape only what's new, then resolve what's been addressed.

---

## Requirements

- Node.js ≥ 20
- [gh CLI](https://cli.github.com) authenticated (`gh auth login`)

---

## Installation

**One-time use (no install):**
```bash
npx pr-prism pr-review -- 42
```

**Global install:**
```bash
npm install -g pr-prism
```

**Local to your project:**
```bash
npm install --save-dev pr-prism
```

---

## Usage

### `pr-review` — scrape new comments

```bash
pr-review                  # list open PRs, pick interactively
pr-review 42               # process PR #42 directly
pr-review <url>            # process by full GitHub PR URL
```

On first run, automatically appends output patterns to your `.gitignore`.

### `pr-resolve` — resolve threads

```bash
pr-resolve 42                               # resolve all threads from last scrape
pr-resolve 42 --auto                        # smart resolve: addressed threads only
pr-resolve 42 --auto --dry-run              # preview what would be resolved
pr-resolve 42 --auto --tag-agents           # resolve + tag agents for re-review
pr-resolve 42 --tag-agents --comment "msg"  # custom message
pr-resolve 42 --unresolve                   # re-open resolved threads
```

**`--auto` detection signals:**
- `isOutdated` — GitHub detected the commented lines were changed
- Suggestion applied — `` ```suggestion `` block content found in current file at HEAD

Skips threads with no signal. Posts a summary comment on the PR.

---

## The Agent Loop

```
1. pr-review 42
   → pr-reviews/new-<timestamp>.md   (new comments only)

2. Agent reads markdown, implements fixes, commits, pushes

3. pr-resolve 42 --auto --tag-agents
   → Auto-resolves addressed threads
   → Posts: "Auto-resolved 6/8 threads. 2 remain."
   → Tags agents for re-review

4. Repeat — only new replies appear
```

---

## Output Files

| File | Description |
|---|---|
| `pr-reviews/new-<timestamp>.md` | New actionable comments since last run |
| `pr-reviews/.scraped-ids.json` | Persistent ID cache — **commit this** |
| `pr-reviews/.threads-<pr>.json` | Thread IDs for `pr-resolve` |

---

## Config

Copy `.pr-prism.example.json` to `.pr-prism.json` in your repo root:

```json
{
  "agentMentions": ["cubic-dev-ai", "coderabbitai"]
}
```

`agentMentions` — GitHub handles (without `@`) tagged in the post-resolve comment. Defaults to `["cubic-dev-ai"]`.

---

## What Gets Filtered

| Signal | Behaviour |
|---|---|
| Already-seen comment ID | Silently skipped |
| Resolved thread | Skipped + cached |
| Bot author (`[bot]`, `KNOWN_BOTS`) | Skipped + cached |
| Outdated thread | Shown with `⚠️ OUTDATED` warning |
| Social sharing links | Stripped from body |
| `` ```suggestion `` blocks | Rendered as `diff` |

---

## Contributing

Contributions are welcome! Bug reports, feature requests, and PRs are all appreciated.

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
4. Open a PR against `main`

---

## License

MIT
