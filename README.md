# pr-prism

<div align="center">

[![npm version](https://img.shields.io/npm/v/pr-prism)](https://www.npmjs.com/package/pr-prism)
[![npm downloads](https://img.shields.io/npm/dm/pr-prism)](https://www.npmjs.com/package/pr-prism)
[![CI](https://github.com/YosefHayim/pr-prism/actions/workflows/ci.yml/badge.svg)](https://github.com/YosefHayim/pr-prism/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Contributors Welcome](https://img.shields.io/badge/contributors-welcome-brightgreen.svg)](https://github.com/YosefHayim/pr-prism/issues)

> Stateful GitHub PR review scraper for AI agent workflows. Filter noise, cache seen comments, deliver signal.

</div>

---

AI agents re-reading the same resolved comments, outdated threads, and bot spam on every loop — wasting tokens and losing context. pr-prism solves this with two commands: scrape only what's new, then resolve what's been addressed.

## Why

AI coding agents loop on PR review comments — re-reading the same resolved threads, outdated feedback, and bot noise on every iteration. This wastes tokens and loses context fast.

pr-prism solves this with two focused commands: scrape only what's new since the last run, then auto-resolve threads that have been addressed. Your agent gets clean signal, not stale noise.

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

PRs and issues welcome. Fork the repo, create a feature branch, and open a pull request.

---

## License

MIT
