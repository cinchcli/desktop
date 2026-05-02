# Fuzzy Search + Sans-Serif Search Input — Design

**Status:** Draft, awaiting review
**Date:** 2026-05-02
**Branch:** `ui/editorial-redesign`

## Goal

1. Replace exact-token (FTS5) search with **frontend fuzzy matching** so users get fzf-style results from partial / mistyped input.
2. Switch the search inputs (dashboard `SearchBar` and `LocalOnlyView`) from Lyon serif back to **sans-serif** (`var(--font-body)`).

Out of scope (deferred per user): per-machine filter chips in Inbox.

## Architecture

### Search data flow — before

```
SearchBar input → debouncedQuery → refreshClips() →
  if query non-empty: commands.searchClips(query, 100)   ← FTS5 MATCH
  if query empty:    commands.listClips(source, _, 100)
```

### Search data flow — after

```
SearchBar input → debouncedQuery → refreshClips() →
  always: commands.listClips(source, _, 500)             ← raw recent clips
fuzzy(clips, query, nicknameMap) in useMemo →
  filteredClips → ClipList
```

The Tauri `searchClips` command is kept on the backend (CLI may use it later) but no longer called from the desktop frontend. `listClips` cap is bumped from 100 → 500 to widen the searchable window. Pinned panel fuzz uses the same library against `listPinnedClips()` results.

### Library: `uFuzzy`

- Bundle: ~3 KB gzipped (well under our 87 KB current).
- Multi-term, character-skip matching (fzf-style).
- Returns matched indexes + score; we filter to score > threshold and sort by score, then by `created_at` desc as a tiebreaker.
- `npm i @leeoniya/ufuzzy`. No build-time native deps.

### Match scope

- **Content** (the clip body, primary signal).
- **Nickname-resolved source** (so typing `mbp` finds clips from a device whose nickname is "MBP-Pro" — same model the `from:` token already uses).
- **Pin note** for the Pinned panel only.

`from:<nickname>` token continues to work and short-circuits fuzzy: the token is parsed out of the query first, the remaining string is fuzz-matched.

### Fuzzy module

New file: `src/lib/fuzzy.ts` exporting:

```ts
export interface FuzzyTarget {
  id: string;
  haystack: string;     // pre-joined content + " " + nickname (+ pin_note)
  clip: LocalClip;
}

export function buildTargets(
  clips: LocalClip[],
  nicknameBySource: Record<string, string>,
  includePinNote?: boolean,
): FuzzyTarget[];

export function fuzzyFilter(
  targets: FuzzyTarget[],
  query: string,
): LocalClip[];   // ranked, threshold-applied
```

Pure functions. Unit tested.

### Empty-query behavior

- No fuzzy invocation; render `clips` as-is, sorted by `created_at` desc (current behavior).
- Selecting an empty query immediately after typing stays smooth because `useMemo` short-circuits when query is empty.

### Performance

500 clips × ~200 char content = ~100 KB of strings. uFuzzy search on this size completes in <2 ms. We re-fuzz only when `debouncedQuery` or `clips` changes.

## Visual change — search input font

**Before:** `fontFamily: var(--font-serif)` (Newsreader/Lyon).
**After:** `fontFamily: var(--font-body)` (SF Pro Display).

Files:
- `src/components/SearchBar.tsx` (style `S.input.fontFamily`)
- `src/components/LocalOnlyView.tsx` (style `S.searchInput.fontFamily`)

The serif label "From" / placeholder copy was a stylistic choice; the spec will need a small amendment.

## Spec amendment (`docs/superpowers/specs/2026-05-01-ui-redesign-design.md`)

§7.4 currently reads "Lyon serif placeholder." Update to: "sans-serif placeholder (matches body type), single line, ⌘F focuses, Esc clears."

§5 Typography table: add a footnote that search inputs use body sans-serif rather than serif (the serif title role is reserved for clip detail headings, auth screens, settings sections, and empty states).

## Acceptance criteria

1. Typing `pas` finds clips containing `password`, `paste`, `passcode` (fzf-style character-skip).
2. Typing `mbp` filters to clips whose source device nickname matches "MBP" (case-insensitive substring or fuzzy).
3. `from:laptop hello` parses `from:laptop`, then fuzzy-matches `hello` over the remaining content.
4. Empty query returns the full inbox unchanged.
5. Search inputs render in sans-serif (`var(--font-body)`).
6. All 81 existing tests pass; new tests cover `buildTargets` and `fuzzyFilter` (≥ 6 cases: empty query, exact match, character-skip match, nickname match, score ranking, threshold filtering).

## Out of scope

- Per-machine filter chips above the inbox list (deferred — the `from:` token + Ctrl+H/L cycling already covers this for power users).
- Backend FTS5 changes. The `searchClips` Rust command is unchanged and unused from desktop frontend, but kept available for the CLI / future clients.
- Highlighting matched characters in clip rows. Possible follow-up — uFuzzy returns the match indexes, so we have the data; we just won't render it yet.

## Risks

- **500-clip cap**: a clip older than the most recent 500 is invisible to search. Acceptable — power users with deeper history can use the CLI's `cinch pull`. Bumping further trades memory for completeness; revisit if real users hit this.
- **Nickname collisions**: two devices with identical nicknames will be ambiguous in `from:` token results. Already a pre-existing condition; unchanged by this work.
