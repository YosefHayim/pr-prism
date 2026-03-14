# Auto-Resolve Design — GitHub Signals + Suggestion Matching

**Date**: 2026-03-14
**Status**: Approved
**Approach**: B (GitHub-native signals + suggestion block comparison)

---

## Problem

`pr-resolve` resolves ALL threads from the sidecar indiscriminately. Agents must manually invoke it after pushing fixes, and every thread gets resolved regardless of whether the underlying comment was actually addressed. This creates noise — reviewers see resolved threads that weren't truly fixed, eroding trust.

## Solution

Extend `pr-resolve` with an `--auto` flag that re-fetches live thread state from GitHub, classifies each thread by confidence signals, and resolves only threads with strong evidence of being addressed. Posts a transparent summary comment on the PR.

## Detection Signals

### Signal 1: `isOutdated` (GitHub-native)

GitHub automatically sets `isOutdated: true` on a `PullRequestReviewThread` when the exact lines the comment refers to are modified by a subsequent commit. This is the primary, highest-confidence signal.

Additionally, when `line: null` on a thread (or `position: null` via REST), the diff can no longer anchor the comment — the code has changed enough that the comment's location is gone.

### Signal 2: Suggestion Matching

Review comments may contain ` ```suggestion ` blocks — explicit code change requests. After the agent pushes, fetch the current file content at HEAD and check if the suggested code is now present in the file. If all suggestion lines match, the comment was applied.

## Classification Buckets

| Bucket | Signal | Action |
|---|---|---|
| **auto-resolve** | `isOutdated: true` OR `line: null` | Resolve + tag as "lines changed" |
| **auto-resolve** | Has suggestion block AND content matches current file | Resolve + tag as "suggestion applied" |
| **skip** | None of the above | Leave unresolved, report count |

## Extended GraphQL Query

```graphql
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
}
```

Key additions vs current query: `headRefOid`, `path`/`line`/`originalLine` on thread, `outdated` on comment.

## Suggestion Matching Algorithm

1. Extract suggestion content from comment body using existing regex: `` /```suggestion\n([\s\S]*?)```/g ``
2. Fetch file at HEAD: `gh api repos/{owner}/{repo}/contents/{path}?ref={headSha}` — base64 decode response
3. Normalize both suggestion lines and file lines (trim whitespace, collapse spaces)
4. Check if suggestion lines appear as a contiguous block in the file
5. If ALL suggestion blocks in a comment match → thread is addressed

### Edge cases

- **Multiple suggestion blocks in one comment**: All must match for auto-resolve
- **Whitespace differences**: Normalize before comparing (trim, collapse)
- **File deleted**: Treat as addressed (the code was removed)
- **Partial application**: NOT handled — if agent applied 3 of 5 suggested lines, thread is not auto-resolved (conservative)
- **Reformatted suggestions**: NOT handled — exact content match only (conservative)

## Command Interface

```bash
# Existing (unchanged) — resolve ALL threads from sidecar
pnpm run pr-resolve -- 42

# NEW — smart auto-resolve
pnpm run pr-resolve -- 42 --auto

# Combine with existing flags
pnpm run pr-resolve -- 42 --auto --tag-agents
pnpm run pr-resolve -- 42 --auto --dry-run
pnpm run pr-resolve -- 42 --auto --tag-agents --comment "Fixes pushed"
```

When `--auto` is used:
- Sidecar file is **not required** — threads fetched directly from GitHub
- If sidecar exists, used as hint but GitHub's live state takes precedence
- `--dry-run` shows classification without mutating

## Summary Comment Format

Posted on the PR after auto-resolution:

```
:robot: **pr-prism auto-resolve** — 6 of 8 threads resolved

**Auto-resolved (lines changed):** 4 threads
**Auto-resolved (suggestion applied):** 2 threads
**Remaining (needs manual review):** 2 threads
```

When combined with `--tag-agents`, the agent mentions are appended to this comment instead of the existing default message.

## Data Flow

```
Agent pushes fixes
        |
        v
pr-resolve -- 42 --auto --tag-agents
        |
        +---> Fetch live threads from GitHub GraphQL
        |       (isOutdated, line, path, comments.body, headRefOid)
        |
        +---> For each unresolved thread:
        |       +-- isOutdated=true OR line=null?
        |       |     -> BUCKET: auto-resolve (lines changed)
        |       +-- Has suggestion block?
        |       |     -> Fetch file at HEAD, normalize, compare
        |       |     -> match? -> BUCKET: auto-resolve (suggestion applied)
        |       +-- Neither?
        |             -> BUCKET: skip
        |
        +---> Execute resolveReviewThread mutations for auto-resolve bucket
        |
        +---> Post summary comment on PR
        |
        +---> Tag agents if --tag-agents
```

## File Changes

| File | Change |
|---|---|
| `scripts/resolve-pr-threads.ts` | Add `--auto` flag, extended GraphQL query for auto mode, `classifyThreads()` function, `extractSuggestions()` function, `fetchFileAtHead()` function, `matchSuggestion()` function, summary comment logic |

No new files. No new dependencies. All logic fits in the existing resolve script (~80-100 lines added).

## Updated Agent Loop

```
1.  pnpm run pr-review -- <PR number>
        -> pr-reviews/new-<timestamp>.md  (new comments only)

2.  Agent reads the markdown, implements fixes, commits, pushes

3.  pnpm run pr-resolve -- <PR number> --auto --tag-agents
        -> Re-fetches live thread state from GitHub
        -> Auto-resolves: isOutdated threads + matched suggestions
        -> Posts: "Auto-resolved 6/8 threads. 2 remain."
        -> Tags agents for re-review

4.  Repeat from step 1 — only new reviewer replies appear
```
