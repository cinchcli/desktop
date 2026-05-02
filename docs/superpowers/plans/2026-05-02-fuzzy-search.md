# Fuzzy Search + Sans-Serif Search Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the FTS5-backed desktop search with frontend uFuzzy ranking over a 500-clip local window, and switch search inputs from Lyon serif to body sans-serif.

**Architecture:** Pure frontend change. New `src/lib/fuzzy.ts` module. `App.tsx` calls `commands.listClips(source, _, 500)` unconditionally (drops `commands.searchClips`), then runs uFuzzy in a `useMemo` keyed on `(clips, debouncedQuery, nicknameBySource)`. `from:<nick>` token is parsed off the query first; remaining string is fuzz-matched. No backend change.

**Tech Stack:** TypeScript 5.8, React 19, Vite 7, Vitest 2, `@leeoniya/ufuzzy` (~3 KB gzip).

**Reference spec:** `docs/superpowers/specs/2026-05-02-fuzzy-search-design.md`

---

## File Map

**New files:**
- `desktop/src/lib/fuzzy.ts` — pure functions: `buildTargets`, `parseFromToken`, `fuzzySearch`
- `desktop/src/lib/fuzzy.test.ts` — vitest unit tests

**Modified files:**
- `desktop/package.json` — add `@leeoniya/ufuzzy` dependency
- `desktop/src/App.tsx` — drop `searchClips` call; bump `listClips` cap to 500; add fuzzy `useMemo`; route both inbox + pinned panels through it
- `desktop/src/components/SearchBar.tsx` — `fontFamily` of search input: `var(--font-serif)` → `var(--font-body)`
- `desktop/src/components/LocalOnlyView.tsx` — same swap on its `searchInput` style entry
- `desktop/docs/superpowers/specs/2026-05-01-ui-redesign-design.md` — §7.4 wording: "Lyon serif placeholder" → "sans-serif placeholder (matches body type)"; §5 add a footnote

---

## Task 1 — Install uFuzzy + write `fuzzy.ts` (TDD)

**Files:**
- Modify: `desktop/package.json`
- Create: `desktop/src/lib/fuzzy.ts`
- Create: `desktop/src/lib/fuzzy.test.ts`

- [ ] **Step 1.1: Install `@leeoniya/ufuzzy`**

```bash
cd desktop
npm install @leeoniya/ufuzzy
```

Verify: `package.json` shows `"@leeoniya/ufuzzy": "^1.x.x"` in `dependencies`.

- [ ] **Step 1.2: Write the test file first (TDD)**

Create `desktop/src/lib/fuzzy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LocalClip } from '../bindings';
import { buildTargets, fuzzySearch, parseFromToken } from './fuzzy';

function clip(partial: Partial<LocalClip>): LocalClip {
  return {
    id: partial.id ?? 'id',
    user_id: partial.user_id ?? 'u',
    content: partial.content ?? '',
    content_type: partial.content_type ?? 'text',
    source: partial.source ?? 'local',
    label: partial.label ?? '',
    byte_size: partial.byte_size ?? 0,
    media_path: partial.media_path ?? null,
    created_at: partial.created_at ?? 0,
    ttl: partial.ttl ?? 0,
    synced: partial.synced ?? true,
    is_pinned: partial.is_pinned ?? false,
    pin_note: partial.pin_note ?? null,
  };
}

describe('parseFromToken', () => {
  it('extracts from:nickname and returns the residual query', () => {
    expect(parseFromToken('from:laptop hello world')).toEqual({
      from: 'laptop',
      residual: 'hello world',
    });
  });

  it('returns null from when no token present', () => {
    expect(parseFromToken('hello world')).toEqual({
      from: null,
      residual: 'hello world',
    });
  });

  it('handles trailing/leading whitespace in residual', () => {
    expect(parseFromToken('  hello  from:mbp  there  ')).toEqual({
      from: 'mbp',
      residual: 'hello there',
    });
  });

  it('is case-insensitive on the token name', () => {
    expect(parseFromToken('FROM:Laptop x')).toEqual({
      from: 'Laptop',
      residual: 'x',
    });
  });
});

describe('buildTargets', () => {
  it('joins content + nickname into haystack', () => {
    const c = clip({ id: '1', content: 'hello', source: 'remote:mbp' });
    const targets = buildTargets([c], { 'remote:mbp': 'MBP-Pro' });
    expect(targets).toHaveLength(1);
    expect(targets[0].haystack).toContain('hello');
    expect(targets[0].haystack).toContain('MBP-Pro');
  });

  it('includes pin_note when includePinNote is true', () => {
    const c = clip({ id: '1', content: 'body', pin_note: 'launch codes' });
    const [t] = buildTargets([c], {}, true);
    expect(t.haystack).toContain('launch codes');
  });

  it('omits pin_note when includePinNote is false (default)', () => {
    const c = clip({ id: '1', content: 'body', pin_note: 'launch codes' });
    const [t] = buildTargets([c], {});
    expect(t.haystack).not.toContain('launch codes');
  });
});

describe('fuzzySearch', () => {
  const targets = buildTargets(
    [
      clip({ id: 'a', content: 'my password is hunter2', source: 'remote:mbp' }),
      clip({ id: 'b', content: 'paste this into terminal', source: 'remote:linux-box' }),
      clip({ id: 'c', content: 'unrelated banana', source: 'local' }),
    ],
    { 'remote:mbp': 'MBP-Pro', 'remote:linux-box': 'tux' },
  );

  it('returns all clips when query is empty', () => {
    expect(fuzzySearch(targets, '').map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('matches substrings in content', () => {
    const ids = fuzzySearch(targets, 'pass').map(c => c.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('c');
  });

  it('matches against device nickname', () => {
    const ids = fuzzySearch(targets, 'tux').map(c => c.id);
    expect(ids).toEqual(['b']);
  });

  it('returns empty array when nothing matches', () => {
    expect(fuzzySearch(targets, 'xyzzy')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const ids = fuzzySearch(targets, 'PASTE').map(c => c.id);
    expect(ids).toContain('b');
  });
});
```

- [ ] **Step 1.3: Run the failing test**

Run: `npm test -- --run src/lib/fuzzy.test.ts`
Expected: FAIL — module `./fuzzy` does not exist.

- [ ] **Step 1.4: Implement `fuzzy.ts`**

Create `desktop/src/lib/fuzzy.ts`:

```ts
import uFuzzy from '@leeoniya/ufuzzy';
import type { LocalClip } from '../bindings';

export interface FuzzyTarget {
  clip: LocalClip;
  haystack: string;
}

const FROM_TOKEN_RE = /\bfrom:(\S+)/i;

export interface ParsedQuery {
  from: string | null;
  residual: string;
}

export function parseFromToken(query: string): ParsedQuery {
  const m = query.match(FROM_TOKEN_RE);
  if (!m) return { from: null, residual: query.trim() };
  const residual = query.replace(FROM_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  return { from: m[1], residual };
}

export function buildTargets(
  clips: LocalClip[],
  nicknameBySource: Record<string, string>,
  includePinNote = false,
): FuzzyTarget[] {
  return clips.map((clip) => {
    const nickname = nicknameBySource[clip.source] ?? '';
    const sourceTail = clip.source.startsWith('remote:')
      ? clip.source.slice('remote:'.length)
      : clip.source;
    const note = includePinNote && clip.pin_note ? clip.pin_note : '';
    return {
      clip,
      haystack: [clip.content, nickname, sourceTail, note]
        .filter((s) => s.length > 0)
        .join('  '),
    };
  });
}

const fuzz = new uFuzzy({
  intraMode: 1, // tolerate one typo per term
  intraIns: 1,  // one skipped char per term (fzf-lite)
});

export function fuzzySearch(targets: FuzzyTarget[], query: string): LocalClip[] {
  const trimmed = query.trim();
  if (!trimmed) return targets.map((t) => t.clip);

  const haystacks = targets.map((t) => t.haystack);
  const idxs = fuzz.filter(haystacks, trimmed);
  if (!idxs || idxs.length === 0) return [];

  const info = fuzz.info(idxs, haystacks, trimmed);
  const order = fuzz.sort(info, haystacks, trimmed);
  return order.map((rank) => targets[info.idx[rank]].clip);
}
```

- [ ] **Step 1.5: Run the tests**

Run: `npm test -- --run src/lib/fuzzy.test.ts`
Expected: PASS — all 11 cases green.

- [ ] **Step 1.6: Run the full suite + build**

Run: `npm test -- --run`
Expected: 14 → 15 test files; total tests 81 → 92.

Run: `npm run build`
Expected: clean, bundle stays well under 350 KB.

- [ ] **Step 1.7: Commit**

```bash
cd desktop
git add package.json package-lock.json src/lib/fuzzy.ts src/lib/fuzzy.test.ts
git commit -m "feat(search): fuzzy module with uFuzzy + from: token parsing"
```

---

## Task 2 — Wire fuzzy into `App.tsx`

**Files:**
- Modify: `desktop/src/App.tsx`

This task replaces the FTS5 round-trip with a local fuzzy filter. The existing `from:` token logic moves into `parseFromToken`; the residual string is used for fuzzy matching.

- [ ] **Step 2.1: Bump `listClips` cap and drop the `searchClips` branch in `refreshClips`**

Open `desktop/src/App.tsx`. Find `refreshClips` (around line 115). The current body is:

```ts
const refreshClips = useCallback(async () => {
  try {
    if (activePanel === 'pinned') {
      const pinned = await unwrap(commands.listPinnedClips());
      const q = debouncedQuery.trim().toLowerCase();
      setClips(q
        ? pinned.filter(
            c => c.content.toLowerCase().includes(q) || c.pin_note?.toLowerCase().includes(q),
          )
        : pinned);
      return;
    }
    if (debouncedQuery.trim()) {
      const results = await unwrap(commands.searchClips(debouncedQuery, 100));
      const filtered = selectedSource ? results.filter((c) => c.source === selectedSource) : results;
      setClips(filtered);
    } else {
      const results = await unwrap(commands.listClips(selectedSource, null, 100));
      setClips(results);
    }
  } catch (e) {
    console.error('failed to load clips:', e);
  }
}, [activePanel, debouncedQuery, selectedSource]);
```

Replace with (substring filtering moves out of refreshClips entirely; we keep one fetch path per panel):

```ts
const refreshClips = useCallback(async () => {
  try {
    if (activePanel === 'pinned') {
      const pinned = await unwrap(commands.listPinnedClips());
      setClips(pinned);
      return;
    }
    const results = await unwrap(commands.listClips(selectedSource, null, 500));
    setClips(results);
  } catch (e) {
    console.error('failed to load clips:', e);
  }
}, [activePanel, selectedSource]);
```

Note the dependency array drops `debouncedQuery` — refetching on every keystroke is no longer needed since fuzzy runs in-memory.

- [ ] **Step 2.2: Replace the `from:` parsing block + `filteredClips` `useMemo` with the fuzzy version**

Find the existing block (around lines 301–318):

```ts
// from: token parsing for device-scoped clip filtering (T3-04)
const fromMatch = searchQuery.match(/from:(\S+)/i);
const sourceFilterToken = fromMatch ? fromMatch[1] : null;
const sourceFilter = useMemo(() => {
  if (!sourceFilterToken) return null;
  const nick = sourceFilterToken.toLowerCase();
  const matched = devices.find(
    d => (d.nickname?.toLowerCase() === nick) || (d.hostname?.toLowerCase() === nick)
  );
  return matched ? matched.source_key : '__no_match__';
}, [sourceFilterToken, devices]);

// Apply from: filter to clip list
const filteredClips = useMemo(() => {
  if (!sourceFilter) return clips;
  if (sourceFilter === '__no_match__') return [];
  return clips.filter(c => c.source === sourceFilter);
}, [clips, sourceFilter]);
```

Replace with:

```ts
// Parse from:<nickname> + residual fuzzy term
const parsed = useMemo(() => parseFromToken(debouncedQuery), [debouncedQuery]);

const sourceFilter = useMemo(() => {
  if (!parsed.from) return null;
  const nick = parsed.from.toLowerCase();
  const matched = devices.find(
    d => (d.nickname?.toLowerCase() === nick) || (d.hostname?.toLowerCase() === nick),
  );
  return matched ? matched.source_key : '__no_match__';
}, [parsed.from, devices]);

const filteredClips = useMemo(() => {
  // 1. Apply source filter (from:<nickname>)
  let pool = clips;
  if (sourceFilter === '__no_match__') return [];
  if (sourceFilter) pool = pool.filter(c => c.source === sourceFilter);

  // 2. Fuzzy-rank the residual query against content + nickname
  const targets = buildTargets(pool, nicknameBySource, activePanel === 'pinned');
  return fuzzySearch(targets, parsed.residual);
}, [clips, sourceFilter, parsed.residual, nicknameBySource, activePanel]);
```

Note: `parsed.residual` is used as the fuzzy term (so `from:laptop hello` correctly fuzzes only `hello`). For the Pinned panel, `includePinNote` is true so pin notes are searchable.

- [ ] **Step 2.3: Add the imports**

Near the top of `App.tsx`, with the other `./lib/*` imports:

```ts
import { buildTargets, fuzzySearch, parseFromToken } from './lib/fuzzy';
```

- [ ] **Step 2.4: Verify nothing else references the old `fromMatch` / `sourceFilterToken` symbols**

Run: `grep -n "fromMatch\|sourceFilterToken" desktop/src/App.tsx`
Expected: no matches (they were only used by the removed block).

- [ ] **Step 2.5: Run all tests**

Run: `cd desktop && npm test -- --run`
Expected: 92/92 green. App.test.tsx may need a small update if it asserts something tied to the old `searchClips` Tauri call — check, and if it does, update the assertion to verify fuzzy filtering works against the in-memory `clips` state. (Most existing assertions test rendering and DOM behavior, not the network path, so likely no change needed.)

If a test relies on `commands.searchClips` being called, update it: the new behavior is that `commands.listClips(_, _, 500)` is called once and the search input filters in-memory.

- [ ] **Step 2.6: Build**

Run: `cd desktop && npm run build`
Expected: clean.

- [ ] **Step 2.7: Commit**

```bash
cd desktop
git add src/App.tsx
git commit -m "feat(search): fuzzy filter on local 500-clip window

Drops the FTS5 round-trip. listClips fetches up to 500 clips, then
useMemo runs uFuzzy over (content + nickname + pin_note) keyed on
the debounced query. from:<nickname> token is parsed off first; its
residual is the fuzz term."
```

---

## Task 3 — Sans-serif search inputs

**Files:**
- Modify: `desktop/src/components/SearchBar.tsx`
- Modify: `desktop/src/components/LocalOnlyView.tsx`

- [ ] **Step 3.1: `SearchBar.tsx` — swap input font to body sans**

Open `desktop/src/components/SearchBar.tsx`. Find the `S.input` style entry (around line 74). Change:

```ts
fontFamily: 'var(--font-serif)',
```

to:

```ts
fontFamily: 'var(--font-body)',
```

If the placeholder text styling is set separately (e.g. via a `::placeholder` rule injected elsewhere), verify it inherits. Currently no separate placeholder rule — the input's font-family applies to placeholder by default.

- [ ] **Step 3.2: `LocalOnlyView.tsx` — swap its searchInput font**

Open `desktop/src/components/LocalOnlyView.tsx`. Find `S.searchInput` (around line 372). Change:

```ts
fontFamily: "var(--font-serif)",
```

to:

```ts
fontFamily: 'var(--font-body)',
```

- [ ] **Step 3.3: Verify no other search-input fields reference serif**

Run: `grep -RIn --include='*.ts*' "var(--font-serif)" desktop/src/components/SearchBar.tsx desktop/src/components/LocalOnlyView.tsx`
Expected: no matches.

- [ ] **Step 3.4: Run tests + build**

Run: `cd desktop && npm test -- --run`
Run: `cd desktop && npm run build`

LocalOnlyView's existing test suite asserts the input renders and accepts typing — these should keep passing. If any visual assertion checks the literal `var(--font-serif)`, update to `var(--font-body)`.

- [ ] **Step 3.5: Commit**

```bash
cd desktop
git add src/components/SearchBar.tsx src/components/LocalOnlyView.tsx
git commit -m "ui: search inputs use body sans-serif (was Lyon serif)"
```

---

## Task 4 — Spec amendment

**Files:**
- Modify: `desktop/docs/superpowers/specs/2026-05-01-ui-redesign-design.md`

- [ ] **Step 4.1: Update §7.4 SearchBar wording**

Open `docs/superpowers/specs/2026-05-01-ui-redesign-design.md`. Find §7.4 (around line 165). Find the line that says "Lyon serif placeholder." Change to:

```
- **Sans-serif placeholder** (matches body type). Single line. ⌘F focuses, Esc clears.
```

If the surrounding paragraph mentions Lyon/Newsreader for the placeholder font specifically, rewrite that sentence to reference sans body type instead. Do not touch any other §7.4 line.

- [ ] **Step 4.2: Add §5 Typography footnote**

Find §5 Typography (around line 90). At the end of the section, add a new bullet:

```
- *Search inputs* use body sans-serif (`var(--font-body)`); the serif role is reserved for clip detail titles, auth-screen headings, settings section labels, and empty-state headings.
```

- [ ] **Step 4.3: Commit**

```bash
cd desktop
git add docs/superpowers/specs/2026-05-01-ui-redesign-design.md
git commit -m "docs: spec — search inputs are sans-serif, not Lyon"
```

---

## Task 5 — Acceptance check

- [ ] **Step 5.1: Manual check**

Run `cd desktop && npm run tauri:dev`. With at least one clip containing "password" and one device with a nickname:

| Action | Expected |
|---|---|
| Type `pas` in search | Clips with "password" / "paste" appear, ranked. |
| Type `pwd` (character-skip) | Clips with "password" appear (uFuzzy `intraIns: 1`). |
| Type `<nickname>` | Clips from that machine appear. |
| Type `from:<nickname>` | Same — token form still works. |
| Type `from:<nickname> hello` | Source-scoped + fuzz `hello` only. |
| Empty query | Full inbox shows. |
| Search inputs render in SF Pro (sans), not Lyon serif. | |
| Pinned panel: type a pin-note word | Matches by note. |

- [ ] **Step 5.2: Final-suite green**

```bash
cd desktop && npm test -- --run && npm run build
```

Expected: 92/92 tests pass, build clean.

- [ ] **Step 5.3: Final commit if any tweaks**

If any small fixes surfaced during 5.1, bundle them into a single commit:

```bash
git add -p && git commit -m "search: acceptance polish"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| §Goal — fuzzy + sans-serif inputs | T1, T2, T3 |
| §Architecture — listClips 500 + uFuzzy useMemo | T2 |
| §Library — uFuzzy install | T1.1 |
| §Match scope — content + nickname + pin_note | T1 (`buildTargets`) |
| §Empty-query — pass-through | T1 (`fuzzySearch` early return) |
| §Spec amendment — §7.4 + §5 footnote | T4 |
| §Acceptance — 6 criteria | T5.1 |
| §Out of scope — per-machine chips, FTS5 changes | (no task — confirmed deferred) |

All sections have a task.

**Placeholder scan:** none; every step has concrete code/commands.

**Type/name consistency:** `parseFromToken`, `buildTargets`, `fuzzySearch`, `FuzzyTarget`, `ParsedQuery`. All used identically across T1 (definition + tests) and T2 (consumer in App.tsx).

**Scope:** single coherent change — frontend search rewrite + small font swap + spec amendment. ~25 steps, mostly mechanical, with one TDD module.
