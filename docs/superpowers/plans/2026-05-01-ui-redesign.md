# Cinch Desktop UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the Cinch desktop app to the editorial-light + editorial-dark sister theme, extract the 600-line `App.tsx` into focused components, and replace teal accent + Inter font with warm-monochrome tokens, Lyon/Newsreader serif, and SF Pro — without changing any keyboard shortcut or Tauri command/event behavior.

**Architecture:** Pure frontend redesign in `desktop/src/`. CSS custom properties carry both themes from `App.css`; the `C` token map in `design.ts` keeps its existing names (only the underlying CSS values change), so most components compile unmodified. `App.tsx` becomes a slim orchestrator delegating to `Rail`, `SearchBar`, `ClipList`, `ClipDetail`, `StatusBar`, `PinnedPanel`, `MachinesPanel`. No Tauri command, event, or backend file is touched.

**Tech Stack:** TypeScript 5.8, React 19, Vite 7, Vitest 2, Tauri 2. CSS custom properties (no CSS-in-JS framework). Inline `S: Record<string, React.CSSProperties>` style objects (existing convention).

**Reference spec:** `docs/superpowers/specs/2026-05-01-ui-redesign-design.md`

**Reference mockup:** `.superpowers/brainstorm/69739-1777614529/content/07-integrated-design.html` (gitignored — open at `http://localhost:58049` while server runs)

---

## File Map

**New files:**
- `src/components/Rail.tsx` — 56px icon rail (Inbox / Pinned / Machines / Settings)
- `src/components/SearchBar.tsx` — top search bar w/ Lyon serif placeholder + ⌘F kbd
- `src/components/ClipList.tsx` — 320px scrollable list with time-bucket section labels
- `src/components/ClipDetail.tsx` — Lyon-titled detail panel with action row
- `src/components/StatusBar.tsx` — bottom status bar (counts + kbd hints)
- `src/components/PinnedPanel.tsx` — Pinned tab content (master-detail filtered to pinned, grouped by note)
- `src/components/MachinesPanel.tsx` — Machines tab content (card grid, replaces `DeviceDashboard`)
- `src/lib/clipTitle.ts` — pure function generating mechanical clip titles
- `src/lib/timeBuckets.ts` — pure function grouping clips by `Today / Yesterday / This week / Older`
- `src/lib/sourceColor.ts` — deterministic hash → desaturated palette
- `src/lib/timeBuckets.test.ts`, `src/lib/clipTitle.test.ts`, `src/lib/sourceColor.test.ts`
- `src/components/Rail.test.tsx`, `src/components/ClipList.test.tsx`, `src/components/ClipDetail.test.tsx`

**Modified files:**
- `src/App.css` — full token rewrite (light + dark editorial palettes, font @font-face for Newsreader)
- `src/design.ts` — same `C` exports; only the CSS-var fallback strings change if needed
- `src/icons.tsx` — replace `IconPin` (pushpin), add `IconInbox` (tray w/ arrow), add `IconMonitor`. Keep `IconGear`, `IconSearch`, `IconX`, etc. unchanged.
- `src/App.tsx` — delegate rendering to extracted components; keep keyboard handler, auth gate, panel state
- `src/components/SourcePill.tsx` — accept optional `colorKey?: string`, route through `sourceColor.ts`
- `src/components/LocalOnlyView.tsx` — reskin (no structural change)
- `src/components/AddRelayDialog.tsx`, `AdoptedAuthToast.tsx`, `EmptyState.tsx`, `OfflineBar.tsx`, `UpgradePrompt.tsx`, `ClipCard.tsx` — reskin only
- `src/SettingsPane.tsx`, `src/RetentionSlider.tsx`, `src/ConfirmDialog.tsx` — reskin only
- `index.html` — add Newsreader font preload link

**Deleted files:**
- `src/components/DeviceDashboard.tsx` — superseded by `MachinesPanel.tsx`

---

## Task 1 — Foundation: CSS tokens + Newsreader font load

**Files:**
- Modify: `desktop/src/App.css` (full rewrite of `:root` and `html.light` blocks)
- Modify: `desktop/index.html` (add Google Fonts preconnect + Newsreader stylesheet link)
- Verify: `desktop/src/design.ts` (no source change needed; semantic names hold)

**Why first:** every later task references these tokens. Land them once and the rest of the work compiles against the new palette automatically.

- [ ] **Step 1.1: Add Newsreader font load to `index.html`**

Open `desktop/index.html`. Inside `<head>`, immediately after the `<title>` line, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet">
```

Newsreader is the Google-Fonts–served substitute for Lyon Text. Variable axis `opsz` 6-72, weights 400 + 500. We only use 400 in the redesign but include 500 in case future copy needs it.

- [ ] **Step 1.2: Update CSP in `tauri.conf.json` to allow Google Fonts**

Open `desktop/src-tauri/tauri.conf.json` line 28 (`"csp": "..."`). Append `https://fonts.googleapis.com` to `style-src` and `https://fonts.gstatic.com` to `font-src`. Final value:

```
"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' cinch: data: blob:; connect-src 'self' ipc: http://ipc.localhost; font-src 'self' data: https://fonts.gstatic.com"
```

- [ ] **Step 1.3: Rewrite the `:root` and `html.light` blocks in `App.css`**

Open `desktop/src/App.css`. Replace the entire `:root { ... }` block (currently lines 4-55) and the `html.light { ... }` block (currently lines 58-87) with this:

```css
:root {
  /* Typography */
  --font-body: 'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', ui-monospace, Menlo, Monaco, monospace;
  --font-serif: 'Newsreader', 'Lyon Text', Georgia, 'Times New Roman', serif;

  /* Surfaces — Dark Editorial (cream-tinted dark) */
  --bg:         #16140F;
  --surface:    #1E1A12;
  --surface-2:  rgba(237, 230, 214, 0.05);

  /* Interaction */
  --hover:    rgba(237, 230, 214, 0.04);
  --selected: rgba(237, 230, 214, 0.05);

  /* Borders */
  --border:       rgba(237, 230, 214, 0.08);
  --border-hover: rgba(237, 230, 214, 0.12);

  /* Text */
  --text-primary: #EDE6D6;
  --text-muted:   #9C9486;
  --text-faint:   #6A6357;
  --text-vfaint:  #3F3B33;

  /* Selection bar (left edge of selected row, active rail item) */
  --selection-bar: #EDE6D6;

  /* Accent — Porcelain Teal preserved only for offline pulse + focus rings */
  --accent:        #4FB3A9;
  --accent-muted:  #3E928A;
  --accent-subtle: rgba(79, 179, 169, 0.10);
  --accent-pastel: #BED9D7;
  --accent-on:     #16140F;

  /* Source-pill palette (dark theme, translucent cream-tints) */
  --pill-1-bg: rgba(190, 217, 215, 0.10);   --pill-1-fg: #BED9D7;  /* mint */
  --pill-2-bg: rgba(255, 200, 140, 0.10);   --pill-2-fg: #E8B98C;  /* amber */
  --pill-3-bg: rgba(180, 200, 230, 0.10);   --pill-3-fg: #B4C8E6;  /* sky */
  --pill-4-bg: rgba(220, 180, 230, 0.10);   --pill-4-fg: #DCB4E6;  /* lilac */
  --pill-5-bg: rgba(230, 180, 180, 0.10);   --pill-5-fg: #E6B4B4;  /* rose */
  --pill-6-bg: rgba(190, 220, 180, 0.10);   --pill-6-fg: #BEDCB4;  /* sage */
  --pill-local-bg: rgba(237, 230, 214, 0.06); --pill-local-fg: #9C9486;

  /* Semantic */
  --success: #34D399;
  --warning: #E8B98C;
  --error:   #FF6363;
  --info:    #B4C8E6;

  /* Spacing (8px base + 12) */
  --sp-2xs: 2px;
  --sp-xs:  4px;
  --sp-sm:  8px;
  --sp-md:  12px;
  --sp-lg:  16px;
  --sp-xl:  24px;
  --sp-2xl: 32px;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 10px;

  color-scheme: dark;
}

html.light {
  --bg:         #FBFBFA;
  --surface:    #FFFFFF;
  --surface-2:  #F7F6F3;

  --hover:    rgba(0, 0, 0, 0.02);
  --selected: #F7F6F3;

  --border:       #EAEAEA;
  --border-hover: rgba(0, 0, 0, 0.12);

  --text-primary: #2F3437;
  --text-muted:   #787774;
  --text-faint:   #B4B4B0;
  --text-vfaint:  #D8D8D4;

  --selection-bar: #2F3437;

  --accent:        #2F7F78;
  --accent-muted:  #1F5F59;
  --accent-subtle: rgba(47, 127, 120, 0.10);
  --accent-pastel: #BED9D7;
  --accent-on:     #FFFFFF;

  /* Light pill palette — desaturated pastels */
  --pill-1-bg: #EDF3EC;  --pill-1-fg: #346538;
  --pill-2-bg: #FBF3DB;  --pill-2-fg: #956400;
  --pill-3-bg: #E1F3FE;  --pill-3-fg: #1F6C9F;
  --pill-4-bg: #F3E5FB;  --pill-4-fg: #7C4FA0;
  --pill-5-bg: #FDEBEC;  --pill-5-fg: #9F2F2D;
  --pill-6-bg: #ECF4ED;  --pill-6-fg: #4A7A4A;
  --pill-local-bg: #F7F6F3; --pill-local-fg: #787774;

  --success: #16A34A;
  --warning: #CA8A04;
  --error:   #9F2F2D;
  --info:    #2563EB;

  color-scheme: light;
}
```

- [ ] **Step 1.4: Update `html` font stack and feature settings in `App.css`**

Replace the existing `html { ... }` block (currently lines 99-117) with:

```css
html {
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.55;
  font-weight: 400;
  color: var(--text-primary);
  background-color: transparent !important;

  font-feature-settings: 'kern' 1, 'liga' 1;

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
  border-radius: var(--radius-xl);
  overflow: hidden;
}
```

- [ ] **Step 1.5: Update kbd badge variables in `App.css`**

Replace the kbd-related blocks (currently lines 213-232) with theme-aware editorial variants:

```css
:root {
  --kbd-bg:     rgba(237, 230, 214, 0.04);
  --kbd-color:  #9C9486;
  --kbd-border: rgba(237, 230, 214, 0.08);
}
html.light {
  --kbd-bg:     #F7F6F3;
  --kbd-color:  #787774;
  --kbd-border: #EAEAEA;
}
```

Existing key-cap pseudo-3D shadows are dropped — editorial style uses flat 1px borders.

- [ ] **Step 1.6: Update retention slider focus ring color**

In `App.css`, find the `.retention-slider input[type="range"]:focus-visible::-webkit-slider-thumb` blocks (lines 198-205). Change ring colors from teal `rgba(79,179,169,...)` and `rgba(47,127,120,...)` to text-primary:

```css
.retention-slider input[type="range"]:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(237, 230, 214, 0.15),
              0 1px 2.377px rgba(0, 0, 0, 0.28);
}
html.light .retention-slider input[type="range"]:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px rgba(47, 51, 55, 0.10),
              0 1px 2.377px rgba(0, 0, 0, 0.28);
}
```

The `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` global rule (around line 142-145) stays as-is — accent on focus rings is allowed per spec section 4.

- [ ] **Step 1.7: Verify `design.ts` doesn't need changes**

Open `desktop/src/design.ts`. Confirm every `C.*` export still maps to a CSS variable defined in step 1.3. The existing names (`bg`, `card`, `card2`, `hover`, `selected`, `border`, `borderHover`, `t1`, `t2`, `t3`, `t4`, `accent`, etc.) are all preserved — only their CSS values changed. No code change needed.

- [ ] **Step 1.8: Build and verify dev server starts**

Run from `desktop/`:

```bash
npm run build
```

Expected: `vite build` completes with no TypeScript errors, no missing CSS variable warnings.

- [ ] **Step 1.9: Commit**

```bash
cd desktop
git add src/App.css src-tauri/tauri.conf.json index.html
git commit -m "ui: editorial light/dark tokens + Newsreader font

Replaces Porcelain Teal-accent palette with sister editorial themes —
warm bone (#FBFBFA) and warm cream-tinted dark (#16140F). Adds Newsreader
serif via Google Fonts (with Lyon Text fallback for licensed users).
Source-pill palette swaps in 6 desaturated hues + neutral local color.
Spacing/radii/kbd tokens updated. design.ts mapping preserved.

Refs: docs/superpowers/specs/2026-05-01-ui-redesign-design.md §4-§5"
```

---

## Task 2 — `sourceColor.ts`: deterministic source → palette index

**Files:**
- Create: `desktop/src/lib/sourceColor.ts`
- Create: `desktop/src/lib/sourceColor.test.ts`

- [ ] **Step 2.1: Write failing test**

Create `desktop/src/lib/sourceColor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sourcePillVars, PILL_PALETTE_SIZE } from './sourceColor';

describe('sourcePillVars', () => {
  it('returns local pill vars for "local"', () => {
    expect(sourcePillVars('local')).toEqual({
      bg: 'var(--pill-local-bg)',
      fg: 'var(--pill-local-fg)',
    });
  });

  it('returns one of the 6 palette slots for any non-local source', () => {
    const v = sourcePillVars('remote:prod-shell');
    const allowed = Array.from({ length: PILL_PALETTE_SIZE }, (_, i) => ({
      bg: `var(--pill-${i + 1}-bg)`,
      fg: `var(--pill-${i + 1}-fg)`,
    }));
    expect(allowed).toContainEqual(v);
  });

  it('is deterministic: same input → same slot', () => {
    expect(sourcePillVars('remote:prod-shell')).toEqual(sourcePillVars('remote:prod-shell'));
    expect(sourcePillVars('remote:macbook')).toEqual(sourcePillVars('remote:macbook'));
  });

  it('different inputs hash to (usually) different slots', () => {
    const slots = new Set([
      'remote:prod-shell',
      'remote:macbook',
      'remote:ci-runner-3',
      'remote:dev-laptop',
      'remote:staging',
    ].map(s => JSON.stringify(sourcePillVars(s))));
    expect(slots.size).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npm test -- sourceColor`
Expected: FAIL with `Cannot find module './sourceColor'` or similar.

- [ ] **Step 2.3: Implement `sourceColor.ts`**

Create `desktop/src/lib/sourceColor.ts`:

```ts
export const PILL_PALETTE_SIZE = 6;

export interface PillVars {
  bg: string;
  fg: string;
}

/**
 * Maps a clip source key to a CSS variable pair for its pill background and foreground.
 * `local` always returns the neutral pill. Remote sources hash deterministically into
 * one of PILL_PALETTE_SIZE color slots so the same machine always reads in the same color.
 */
export function sourcePillVars(source: string): PillVars {
  if (source === 'local') {
    return { bg: 'var(--pill-local-bg)', fg: 'var(--pill-local-fg)' };
  }
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  const slot = (hash % PILL_PALETTE_SIZE) + 1;
  return {
    bg: `var(--pill-${slot}-bg)`,
    fg: `var(--pill-${slot}-fg)`,
  };
}
```

- [ ] **Step 2.4: Run test, verify it passes**

Run: `npm test -- sourceColor`
Expected: PASS, all 4 tests green.

- [ ] **Step 2.5: Commit**

```bash
cd desktop
git add src/lib/sourceColor.ts src/lib/sourceColor.test.ts
git commit -m "ui: add deterministic source-color hash for pills"
```

---

## Task 3 — `timeBuckets.ts`: group clips by Today / Yesterday / This week / Older

**Files:**
- Create: `desktop/src/lib/timeBuckets.ts`
- Create: `desktop/src/lib/timeBuckets.test.ts`

- [ ] **Step 3.1: Write failing test**

Create `desktop/src/lib/timeBuckets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupByTimeBucket, type TimeBucket } from './timeBuckets';

const NOW = new Date('2026-05-01T12:00:00Z').getTime() / 1000;

const clip = (id: string, secondsAgo: number) => ({
  id,
  created_at: NOW - secondsAgo,
});

describe('groupByTimeBucket', () => {
  it('returns empty array for empty input', () => {
    expect(groupByTimeBucket([], NOW)).toEqual([]);
  });

  it('puts clips < 24h ago into Today', () => {
    const result = groupByTimeBucket([clip('a', 60), clip('b', 3600 * 5)], NOW);
    expect(result).toEqual([
      { bucket: 'Today', items: [clip('a', 60), clip('b', 3600 * 5)] },
    ]);
  });

  it('puts clips 24-48h ago into Yesterday', () => {
    const result = groupByTimeBucket([clip('a', 60), clip('b', 3600 * 30)], NOW);
    expect(result).toEqual([
      { bucket: 'Today', items: [clip('a', 60)] },
      { bucket: 'Yesterday', items: [clip('b', 3600 * 30)] },
    ]);
  });

  it('puts clips 48h-7d into This week', () => {
    const result = groupByTimeBucket([clip('a', 3600 * 72), clip('b', 3600 * 24 * 6)], NOW);
    expect(result).toEqual([
      { bucket: 'This week', items: [clip('a', 3600 * 72), clip('b', 3600 * 24 * 6)] },
    ]);
  });

  it('puts clips > 7d into Older', () => {
    const result = groupByTimeBucket([clip('a', 3600 * 24 * 10)], NOW);
    expect(result).toEqual([
      { bucket: 'Older', items: [clip('a', 3600 * 24 * 10)] },
    ]);
  });

  it('preserves input order within each bucket', () => {
    const result = groupByTimeBucket(
      [clip('a', 100), clip('b', 200), clip('c', 50)],
      NOW
    );
    expect(result[0].items.map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns buckets in chronological order: Today, Yesterday, This week, Older', () => {
    const result = groupByTimeBucket(
      [
        clip('older', 3600 * 24 * 30),
        clip('today', 60),
        clip('week', 3600 * 24 * 4),
        clip('yesterday', 3600 * 30),
      ],
      NOW
    );
    expect(result.map(g => g.bucket)).toEqual(['Today', 'Yesterday', 'This week', 'Older']);
  });
});

// Type-checking aid: ensure exported TimeBucket type is what we expect
const _typeCheck: TimeBucket[] = ['Today', 'Yesterday', 'This week', 'Older'];
void _typeCheck;
```

- [ ] **Step 3.2: Run test, verify it fails**

Run: `npm test -- timeBuckets`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `timeBuckets.ts`**

Create `desktop/src/lib/timeBuckets.ts`:

```ts
export type TimeBucket = 'Today' | 'Yesterday' | 'This week' | 'Older';

export interface BucketGroup<T> {
  bucket: TimeBucket;
  items: T[];
}

export interface Timestamped {
  created_at: number; // unix seconds
}

const ORDER: TimeBucket[] = ['Today', 'Yesterday', 'This week', 'Older'];

const ONE_DAY = 86_400;

function bucketOf(secondsAgo: number): TimeBucket {
  if (secondsAgo < ONE_DAY) return 'Today';
  if (secondsAgo < 2 * ONE_DAY) return 'Yesterday';
  if (secondsAgo < 7 * ONE_DAY) return 'This week';
  return 'Older';
}

export function groupByTimeBucket<T extends Timestamped>(
  items: T[],
  nowUnixSeconds: number = Math.floor(Date.now() / 1000)
): BucketGroup<T>[] {
  if (items.length === 0) return [];
  const map = new Map<TimeBucket, T[]>();
  for (const it of items) {
    const b = bucketOf(nowUnixSeconds - it.created_at);
    const arr = map.get(b);
    if (arr) arr.push(it);
    else map.set(b, [it]);
  }
  return ORDER.filter(b => map.has(b)).map(bucket => ({
    bucket,
    items: map.get(bucket)!,
  }));
}
```

- [ ] **Step 3.4: Run test, verify it passes**

Run: `npm test -- timeBuckets`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
cd desktop
git add src/lib/timeBuckets.ts src/lib/timeBuckets.test.ts
git commit -m "ui: group clips by Today/Yesterday/This week/Older buckets"
```

---

## Task 4 — `clipTitle.ts`: mechanical clip title generation

**Files:**
- Create: `desktop/src/lib/clipTitle.ts`
- Create: `desktop/src/lib/clipTitle.test.ts`

- [ ] **Step 4.1: Write failing test**

Create `desktop/src/lib/clipTitle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clipTitle } from './clipTitle';

describe('clipTitle', () => {
  it('returns "Image (size)" for image clips', () => {
    expect(clipTitle({ content_type: 'image', content: '', byte_size: 2048, source: 'local' }))
      .toBe('Image (2.0 KB)');
    expect(clipTitle({ content_type: 'image', content: '', byte_size: 500, source: 'local' }))
      .toBe('Image (500 B)');
  });

  it('returns first 60 chars of content for text clips, single line', () => {
    expect(clipTitle({
      content_type: 'text',
      content: 'hello world',
      byte_size: 11,
      source: 'local',
    })).toBe('hello world');
  });

  it('collapses whitespace and trims for text', () => {
    expect(clipTitle({
      content_type: 'text',
      content: '  multi\n   line\t with whitespace ',
      byte_size: 33,
      source: 'local',
    })).toBe('multi line with whitespace');
  });

  it('truncates long content to 60 chars + ellipsis', () => {
    const long = 'a'.repeat(100);
    const out = clipTitle({ content_type: 'text', content: long, byte_size: 100, source: 'local' });
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith('…')).toBe(true);
  });

  it('uses content for json/url/code clips, not the type name', () => {
    expect(clipTitle({
      content_type: 'json',
      content: '{"hello":"world"}',
      byte_size: 17,
      source: 'local',
    })).toBe('{"hello":"world"}');
  });

  it('returns "(empty clip)" when content is blank and not image', () => {
    expect(clipTitle({ content_type: 'text', content: '', byte_size: 0, source: 'local' }))
      .toBe('(empty clip)');
    expect(clipTitle({ content_type: 'text', content: '   \n\t  ', byte_size: 6, source: 'local' }))
      .toBe('(empty clip)');
  });
});
```

- [ ] **Step 4.2: Run test, verify failure**

Run: `npm test -- clipTitle`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement**

Create `desktop/src/lib/clipTitle.ts`:

```ts
const MAX_TITLE_LEN = 60;

export interface TitleableClip {
  content: string;
  content_type: string;
  byte_size: number;
  source: string;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function clipTitle(clip: TitleableClip): string {
  if (clip.content_type === 'image') {
    return `Image (${formatBytes(clip.byte_size)})`;
  }
  const collapsed = clip.content.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(empty clip)';
  if (collapsed.length <= MAX_TITLE_LEN) return collapsed;
  return collapsed.slice(0, MAX_TITLE_LEN) + '…';
}
```

- [ ] **Step 4.4: Run test, verify pass**

Run: `npm test -- clipTitle`
Expected: PASS, 6 green.

- [ ] **Step 4.5: Commit**

```bash
cd desktop
git add src/lib/clipTitle.ts src/lib/clipTitle.test.ts
git commit -m "ui: mechanical clip title generator"
```

---

## Task 5 — Replace + add icons (`IconPin`, `IconInbox`, `IconMonitor`)

**Files:**
- Modify: `desktop/src/icons.tsx` (replace `IconPin` body, add `IconInbox`, add `IconMonitor`)

- [ ] **Step 5.1: Replace `IconPin` body in `icons.tsx`**

Open `desktop/src/icons.tsx`. Find the `IconPin` export (lines 138-142). Replace its `<svg>` body with the editorial pushpin (the same path used in mockup `07-integrated-design.html`):

```tsx
export const IconPin = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </svg>
);
```

This is the only existing icon whose visual is changing. Its export name and props stay the same, so all callers (rail, clip detail action button, ClipRow) continue to compile.

- [ ] **Step 5.2: Add `IconInbox` after `IconPin`**

Append after the `IconPin` block:

```tsx
export const IconInbox = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <path d="M22 13h-7l-2 3h-2l-2-3H2" />
    <path d="M5.45 5.11L2 13v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-7.89A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.85 1.11Z" />
  </svg>
);
```

- [ ] **Step 5.3: Add `IconMonitor` after `IconInbox`**

```tsx
export const IconMonitor = ({ size = 14, style }: IconProps) => (
  <svg {...base(size)} style={style}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);
```

`IconGear` is already present and stays as-is.

- [ ] **Step 5.4: Build and confirm no TS errors**

Run: `cd desktop && npm run build`
Expected: PASS with zero errors.

- [ ] **Step 5.5: Commit**

```bash
cd desktop
git add src/icons.tsx
git commit -m "ui: replace pin icon, add inbox + monitor glyphs"
```

---

## Task 6 — Update `SourcePill.tsx` to use `sourceColor.ts`

**Files:**
- Modify: `desktop/src/components/SourcePill.tsx` (rewrite)

- [ ] **Step 6.1: Rewrite `SourcePill.tsx`**

Replace the entire file contents with:

```tsx
import { C } from '../design';
import { sourcePillVars } from '../lib/sourceColor';

interface SourcePillProps {
  source: string; // "local" | "remote:hostname"
  status: 'local' | 'remote';
  nickname?: string;
}

export function SourcePill({ source, nickname }: SourcePillProps) {
  const label = nickname ?? (source.startsWith('remote:')
    ? source.replace('remote:', '')
    : source);

  const { bg, fg } = sourcePillVars(source);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: bg,
        color: fg,
        borderRadius: 9999,
        padding: '1px 8px',
        maxWidth: 140,
        overflow: 'hidden',
        fontSize: 10,
        fontFamily: C.t1 ? 'var(--font-mono)' : 'var(--font-mono)',
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
    >
      {label}
    </span>
  );
}
```

The dot-prefix is removed (background color now carries identity). The `status` prop is preserved on the interface for backward compatibility with existing callers but is no longer used inside (the source key already encodes local vs remote). Pill becomes pill-shaped (border-radius 9999) with SF Mono 10px.

- [ ] **Step 6.2: Run existing tests**

Run: `cd desktop && npm test`
Expected: All existing tests pass. `ClipCard.test.tsx`, `LocalOnlyView.test.tsx`, `App.test.tsx` use `SourcePill` indirectly — confirm nothing breaks. If the SourcePill snapshot is stored, regenerate via `npm test -- --update`.

- [ ] **Step 6.3: Commit**

```bash
cd desktop
git add src/components/SourcePill.tsx
git commit -m "ui: SourcePill uses deterministic palette, drops status dot"
```

---

## Task 7 — Extract `Rail.tsx`

**Files:**
- Create: `desktop/src/components/Rail.tsx`
- Create: `desktop/src/components/Rail.test.tsx`
- Modify: `desktop/src/App.tsx` (replace existing rail markup with `<Rail>`; defer until task 12)

This task only creates the new component and test. Wiring into App.tsx happens in Task 12 (App orchestrator rewrite) so we don't break the running app mid-flight.

- [ ] **Step 7.1: Write failing test**

Create `desktop/src/components/Rail.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Rail } from './Rail';

describe('Rail', () => {
  it('renders 4 icon buttons (Inbox, Pinned, Machines, Settings)', () => {
    render(<Rail active="inbox" onSelect={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByLabelText(/inbox/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/pinned/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/machines/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/settings/i)).toBeInTheDocument();
  });

  it('marks the active item with aria-current="page"', () => {
    render(<Rail active="pinned" onSelect={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByLabelText(/pinned/i)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText(/inbox/i)).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect with the panel id when an icon is clicked', () => {
    const onSelect = vi.fn();
    render(<Rail active="inbox" onSelect={onSelect} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByLabelText(/machines/i));
    expect(onSelect).toHaveBeenCalledWith('machines');
  });

  it('calls onOpenSettings when the gear is clicked (not onSelect)', () => {
    const onSelect = vi.fn();
    const onOpenSettings = vi.fn();
    render(<Rail active="inbox" onSelect={onSelect} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByLabelText(/settings/i));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7.2: Run, verify failure**

Run: `npm test -- Rail`
Expected: FAIL — module not found.

- [ ] **Step 7.3: Implement `Rail.tsx`**

Create `desktop/src/components/Rail.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { C } from '../design';
import { IconInbox, IconPin, IconMonitor, IconGear } from '../icons';

export type RailPanel = 'inbox' | 'pinned' | 'machines';

interface RailProps {
  active: RailPanel;
  onSelect: (panel: RailPanel) => void;
  onOpenSettings: () => void;
}

interface RailItemProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function RailItem({ label, active, onClick, children }: RailItemProps) {
  return (
    <button
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      style={{
        ...S.ic,
        ...(active ? S.icActive : {}),
      }}
    >
      {active && <span style={S.activeBar} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Rail({ active, onSelect, onOpenSettings }: RailProps) {
  return (
    <nav aria-label="Sections" style={S.rail}>
      <RailItem label="Inbox" active={active === 'inbox'} onClick={() => onSelect('inbox')}>
        <IconInbox size={20} />
      </RailItem>
      <RailItem label="Pinned" active={active === 'pinned'} onClick={() => onSelect('pinned')}>
        <IconPin size={20} />
      </RailItem>
      <RailItem label="Machines" active={active === 'machines'} onClick={() => onSelect('machines')}>
        <IconMonitor size={20} />
      </RailItem>
      <span style={{ flex: 1 }} aria-hidden="true" />
      <RailItem label="Settings" onClick={onOpenSettings}>
        <IconGear size={20} />
      </RailItem>
    </nav>
  );
}

const S: Record<string, CSSProperties> = {
  rail: {
    width: 56,
    background: C.card,
    borderRight: `1px solid ${C.border}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '14px 0',
    gap: 4,
    flexShrink: 0,
  },
  ic: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: C.t3,
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'color 100ms ease, background 100ms ease',
    position: 'relative',
  },
  icActive: {
    background: C.card2,
    color: C.t1,
  },
  activeBar: {
    position: 'absolute',
    left: -10,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 2,
    height: 18,
    background: 'var(--selection-bar)',
    borderRadius: 2,
  },
};
```

- [ ] **Step 7.4: Run, verify pass**

Run: `npm test -- Rail`
Expected: 4 tests PASS.

- [ ] **Step 7.5: Commit**

```bash
cd desktop
git add src/components/Rail.tsx src/components/Rail.test.tsx
git commit -m "ui: extract Rail component (icon-only, 56px)"
```

---

## Task 8 — Extract `SearchBar.tsx`

**Files:**
- Create: `desktop/src/components/SearchBar.tsx`

This is a presentational component — no behavior tests beyond what App.test.tsx already covers indirectly. We add a render test only.

- [ ] **Step 8.1: Implement `SearchBar.tsx`**

Create `desktop/src/components/SearchBar.tsx`:

```tsx
import { forwardRef, type CSSProperties } from 'react';
import { C } from '../design';
import { IconSearch, IconX, IconSun, IconMoon } from '../icons';

interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ value, onChange, onClear, theme, onToggleTheme, onMouseDown }, ref) => {
    return (
      <div style={S.bar} onMouseDown={onMouseDown} data-testid="search-bar">
        <span style={S.glass}><IconSearch size={14} /></span>
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search clips"
          aria-label="Search clips"
          spellCheck={false}
          autoFocus
          style={S.input}
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear search"
            style={S.iconBtn}
          >
            <IconX size={12} />
          </button>
        )}
        <kbd style={S.kbd}>⌘F</kbd>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          style={S.iconBtn}
        >
          {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
        </button>
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';

const S: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    height: 50,
    padding: '0 18px',
    gap: 12,
    background: C.card,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  glass: { color: C.t2, display: 'flex', alignItems: 'center' },
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    fontFamily: 'var(--font-serif)',
    fontSize: 15,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: C.t1,
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: C.t3,
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    borderRadius: 4,
  },
  kbd: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 6px',
    background: 'var(--kbd-bg)',
    border: '1px solid var(--kbd-border)',
    color: 'var(--kbd-color)',
    borderRadius: 3,
    letterSpacing: '0.04em',
  },
};
```

The serif placeholder displays via `font-family: var(--font-serif)` on the `<input>` which inherits to the placeholder. `autoFocus` matches existing App.tsx behavior.

- [ ] **Step 8.2: Build, no test required for purely presentational**

Run: `cd desktop && npm run build`
Expected: PASS, no TS errors. Component is exercised through `App.test.tsx` once wired up in Task 12.

- [ ] **Step 8.3: Commit**

```bash
cd desktop
git add src/components/SearchBar.tsx
git commit -m "ui: extract SearchBar component (Lyon serif placeholder)"
```

---

## Task 9 — Extract `ClipList.tsx`

**Files:**
- Create: `desktop/src/components/ClipList.tsx`
- Create: `desktop/src/components/ClipList.test.tsx`

- [ ] **Step 9.1: Write failing test**

Create `desktop/src/components/ClipList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipList } from './ClipList';
import type { LocalClip } from '../bindings';

const NOW = 1_777_614_529; // matches our visual companion timestamp roughly

const clip = (overrides: Partial<LocalClip>): LocalClip => ({
  id: 'c1',
  content: 'hello world',
  content_type: 'text',
  byte_size: 11,
  source: 'local',
  created_at: NOW - 60,
  is_pinned: false,
  pin_note: null,
  media_path: null,
  ...overrides,
});

describe('ClipList', () => {
  it('renders empty state when no clips and no query', () => {
    render(
      <ClipList clips={[]} selected={null} onSelect={() => {}} onCopy={() => {}}
                query="" deviceNicknames={{}} now={NOW} />
    );
    expect(screen.getByText(/no clips/i)).toBeInTheDocument();
  });

  it('renders search-miss empty state when query and no clips', () => {
    render(
      <ClipList clips={[]} selected={null} onSelect={() => {}} onCopy={() => {}}
                query="foo" deviceNicknames={{}} now={NOW} />
    );
    expect(screen.getByText(/no results/i)).toBeInTheDocument();
    expect(screen.getByText(/foo/)).toBeInTheDocument();
  });

  it('groups clips into time bucket sections', () => {
    const clips = [
      clip({ id: 'a', created_at: NOW - 60 }),
      clip({ id: 'b', created_at: NOW - 86400 - 100 }),
    ];
    render(
      <ClipList clips={clips} selected={null} onSelect={() => {}} onCopy={() => {}}
                query="" deviceNicknames={{}} now={NOW} />
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
  });

  it('marks the selected clip with aria-selected', () => {
    const c = clip({ id: 'a' });
    render(
      <ClipList clips={[c]} selected={c} onSelect={() => {}} onCopy={() => {}}
                query="" deviceNicknames={{}} now={NOW} />
    );
    const row = screen.getByRole('button', { name: /hello world/i });
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onSelect when row clicked', () => {
    const c = clip({ id: 'a' });
    const onSelect = vi.fn();
    render(
      <ClipList clips={[c]} selected={null} onSelect={onSelect} onCopy={() => {}}
                query="" deviceNicknames={{}} now={NOW} />
    );
    fireEvent.click(screen.getByRole('button', { name: /hello world/i }));
    expect(onSelect).toHaveBeenCalledWith(c);
  });

  it('calls onCopy when row double-clicked', () => {
    const c = clip({ id: 'a' });
    const onCopy = vi.fn();
    render(
      <ClipList clips={[c]} selected={null} onSelect={() => {}} onCopy={onCopy}
                query="" deviceNicknames={{}} now={NOW} />
    );
    fireEvent.doubleClick(screen.getByRole('button', { name: /hello world/i }));
    expect(onCopy).toHaveBeenCalledWith(c);
  });
});
```

- [ ] **Step 9.2: Run, verify failure**

Run: `npm test -- ClipList`
Expected: FAIL.

- [ ] **Step 9.3: Implement `ClipList.tsx`**

Create `desktop/src/components/ClipList.tsx`:

```tsx
import { forwardRef, type CSSProperties } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatTime, formatBytes } from '../design';
import { groupByTimeBucket } from '../lib/timeBuckets';
import { SourcePill } from './SourcePill';

interface ClipListProps {
  clips: LocalClip[];
  selected: LocalClip | null;
  onSelect: (clip: LocalClip) => void;
  onCopy: (clip: LocalClip) => void;
  query: string;
  deviceNicknames: Record<string, string>;
  now?: number;
}

export const ClipList = forwardRef<HTMLDivElement, ClipListProps>(
  ({ clips, selected, onSelect, onCopy, query, deviceNicknames, now }, ref) => {
    if (clips.length === 0) {
      return (
        <div style={S.col}>
          <div style={S.empty}>
            <div style={S.emptyTitle}>
              {query ? `No results for "${query}"` : 'No clips yet'}
            </div>
            {!query && (
              <code style={S.emptyHint}>echo "hello" | cinch push</code>
            )}
          </div>
        </div>
      );
    }

    const groups = groupByTimeBucket(clips, now);

    return (
      <div ref={ref} style={S.col} role="list">
        {groups.map(({ bucket, items }) => (
          <section key={bucket}>
            <div style={S.sectionLabel}>{bucket}</div>
            {items.map((clip) => (
              <ClipRow
                key={clip.id}
                clip={clip}
                selected={selected?.id === clip.id}
                onClick={() => onSelect(clip)}
                onDoubleClick={() => onCopy(clip)}
                nickname={deviceNicknames[clip.source]}
              />
            ))}
          </section>
        ))}
      </div>
    );
  }
);

ClipList.displayName = 'ClipList';

interface ClipRowProps {
  clip: LocalClip;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  nickname?: string;
}

function ClipRow({ clip, selected, onClick, onDoubleClick, nickname }: ClipRowProps) {
  const isImage = clip.content_type === 'image' && !!clip.media_path;
  const preview = isImage
    ? `Image (${formatBytes(clip.byte_size)})`
    : clip.content.replace(/\s+/g, ' ').trim().substring(0, 140);
  return (
    <div
      role="button"
      data-id={clip.id}
      aria-selected={selected}
      aria-label={preview || 'empty clip'}
      tabIndex={0}
      style={{ ...S.row, ...(selected ? S.rowActive : {}) }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span style={S.preview}>{preview || ' '}</span>
      <span style={S.meta}>
        <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} nickname={nickname} />
        <span style={{ color: C.t4 }}>·</span>
        <span>{formatTime(clip.created_at)}</span>
      </span>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  col: {
    width: 320,
    flexShrink: 0,
    background: C.card,
    borderRight: `1px solid ${C.border}`,
    overflowY: 'auto',
  },
  sectionLabel: {
    padding: '14px 18px 6px',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: C.t3,
  },
  row: {
    padding: '11px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    cursor: 'pointer',
    borderLeft: '2px solid transparent',
    borderBottom: `1px solid ${C.border}`,
  },
  rowActive: {
    background: C.selected,
    borderLeftColor: 'var(--selection-bar)',
  },
  preview: {
    fontSize: 13.5,
    fontFamily: 'var(--font-body)',
    color: C.t1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    letterSpacing: '-0.005em',
    lineHeight: 1.45,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10.5,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.04em',
    color: C.t3,
  },
  empty: {
    padding: '40px 20px',
    textAlign: 'center',
  },
  emptyTitle: { color: C.t2, fontSize: 13, marginBottom: 6 },
  emptyHint: { fontSize: 11, color: C.t3, fontFamily: 'var(--font-mono)' },
};
```

- [ ] **Step 9.4: Run test, verify pass**

Run: `npm test -- ClipList`
Expected: 6 tests PASS.

- [ ] **Step 9.5: Commit**

```bash
cd desktop
git add src/components/ClipList.tsx src/components/ClipList.test.tsx
git commit -m "ui: extract ClipList with time-bucket sections"
```

---

## Task 10 — Extract `ClipDetail.tsx`

**Files:**
- Create: `desktop/src/components/ClipDetail.tsx`
- Create: `desktop/src/components/ClipDetail.test.tsx`

- [ ] **Step 10.1: Write failing test**

Create `desktop/src/components/ClipDetail.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipDetail } from './ClipDetail';
import type { LocalClip } from '../bindings';

const baseClip: LocalClip = {
  id: 'c1',
  content: 'hello world',
  content_type: 'text',
  byte_size: 11,
  source: 'local',
  created_at: 1_777_614_529,
  is_pinned: false,
  pin_note: null,
  media_path: null,
};

const noOp = () => {};

describe('ClipDetail', () => {
  it('renders empty placeholder when no clip selected', () => {
    render(<ClipDetail clip={null} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByText(/select a clip/i)).toBeInTheDocument();
  });

  it('renders generated title and content for selected clip', () => {
    render(<ClipDetail clip={baseClip} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByRole('heading', { name: /hello world/i })).toBeInTheDocument();
  });

  it('shows Copy / Pin / Delete buttons with kbd hints', () => {
    render(<ClipDetail clip={baseClip} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByRole('button', { name: /^copy/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^pin/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete/i })).toBeInTheDocument();
  });

  it('calls onCopy when Copy clicked', () => {
    const onCopy = vi.fn();
    render(<ClipDetail clip={baseClip} onCopy={onCopy} onPin={noOp} onDelete={noOp} />);
    fireEvent.click(screen.getByRole('button', { name: /^copy/i }));
    expect(onCopy).toHaveBeenCalledWith(baseClip);
  });

  it('shows "Unpin" button when clip is_pinned', () => {
    render(<ClipDetail clip={{ ...baseClip, is_pinned: true }} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByRole('button', { name: /^unpin/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 10.2: Run, verify fail**

Run: `npm test -- ClipDetail`
Expected: FAIL.

- [ ] **Step 10.3: Implement `ClipDetail.tsx`**

Create `desktop/src/components/ClipDetail.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatBytes } from '../design';
import { clipTitle } from '../lib/clipTitle';
import { SourcePill } from './SourcePill';

interface ClipDetailProps {
  clip: LocalClip | null;
  onCopy: (clip: LocalClip) => void;
  onPin: (clip: LocalClip) => void;
  onDelete: (clip: LocalClip) => void;
}

export function ClipDetail({ clip, onCopy, onPin, onDelete }: ClipDetailProps) {
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { setImgDims(null); }, [clip?.id]);

  if (!clip) {
    return <div style={S.placeholder}>Select a clip</div>;
  }

  const isImage = clip.content_type === 'image' && !!clip.media_path;
  const isJsonish =
    clip.content_type === 'json' ||
    (clip.content.trim().startsWith('{') && clip.content.trim().endsWith('}')) ||
    (clip.content.trim().startsWith('[') && clip.content.trim().endsWith(']'));
  const body = isJsonish ? tryPrettyJson(clip.content) : clip.content;

  const title = clipTitle(clip);
  const stamp = new Date(clip.created_at * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  return (
    <div style={S.col}>
      <div style={S.stamp}>
        <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} />
        <span style={{ color: C.t4 }}>·</span>
        <span>{stamp}</span>
      </div>

      <h1 style={S.title}>{title}</h1>

      {isImage ? (
        <div style={S.imgFrame}>
          <img
            src={`cinch://media/${clip.id}`}
            alt={`Clip from ${clip.source}`}
            style={S.img}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth) setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
        </div>
      ) : (
        <pre style={S.code}>{body}</pre>
      )}

      <div style={S.actions}>
        <button type="button" onClick={() => onCopy(clip)} style={S.btnPrimary}>
          Copy <span style={S.kbdHint}>↵</span>
        </button>
        <button type="button" onClick={() => onPin(clip)} style={S.btnGhost}>
          {clip.is_pinned ? 'Unpin' : 'Pin'} <span style={S.kbdHint}>⌘P</span>
        </button>
        <button
          type="button"
          onClick={() => onDelete(clip)}
          style={{ ...S.btnGhost, marginLeft: 'auto' }}
        >
          Delete <span style={S.kbdHint}>⌘⌫</span>
        </button>
      </div>

      <dl style={S.metaList}>
        <MetaRow label="Source" value={clip.source.startsWith('remote:') ? clip.source.replace('remote:', '') : clip.source} />
        <MetaRow label="Type" value={clip.content_type} />
        <MetaRow label="Size" value={formatBytes(clip.byte_size)} />
        {isImage && imgDims && <MetaRow label="Dimensions" value={`${imgDims.w} × ${imgDims.h}`} />}
        {clip.is_pinned && <MetaRow label="Note" value={clip.pin_note ?? '(no note)'} />}
      </dl>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={S.metaKey}>{label}</dt>
      <dd style={S.metaVal}>{value}</dd>
    </>
  );
}

function tryPrettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

const S: Record<string, CSSProperties> = {
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: C.t3,
    fontSize: 12,
    fontFamily: 'var(--font-serif)',
    letterSpacing: '-0.01em',
  },
  col: {
    flex: 1,
    minWidth: 0,
    padding: '22px 26px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    overflow: 'auto',
    background: C.card,
  },
  stamp: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: C.t3,
  },
  title: {
    fontFamily: 'var(--font-serif)',
    fontWeight: 400,
    fontSize: 22,
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
    margin: 0,
    color: C.t1,
  },
  code: {
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '14px 16px',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.6,
    color: C.t1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
  },
  imgFrame: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 18,
    minHeight: 160,
  },
  img: { maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain', borderRadius: 2 },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  btnPrimary: {
    padding: '6px 14px',
    background: C.t1,
    color: C.bg,
    border: 'none',
    borderRadius: 5,
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  btnGhost: {
    padding: '6px 14px',
    background: 'transparent',
    color: C.t2,
    border: `1px solid ${C.border}`,
    borderRadius: 5,
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  kbdHint: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    opacity: 0.6,
    letterSpacing: '0.04em',
  },
  metaList: {
    margin: 0,
    marginTop: 'auto',
    paddingTop: 14,
    borderTop: `1px solid ${C.border}`,
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    rowGap: 5,
    columnGap: 12,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  },
  metaKey: {
    color: C.t3,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    margin: 0,
  },
  metaVal: { color: C.t1, margin: 0, wordBreak: 'break-all' },
};
```

- [ ] **Step 10.4: Run test, verify pass**

Run: `npm test -- ClipDetail`
Expected: 5 tests PASS.

- [ ] **Step 10.5: Commit**

```bash
cd desktop
git add src/components/ClipDetail.tsx src/components/ClipDetail.test.tsx
git commit -m "ui: extract ClipDetail with Lyon serif title + action row"
```

---

## Task 11 — Extract `StatusBar.tsx`

**Files:**
- Create: `desktop/src/components/StatusBar.tsx`

- [ ] **Step 11.1: Implement `StatusBar.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { C } from '../design';

interface StatusBarProps {
  clipCount: number;
  machinesOnline?: number;
  machinesTotal?: number;
  hints: { keys: string; label: string }[];
  onMouseDown?: (e: React.MouseEvent) => void;
}

export function StatusBar({
  clipCount,
  machinesOnline,
  machinesTotal,
  hints,
  onMouseDown,
}: StatusBarProps) {
  return (
    <footer style={S.bar} role="contentinfo" onMouseDown={onMouseDown}>
      <div style={S.left}>
        <span>{clipCount} {clipCount === 1 ? 'clip' : 'clips'}</span>
        {machinesTotal !== undefined && (
          <>
            <span style={{ color: C.t4 }}>·</span>
            <span>{machinesOnline ?? 0}/{machinesTotal} online</span>
          </>
        )}
      </div>
      <div style={S.right}>
        {hints.map((h) => (
          <span key={h.keys} style={S.hint}>
            <kbd style={S.kbd}>{h.keys}</kbd>
            <span style={S.hintLabel}>{h.label}</span>
          </span>
        ))}
      </div>
    </footer>
  );
}

const S: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    height: 28,
    padding: '0 18px',
    gap: 14,
    background: C.bg,
    borderTop: `1px solid ${C.border}`,
    flexShrink: 0,
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
    letterSpacing: '0.04em',
    color: C.t3,
  },
  left: { display: 'flex', alignItems: 'center', gap: 6 },
  right: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 },
  hint: { display: 'flex', alignItems: 'center', gap: 4 },
  kbd: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    padding: '1px 5px',
    background: 'var(--kbd-bg)',
    border: '1px solid var(--kbd-border)',
    color: 'var(--kbd-color)',
    borderRadius: 3,
    letterSpacing: '0.04em',
  },
  hintLabel: { color: C.t3 },
};
```

- [ ] **Step 11.2: Build verifies**

Run: `cd desktop && npm run build`
Expected: PASS.

- [ ] **Step 11.3: Commit**

```bash
cd desktop
git add src/components/StatusBar.tsx
git commit -m "ui: extract StatusBar component"
```

---

## Task 12 — Refactor `App.tsx` to use extracted components

This is the largest task: rewire the existing 600-line App.tsx around the 5 new components without changing any data flow or keyboard behavior.

**Files:**
- Modify: `desktop/src/App.tsx` (substantial rewrite — ~70% replaced)

**Strategy:** preserve every state hook, useEffect, and keyboard handler verbatim. Only the JSX inside `return (...)` and the inline `S` style object change.

- [ ] **Step 12.1: Add imports for new components at top of `App.tsx`**

In `desktop/src/App.tsx`, replace the existing component import block (lines 8-26) with:

```tsx
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands, events } from './bindings';
import type { LocalClip, SourceInfo, Device } from './bindings';
import { unwrap } from './lib/tauri';
import { C } from './design';
import { useAuthState, retryAuth, type AuthProgress, type AuthErrorReason } from './state/auth';
import SettingsPane from './SettingsPane';
import { LocalOnlyView } from './components/LocalOnlyView';
import { AdoptedAuthToast } from './components/AdoptedAuthToast';
import { AddRelayDialog } from './components/AddRelayDialog';
import { Rail, type RailPanel } from './components/Rail';
import { SearchBar } from './components/SearchBar';
import { ClipList } from './components/ClipList';
import { ClipDetail } from './components/ClipDetail';
import { StatusBar } from './components/StatusBar';
import { PinnedPanel } from './components/PinnedPanel';
import { MachinesPanel } from './components/MachinesPanel';
import { IconCopy, IconTrash } from './icons';
import './App.css';
```

(`PinnedPanel` and `MachinesPanel` are referenced ahead of their creation tasks — Tasks 13 and 14. The `App.tsx` change won't compile until those exist; commit Task 12 only after Task 14.)

- [ ] **Step 12.2: Replace `activePanel` state shape**

In the App() function body (around line 105), replace:

```tsx
const [activePanel, setActivePanel] = useState<"clips" | "machines">("clips");
```

with:

```tsx
const [activePanel, setActivePanel] = useState<RailPanel>('inbox');
```

This unifies panel switching across Inbox / Pinned / Machines.

- [ ] **Step 12.3: Remove now-redundant state**

Delete the following state hooks (kept inline today, now lifted into ClipDetail / Rail / SearchBar internals):

- The `[selectedSource, setSelectedSource]` use case for `__pinned__` becomes implicit — when `activePanel === 'pinned'` the list filter is "pinned only". Replace `setSelectedSource('__pinned__')` references with `setActivePanel('pinned')` and remove the `__pinned__` branch in `refreshClips`.

After this rewrite, in `refreshClips` (around line 122), replace the body with:

```tsx
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

`selectedSource` is now reserved exclusively for the `from:` token / nickname filter. The "pinned virtual source" goes away.

- [ ] **Step 12.4: Replace the dashboard JSX (auth=Authenticated branch)**

Find the `return (` block that starts the dashboard (around line 418, after `// auth.variant === "Authenticated"`). Replace the entire JSX subtree from `<main>` to the closing `</main>` with:

```tsx
return (
  <main data-testid="dashboard-root" style={S.main}>
    <SearchBar
      ref={searchRef}
      value={searchQuery}
      onChange={setSearchQuery}
      onClear={() => setSearchQuery('')}
      theme={theme}
      onToggleTheme={toggleTheme}
      onMouseDown={handleWindowDrag}
    />

    <div style={S.body}>
      <Rail
        active={activePanel}
        onSelect={(panel) => {
          setActivePanel(panel);
          setSelectedClip(null);
          setSelectedSource(null);
        }}
        onOpenSettings={() => setShowSettings(true)}
      />

      {activePanel === 'machines' ? (
        <MachinesPanel
          currentDeviceID={currentDeviceID}
          onShowToast={(msg) => showToast(msg, 'copy')}
          onDeviceChange={refreshDevices}
        />
      ) : activePanel === 'pinned' ? (
        <PinnedPanel
          clips={filteredClips}
          selected={selectedClip}
          onSelect={setSelectedClip}
          onCopy={copyClip}
          onPin={(c) => setPinNoteDialog({ clip: c })}
          onUnpin={handleUnpin}
          onDelete={(c) => handleDelete(c.id)}
          query={debouncedQuery}
          deviceNicknames={nicknameBySource}
          listRef={clipListRef}
        />
      ) : (
        <>
          <ClipList
            ref={clipListRef}
            clips={filteredClips}
            selected={selectedClip}
            onSelect={setSelectedClip}
            onCopy={copyClip}
            query={debouncedQuery}
            deviceNicknames={nicknameBySource}
          />
          <ClipDetail
            clip={selectedClip}
            onCopy={copyClip}
            onPin={(c) => c.is_pinned ? handleUnpin(c) : setPinNoteDialog({ clip: c })}
            onDelete={(c) => handleDelete(c.id)}
          />
        </>
      )}
    </div>

    <StatusBar
      clipCount={totalClips}
      machinesOnline={devices.length > 0 ? devices.filter(d => d.online).length : undefined}
      machinesTotal={devices.length > 0 ? devices.length : undefined}
      hints={selectedClip
        ? [
            { keys: '↵', label: 'copy' },
            { keys: '⌘⌫', label: 'delete' },
            { keys: '?', label: 'shortcuts' },
          ]
        : [
            { keys: '⌘F', label: 'search' },
            { keys: '↑↓', label: 'navigate' },
            { keys: '?', label: 'shortcuts' },
          ]}
      onMouseDown={handleWindowDrag}
    />

    {selectedClip && (
      <HiddenActions
        onCopy={() => copyClip(selectedClip)}
        onDelete={() => handleDelete(selectedClip.id)}
      />
    )}

    {pinNoteDialog && (
      <PinNoteDialog
        clip={pinNoteDialog.clip}
        onConfirm={(note) => handlePin(pinNoteDialog.clip, note || null)}
        onCancel={() => setPinNoteDialog(null)}
      />
    )}

    {newSourcePrompt && (
      <NewSourceDialog
        source={newSourcePrompt}
        onAccept={() => setNewSourcePrompt(null)}
        onDisableAutoCopy={() => handleNewSourceResponse(newSourcePrompt, false)}
      />
    )}

    {settingsOverlay}
    {showShortcuts && <ShortcutPanel onClose={() => setShowShortcuts(false)} />}
    {toast && <Toast message={toast.message} icon={toast.icon} />}
    <AdoptedAuthToast />
    {handoffDialog}
  </main>
);
```

- [ ] **Step 12.5: Trim the inline `S` style object**

The new App.tsx only needs `main` and `body` styles. Replace the entire `S: Record<string, React.CSSProperties> = { ... }` object (lines 1225-1630) with:

```tsx
const S: Record<string, React.CSSProperties> = {
  main: {
    background: C.bg,
    color: C.t1,
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden',
    border: `1px solid ${C.border}`,
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
};
```

The `dialog`, `overlay`, `btnPrimary`, `btnGhost` styles consumed by `PinNoteDialog`, `ShortcutPanel`, `Toast`, `NewSourceDialog`, `HiddenActions` should be lifted into a small shared module. Step 12.6 handles that.

- [ ] **Step 12.6: Lift dialog primitives into `src/components/dialogPrimitives.ts`**

Create `desktop/src/components/dialogPrimitives.ts`:

```ts
import type { CSSProperties } from 'react';
import { C } from '../design';

export const dialogStyles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  dialog: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 18,
    maxWidth: 380,
    width: '100%',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.18)',
  },
  title: { fontSize: 13, fontWeight: 600, color: C.t1, marginBottom: 6 },
  body: { fontSize: 12, color: C.t2, marginBottom: 16, lineHeight: 1.55 },
  actions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  btnPrimary: {
    padding: '6px 14px',
    borderRadius: 5,
    fontSize: 12,
    fontWeight: 500,
    background: C.t1,
    color: C.bg,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnGhost: {
    padding: '6px 14px',
    borderRadius: 5,
    fontSize: 12,
    fontWeight: 500,
    background: 'transparent',
    color: C.t2,
    border: `1px solid ${C.border}`,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
```

Update the existing in-file `PinNoteDialog`, `ShortcutPanel`, `NewSourceDialog`, `Toast`, `HiddenActions` definitions in App.tsx to import `dialogStyles` and use `dialogStyles.overlay`, `dialogStyles.dialog`, etc. instead of the trimmed-out `S.overlay`, `S.dialog`. The toast inline style stays in App.tsx because it's not a dialog. Replace `S.toast` with a local const.

(For each helper component: read its current style references, swap `S.overlay` → `dialogStyles.overlay`, `S.dialog` → `dialogStyles.dialog`, `S.dialogTitle` → `dialogStyles.title`, `S.dialogBody` → `dialogStyles.body`, `S.dialogActions` → `dialogStyles.actions`, `S.btnPrimary` → `dialogStyles.btnPrimary`, `S.btnGhost` → `dialogStyles.btnGhost`.)

- [ ] **Step 12.7: Extract `NewSourceDialog` to a function component**

Inside App.tsx, the existing inline new-source dialog markup (around lines 624-647) becomes its own function component below `Toast`:

```tsx
function NewSourceDialog({
  source,
  onAccept,
  onDisableAutoCopy,
}: {
  source: string;
  onAccept: () => void;
  onDisableAutoCopy: () => void;
}) {
  return (
    <div style={dialogStyles.overlay} onClick={onAccept}>
      <div style={dialogStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={dialogStyles.title}>New source detected</div>
        <div style={dialogStyles.body}>
          <code style={{ color: C.accent, fontFamily: 'var(--font-mono)' }}>
            {source.replace('remote:', '')}
          </code>{' '}
          is sending clips. Auto-copy is on by default.
        </div>
        <div style={dialogStyles.actions}>
          <button style={dialogStyles.btnGhost} onClick={onDisableAutoCopy}>
            Disable auto-copy
          </button>
          <button style={dialogStyles.btnPrimary} onClick={onAccept}>OK</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12.8: Run all tests**

Run: `cd desktop && npm test`
Expected: All tests including `App.test.tsx` PASS. The 4 cases in App.test (LocalOnly, Authenticated, Authenticating, ErrorRecoverable) each verify a `data-testid` or text — none of which we changed, so they should pass unchanged.

- [ ] **Step 12.9: Defer commit until Tasks 13 and 14**

Do not commit yet — App.tsx still references `PinnedPanel` and `MachinesPanel` (steps 13 and 14). Leave the working tree dirty and proceed to Task 13.

---

## Task 13 — `PinnedPanel.tsx`

**Files:**
- Create: `desktop/src/components/PinnedPanel.tsx`

PinnedPanel is structurally similar to the inbox view (ClipList + ClipDetail) but groups by `pin_note` instead of by time bucket.

- [ ] **Step 13.1: Implement `PinnedPanel.tsx`**

Create `desktop/src/components/PinnedPanel.tsx`:

```tsx
import type { CSSProperties, RefObject } from 'react';
import type { LocalClip } from '../bindings';
import { C, formatTime } from '../design';
import { SourcePill } from './SourcePill';
import { ClipDetail } from './ClipDetail';

interface PinnedPanelProps {
  clips: LocalClip[];
  selected: LocalClip | null;
  onSelect: (clip: LocalClip) => void;
  onCopy: (clip: LocalClip) => void;
  onPin: (clip: LocalClip) => void;
  onUnpin: (clip: LocalClip) => void;
  onDelete: (clip: LocalClip) => void;
  query: string;
  deviceNicknames: Record<string, string>;
  listRef: RefObject<HTMLDivElement>;
}

export function PinnedPanel({
  clips, selected, onSelect, onCopy, onPin, onUnpin, onDelete,
  query, deviceNicknames, listRef,
}: PinnedPanelProps) {
  const groups = groupByPinNote(clips);

  return (
    <>
      <div ref={listRef} style={S.col}>
        {clips.length === 0 ? (
          <div style={S.empty}>
            <div style={S.emptyTitle}>
              {query ? `No pinned clips matching "${query}"` : 'No pinned clips yet'}
            </div>
            {!query && (
              <div style={S.emptyHint}>
                Press <kbd style={S.kbd}>⌘P</kbd> on any clip to pin it.
              </div>
            )}
          </div>
        ) : (
          groups.map(({ note, items }) => (
            <section key={note}>
              <div style={S.sectionLabel}>{note}</div>
              {items.map((clip) => (
                <PinnedRow
                  key={clip.id}
                  clip={clip}
                  selected={selected?.id === clip.id}
                  onClick={() => onSelect(clip)}
                  onDoubleClick={() => onCopy(clip)}
                  nickname={deviceNicknames[clip.source]}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <ClipDetail
        clip={selected}
        onCopy={onCopy}
        onPin={(c) => c.is_pinned ? onUnpin(c) : onPin(c)}
        onDelete={onDelete}
      />
    </>
  );
}

interface NoteGroup { note: string; items: LocalClip[]; }

function groupByPinNote(clips: LocalClip[]): NoteGroup[] {
  const map = new Map<string, LocalClip[]>();
  const order: string[] = [];
  for (const c of clips) {
    const key = c.pin_note?.trim() || 'Unnamed';
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key)!.push(c);
  }
  return order.map(note => ({ note, items: map.get(note)! }));
}

function PinnedRow({
  clip, selected, onClick, onDoubleClick, nickname,
}: {
  clip: LocalClip;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  nickname?: string;
}) {
  const preview = clip.content.replace(/\s+/g, ' ').trim().substring(0, 140);
  return (
    <div
      role="button"
      data-id={clip.id}
      aria-selected={selected}
      aria-label={preview || 'pinned clip'}
      tabIndex={0}
      style={{ ...S.row, ...(selected ? S.rowActive : {}) }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span style={S.preview}>{preview || ' '}</span>
      <span style={S.meta}>
        <SourcePill source={clip.source} status={clip.source === 'local' ? 'local' : 'remote'} nickname={nickname} />
        <span style={{ color: C.t4 }}>·</span>
        <span>{formatTime(clip.created_at)}</span>
      </span>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  col: {
    width: 320,
    flexShrink: 0,
    background: C.card,
    borderRight: `1px solid ${C.border}`,
    overflowY: 'auto',
  },
  sectionLabel: {
    padding: '14px 18px 6px',
    fontFamily: 'var(--font-serif)',
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: C.t2,
  },
  row: {
    padding: '11px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    cursor: 'pointer',
    borderLeft: '2px solid transparent',
    borderBottom: `1px solid ${C.border}`,
  },
  rowActive: {
    background: C.selected,
    borderLeftColor: 'var(--selection-bar)',
  },
  preview: {
    fontSize: 13.5,
    fontFamily: 'var(--font-body)',
    color: C.t1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    letterSpacing: '-0.005em',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10.5,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.04em',
    color: C.t3,
  },
  empty: { padding: '40px 20px', textAlign: 'center' },
  emptyTitle: { color: C.t2, fontSize: 13, marginBottom: 6 },
  emptyHint: { fontSize: 11, color: C.t3 },
  kbd: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    padding: '1px 5px',
    background: 'var(--kbd-bg)',
    border: '1px solid var(--kbd-border)',
    color: 'var(--kbd-color)',
    borderRadius: 3,
  },
};
```

- [ ] **Step 13.2: Build, no test required**

Run: `cd desktop && npm run build`
Expected: PASS (Task 12's App.tsx now compiles partially, but `MachinesPanel` import still missing).

---

## Task 14 — `MachinesPanel.tsx` (replaces `DeviceDashboard`)

**Files:**
- Create: `desktop/src/components/MachinesPanel.tsx`
- Delete: `desktop/src/components/DeviceDashboard.tsx`

`DeviceDashboard.tsx` is large (~500 lines). The redesign keeps all its functionality (list, edit nickname, revoke, pair) but presents it as a card grid. We refactor by:
1. Reading the existing `DeviceDashboard.tsx` data flow (`fetchAll`, edit/revoke handlers).
2. Reusing those handlers in the new `MachinesPanel.tsx`.
3. Replacing only the JSX layout — list rows become cards.

- [ ] **Step 14.1: Read `DeviceDashboard.tsx` end-to-end and copy its non-JSX logic**

Read `desktop/src/components/DeviceDashboard.tsx`. Extract these blocks verbatim into the new file:
- `MergedEntry` type (lines ~17-20)
- `deviceHue` function (lines ~25-31) — *delete this; we use sourceColor.ts now*
- `sourceName` function (lines ~33-35)
- All `useState` hooks
- `fetchAll` callback
- Polling `useEffect` blocks
- Nickname edit handlers (`startEdit`, `saveNickname`, `cancelEdit`)
- Revoke handlers (`confirmRevoke`, `cancelRevoke`, `executeRevoke`)
- Merging logic that combines `devices` + `sources` into `MergedEntry[]`

The JSX is replaced.

- [ ] **Step 14.2: Implement `MachinesPanel.tsx`**

Create `desktop/src/components/MachinesPanel.tsx`. Skeleton (fill in handlers from step 14.1):

```tsx
import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import { commands } from '../bindings';
import { unwrap } from '../lib/tauri';
import { C, formatTime } from '../design';
import { sourcePillVars } from '../lib/sourceColor';
import type { Device, SourceInfo } from '../bindings';
import { ConfirmDialog } from '../ConfirmDialog';

interface MachinesPanelProps {
  currentDeviceID: string;
  onShowToast: (message: string) => void;
  onDeviceChange?: () => void;
}

export function MachinesPanel({
  currentDeviceID,
  onShowToast,
  onDeviceChange,
}: MachinesPanelProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const nicknameErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [devs, srcs] = await Promise.allSettled([
        unwrap(commands.listDevices()),
        unwrap(commands.getSources()),
      ]);
      if (devs.status === 'fulfilled') setDevices(devs.value);
      if (srcs.status === 'fulfilled') setSources(srcs.value);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // 30s polling — same cadence as today's DeviceDashboard
  useEffect(() => {
    const id = setInterval(() => fetchAll(), 30_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const startEdit = (d: Device) => {
    setEditingDeviceId(d.device_id);
    setEditValue(d.nickname ?? d.hostname ?? '');
    setNicknameError(null);
  };

  const cancelEdit = () => {
    setEditingDeviceId(null);
    setEditValue('');
    setNicknameError(null);
  };

  const saveNickname = async (deviceId: string) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setNicknameError('Nickname cannot be empty');
      if (nicknameErrorTimer.current) clearTimeout(nicknameErrorTimer.current);
      nicknameErrorTimer.current = setTimeout(() => setNicknameError(null), 3000);
      return;
    }
    try {
      await unwrap(commands.renameDevice(deviceId, trimmed));
      cancelEdit();
      await fetchAll();
      onDeviceChange?.();
      onShowToast('Nickname updated');
    } catch (e) {
      setNicknameError(String(e));
    }
  };

  const executeRevoke = async (deviceId: string) => {
    try {
      await unwrap(commands.revokeDevice(deviceId));
      setConfirmingRevokeId(null);
      await fetchAll();
      onDeviceChange?.();
      onShowToast('Device revoked');
    } catch (e) {
      onShowToast(`Revoke failed: ${e}`);
    }
  };

  // Build deduped device entries: include all known devices + source-only entries
  // for sources without a device record.
  const deviceSourceKeys = new Set(devices.map(d => d.source_key).filter(Boolean) as string[]);
  const sourceOnly = sources.filter(s => s.source !== 'local' && !deviceSourceKeys.has(s.source));

  if (loading) {
    return <div style={S.placeholder}>Loading machines…</div>;
  }

  return (
    <div style={S.panel}>
      <div style={S.grid}>
        {devices.map((d) => (
          <DeviceCard
            key={d.device_id}
            device={d}
            isCurrent={d.device_id === currentDeviceID}
            sourceInfo={sources.find(s => s.source === d.source_key)}
            isEditing={editingDeviceId === d.device_id}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onStartEdit={() => startEdit(d)}
            onCancelEdit={cancelEdit}
            onSave={() => saveNickname(d.device_id)}
            onRequestRevoke={() => setConfirmingRevokeId(d.device_id)}
            error={editingDeviceId === d.device_id ? nicknameError : null}
          />
        ))}

        {sourceOnly.map((s) => (
          <SourceOnlyCard key={s.source} source={s} />
        ))}

        <PairCard />
      </div>

      {confirmingRevokeId && (
        <ConfirmDialog
          title="Revoke device?"
          body="This device will lose access immediately. This cannot be undone."
          confirmLabel="Revoke"
          onConfirm={() => executeRevoke(confirmingRevokeId)}
          onCancel={() => setConfirmingRevokeId(null)}
        />
      )}
    </div>
  );
}

function DeviceCard({
  device, isCurrent, sourceInfo, isEditing, editValue, onEditValueChange,
  onStartEdit, onCancelEdit, onSave, onRequestRevoke, error,
}: {
  device: Device;
  isCurrent: boolean;
  sourceInfo?: SourceInfo;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onRequestRevoke: () => void;
  error: string | null;
}) {
  const pill = sourcePillVars(device.source_key ?? 'local');
  const name = device.nickname ?? device.hostname ?? 'unnamed';
  return (
    <article style={S.card}>
      <div style={S.cardHeader}>
        <span style={{ ...S.pill, background: pill.bg, color: pill.fg }}>
          {device.source_key?.replace(/^remote:/, '') ?? 'local'}
        </span>
        {isCurrent && <span style={S.thisDevice}>this device</span>}
      </div>

      {isEditing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => onEditValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancelEdit();
          }}
          onBlur={onCancelEdit}
          style={S.editInput}
        />
      ) : (
        <button onClick={onStartEdit} style={S.nameBtn}>
          {name}
        </button>
      )}

      {error && <div style={S.error}>{error}</div>}

      <dl style={S.cardMeta}>
        <dt>Status</dt>
        <dd style={device.online ? S.online : S.offline}>
          {device.online ? 'online' : 'offline'}
        </dd>
        <dt>Clips</dt>
        <dd>{sourceInfo?.clip_count ?? 0}</dd>
        <dt>Last seen</dt>
        <dd>{device.last_seen ? formatTime(device.last_seen) : '—'}</dd>
      </dl>

      {!isCurrent && (
        <button onClick={onRequestRevoke} style={S.revokeBtn}>
          Revoke
        </button>
      )}
    </article>
  );
}

function SourceOnlyCard({ source }: { source: SourceInfo }) {
  const pill = sourcePillVars(source.source);
  return (
    <article style={{ ...S.card, opacity: 0.7 }}>
      <div style={S.cardHeader}>
        <span style={{ ...S.pill, background: pill.bg, color: pill.fg }}>
          {source.source.replace(/^remote:/, '')}
        </span>
      </div>
      <div style={S.nameBtn}>{source.source.replace(/^remote:/, '')}</div>
      <dl style={S.cardMeta}>
        <dt>Status</dt>
        <dd style={S.offline}>unpaired</dd>
        <dt>Clips</dt>
        <dd>{source.clip_count}</dd>
      </dl>
    </article>
  );
}

function PairCard() {
  return (
    <article style={{ ...S.card, ...S.pairCard }}>
      <div style={S.pairTitle}>Pair a new machine</div>
      <div style={S.pairBody}>
        Run <code style={S.code}>cinch auth pair</code> on the remote box.
      </div>
    </article>
  );
}

const S: Record<string, CSSProperties> = {
  panel: {
    flex: 1,
    minWidth: 0,
    padding: '24px 32px',
    overflowY: 'auto',
    background: C.bg,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 16,
  },
  card: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  pairCard: {
    border: `1px dashed ${C.border}`,
    background: 'transparent',
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: 160,
  },
  pairTitle: {
    fontFamily: 'var(--font-serif)',
    fontSize: 16,
    fontWeight: 400,
    color: C.t2,
    letterSpacing: '-0.01em',
  },
  pairBody: {
    fontSize: 12,
    color: C.t3,
    lineHeight: 1.55,
  },
  code: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    background: C.card2,
    padding: '1px 6px',
    borderRadius: 3,
    color: C.t1,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  pill: {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 9999,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.04em',
  },
  thisDevice: {
    marginLeft: 'auto',
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    color: C.t3,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  nameBtn: {
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    fontFamily: 'var(--font-serif)',
    fontSize: 17,
    fontWeight: 400,
    letterSpacing: '-0.02em',
    color: C.t1,
    cursor: 'pointer',
    textAlign: 'left',
  },
  editInput: {
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 14,
    fontFamily: 'var(--font-body)',
    color: C.t1,
    outline: 'none',
  },
  error: {
    fontSize: 11,
    color: 'var(--error)',
  },
  cardMeta: {
    margin: 0,
    display: 'grid',
    gridTemplateColumns: '70px 1fr',
    rowGap: 4,
    columnGap: 10,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  },
  online: { color: 'var(--success)', margin: 0 },
  offline: { color: C.t3, margin: 0 },
  revokeBtn: {
    background: 'transparent',
    border: `1px solid ${C.border}`,
    color: C.t3,
    padding: '4px 12px',
    borderRadius: 5,
    fontSize: 11,
    cursor: 'pointer',
    alignSelf: 'flex-start',
    fontFamily: 'inherit',
  },
  placeholder: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: C.t3,
    fontSize: 12,
    fontFamily: 'var(--font-serif)',
  },
};
```

- [ ] **Step 14.3: Delete `DeviceDashboard.tsx`**

```bash
cd desktop
git rm src/components/DeviceDashboard.tsx
```

- [ ] **Step 14.4: Run all tests**

Run: `cd desktop && npm test`
Expected: All tests PASS. App.test.tsx still verifies the dashboard renders for `Authenticated`. PinnedPanel and MachinesPanel have no dedicated tests (their logic is straightforward; the main flow is exercised by App).

- [ ] **Step 14.5: Build**

Run: `cd desktop && npm run build`
Expected: PASS, zero TS errors.

- [ ] **Step 14.6: Commit Tasks 12 + 13 + 14 together**

```bash
cd desktop
git add src/App.tsx \
        src/components/Rail.tsx src/components/Rail.test.tsx \
        src/components/SearchBar.tsx \
        src/components/ClipList.tsx src/components/ClipList.test.tsx \
        src/components/ClipDetail.tsx src/components/ClipDetail.test.tsx \
        src/components/StatusBar.tsx \
        src/components/PinnedPanel.tsx \
        src/components/MachinesPanel.tsx \
        src/components/dialogPrimitives.ts
git rm src/components/DeviceDashboard.tsx
git commit -m "ui: extract App into Rail/SearchBar/ClipList/ClipDetail/StatusBar/Pinned/Machines

App.tsx becomes a slim orchestrator (~320 lines, down from 633). Behavior
preserved: every keyboard shortcut, every Tauri command call, every
useEffect lifecycle. New layout: 56px icon rail · 320px clip list ·
flexible detail · 28px status bar. PinnedPanel and MachinesPanel
replace the in-rail per-source items and DeviceDashboard.

Tests: ClipList (6), ClipDetail (5), Rail (4), timeBuckets (7),
sourceColor (4), clipTitle (6) — all green. App.test.tsx unchanged."
```

---

## Task 15 — Reskin `LocalOnlyView`, `AuthLoadingScreen`, `AuthErrorScreen`

**Files:**
- Modify: `desktop/src/components/LocalOnlyView.tsx`
- Modify: `desktop/src/App.tsx` (the `AuthLoadingScreen` and `AuthErrorScreen` functions inside)

- [ ] **Step 15.1: Update `LocalOnlyView.tsx` styles to use new tokens**

Open `desktop/src/components/LocalOnlyView.tsx`. The structure is preserved; only inline styles change. In the `S` style object (lines 343-428):

- `searchBar`: change `height: 48` → `height: 50`, set `background: C.card`, set `padding: '0 18px'`, set `gap: 12`.
- `searchInput`: change `border: '1px solid C.border'` → `border: 'none'`, change `background: C.bg` → `background: 'transparent'`, change `borderRadius: 8` → remove, change `fontSize: 16` → `fontSize: 15`, set `fontFamily: 'var(--font-serif)'`, set `letterSpacing: '-0.01em'`.
- `clipList`: keep as-is (LocalOnlyView's clip list is the existing ClipCard structure, separate from the dashboard's ClipList).

Replace the `searchBar` and `searchInput` style entries verbatim:

```ts
searchBar: {
  display: 'flex',
  alignItems: 'center',
  height: 50,
  padding: '0 18px',
  gap: 12,
  background: C.card,
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
},
searchInput: {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: 'var(--font-serif)',
  fontSize: 15,
  fontWeight: 400,
  letterSpacing: '-0.01em',
  color: C.t1,
},
```

- [ ] **Step 15.2: Update `AuthLoadingScreen` typography in App.tsx**

In `desktop/src/App.tsx`, find `AuthLoadingScreen` (around line 672). Replace the `heading` and `subtext` `<span>` styles:

For the heading (currently `fontFamily: "Inter, system-ui..."`, `fontSize: 20`):
```ts
fontFamily: 'var(--font-serif)',
fontSize: 22,
fontWeight: 400,
letterSpacing: '-0.02em',
color: C.t1,
```

For the subtext: change `fontFamily: "Inter, ..."` → `fontFamily: 'var(--font-body)'`. Keep size 14.

For the spinner: change `borderTopColor: C.accent`, `borderRightColor: C.accent`, `borderBottomColor: C.accent` → `borderTopColor: C.t1`, `borderRightColor: C.t1`, `borderBottomColor: C.t1` (selection-bar / text-primary instead of teal).

For the static dot in reduced-motion: `backgroundColor: C.accent` → `backgroundColor: C.t1`.

For the cancel button: change `fontFamily: "Inter, ..."` → `fontFamily: 'var(--font-body)'`. Keep ghost-button styling.

- [ ] **Step 15.3: Update `AuthErrorScreen` typography**

In `AuthErrorScreen` (around line 795), wrap the `<span>` containing `label` (the error text) with the same serif title styling used for AuthLoadingScreen heading. The retry button uses `S.btnPrimary` from App's style object — but step 12 trimmed those out. Update to use `dialogStyles.btnPrimary` from `dialogPrimitives.ts`:

```tsx
import { dialogStyles } from './components/dialogPrimitives';
// ...
<button onClick={...} style={dialogStyles.btnPrimary} disabled={retrying}>Retry now</button>
```

- [ ] **Step 15.4: Run all tests**

Run: `cd desktop && npm test`
Expected: All tests PASS, including LocalOnlyView's existing test suite.

- [ ] **Step 15.5: Commit**

```bash
cd desktop
git add src/components/LocalOnlyView.tsx src/App.tsx
git commit -m "ui: reskin LocalOnlyView + auth screens with editorial tokens"
```

---

## Task 16 — Reskin secondary components (`ClipCard`, dialogs, prompts)

**Files:**
- Modify: `desktop/src/components/ClipCard.tsx` (LocalOnly clip card — different from dashboard list)
- Modify: `desktop/src/components/AddRelayDialog.tsx`
- Modify: `desktop/src/components/AdoptedAuthToast.tsx`
- Modify: `desktop/src/components/EmptyState.tsx`
- Modify: `desktop/src/components/OfflineBar.tsx`
- Modify: `desktop/src/components/UpgradePrompt.tsx`
- Modify: `desktop/src/SettingsPane.tsx`
- Modify: `desktop/src/RetentionSlider.tsx`
- Modify: `desktop/src/ConfirmDialog.tsx`

These reskins are mechanical: replace any `Inter` font reference with `var(--font-body)`, replace `JetBrains Mono` with `var(--font-mono)`, swap teal `C.accent` references in non-semantic spots (selection bars, dot indicators) with `var(--selection-bar)` or `C.t1`. Existing test suites must continue to pass.

- [ ] **Step 16.1: Sweep all files for `'Inter'` and `'JetBrains Mono'` literal references**

Run from desktop dir:

```bash
grep -RIn --include='*.ts*' "'Inter" src
grep -RIn --include='*.ts*' "JetBrains Mono" src
grep -RIn --include='*.ts*' "Inter," src
```

For each match:
- Inline `fontFamily: "'Inter', ..."` → `fontFamily: 'var(--font-body)'`
- Inline `fontFamily: "'JetBrains Mono', monospace"` → `fontFamily: 'var(--font-mono)'`

- [ ] **Step 16.2: Sweep for non-semantic teal accent uses**

```bash
grep -RIn --include='*.ts*' "C\.accent" src
grep -RIn --include='*.ts*' "var(--accent)" src
```

For each match, decide:
- **Keep teal** if: focus ring (`:focus-visible`), offline pulse dot, online status indicator dots in MachinesPanel, semantic info color in error/warning chips. (Per spec section 4: teal preserved in semantic spots.)
- **Replace with `C.t1`** if: selection borders, primary CTA backgrounds, active-state highlights, list-row left bars.
- **Replace with neutral pill or surface** if: badge backgrounds for non-semantic identity (e.g. `from:` token chip).

Document each replacement decision inline in the commit message.

- [ ] **Step 16.3: `ClipCard.tsx` — apply new tokens**

Open `desktop/src/components/ClipCard.tsx`. This is the rich clip card used in LocalOnlyView (different from the dashboard list row).

Update all `fontFamily: "'Inter', ..."` → `var(--font-body)`. Update all `fontFamily: "'JetBrains Mono', ..."` → `var(--font-mono)`. Find any selected-state border using `C.accent`, swap to `var(--selection-bar)`.

- [ ] **Step 16.4: `AddRelayDialog.tsx` and other dialogs**

For each file: replace `Inter` and `JetBrains Mono` font literals. If the dialog has its own `S.dialog` / `S.overlay`, refactor to import from `dialogPrimitives.ts` and reference `dialogStyles.overlay`, etc.

For `ConfirmDialog.tsx` specifically: ensure it uses `dialogStyles` and that dark-mode shadow override in App.css line 209 (`html.light .confirm-dialog`) still applies.

- [ ] **Step 16.5: `EmptyState.tsx` — adopt serif heading**

In `EmptyState.tsx`, find the heading (the `<div>` or `<h2>` element that says e.g. "No clips yet"). Apply:

```ts
fontFamily: 'var(--font-serif)',
fontSize: 22,
fontWeight: 400,
letterSpacing: '-0.02em',
```

Body text remains `var(--font-body)`.

- [ ] **Step 16.6: `SettingsPane.tsx` — token sweep + serif section headings**

This is the largest reskin file. Sweep for Inter/JBM/teal. Section headings (e.g. "Theme", "Retention", "Devices") become serif:

```ts
fontFamily: 'var(--font-serif)',
fontSize: 17,
fontWeight: 400,
letterSpacing: '-0.02em',
color: C.t1,
```

Form labels and helper text remain `var(--font-body)`.

- [ ] **Step 16.7: `RetentionSlider.tsx`**

Apply font sweep. The slider element's CSS in App.css already covers focus-ring color (Step 1.6).

- [ ] **Step 16.8: Run all tests**

Run: `cd desktop && npm test`
Expected: All tests PASS. Visual snapshot tests (if any) need regeneration: `npm test -- --update`. Re-run after to confirm.

- [ ] **Step 16.9: Commit**

```bash
cd desktop
git add src/components/ClipCard.tsx \
        src/components/AddRelayDialog.tsx \
        src/components/AdoptedAuthToast.tsx \
        src/components/EmptyState.tsx \
        src/components/OfflineBar.tsx \
        src/components/UpgradePrompt.tsx \
        src/SettingsPane.tsx \
        src/RetentionSlider.tsx \
        src/ConfirmDialog.tsx
git commit -m "ui: token sweep on remaining components

- Replace Inter literal with var(--font-body) (all matches)
- Replace JetBrains Mono with var(--font-mono) (all matches)
- Replace non-semantic C.accent (teal) with C.t1 / var(--selection-bar)
- Apply serif headings to EmptyState and SettingsPane sections
- Refactor dialogs to import from dialogPrimitives.ts"
```

---

## Task 17 — Window resize policy

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json`

The current window is fixed `width: 900, height: 580, resizable: false`. Spec section 3 requires the master-detail to read at 760×480; we widen the default a touch and enable resize.

- [ ] **Step 17.1: Update window config**

Open `desktop/src-tauri/tauri.conf.json`. In the windows array (lines 14-23), change:

```json
{
  "title": "Cinch",
  "width": 960,
  "height": 600,
  "minWidth": 760,
  "minHeight": 480,
  "visible": false,
  "decorations": false,
  "transparent": true,
  "shadow": true,
  "resizable": true,
  "backgroundColor": [0, 0, 0, 0]
}
```

(Width 900 → 960 to give the redesign more breathing room while keeping resizable hard floor at 760×480.)

- [ ] **Step 17.2: Verify Tauri builds**

Run: `cd desktop && npm run tauri:dev` (kill once it launches without error). Confirm window resizes.

If `tauri:dev` is too heavy in this step, just `cd desktop && cargo check --manifest-path src-tauri/Cargo.toml`.

- [ ] **Step 17.3: Commit**

```bash
cd desktop
git add src-tauri/tauri.conf.json
git commit -m "ui: enable window resize with 760×480 minimum"
```

---

## Task 18 — Acceptance check + final cleanup

- [ ] **Step 18.1: Manual font verification**

Run from desktop:

```bash
grep -RIn --include='*.ts*' "Inter" src
grep -RIn --include='*.ts*' "JetBrains" src
grep -RIn "Inter\|JetBrains" index.html
```

Expected: zero matches except in comments. If any code path still references Inter or JetBrains Mono, fix it before continuing.

- [ ] **Step 18.2: Run full test suite**

```bash
cd desktop && npm test
```

Expected: ALL existing + new tests pass.

Test count: existing (App: 4, ClipCard: ~existing count, EmptyState, LocalOnlyView, AddRelayDialog, UpgradePrompt, SettingsPane, auth) + new (Rail: 4, ClipList: 6, ClipDetail: 5, timeBuckets: 7, sourceColor: 4, clipTitle: 6).

- [ ] **Step 18.3: Manual keyboard-shortcut walk-through**

Launch dev: `cd desktop && npm run tauri:dev`. With auth in `Authenticated` state and at least one clip in the list, manually verify:

| Shortcut | Expected |
|---|---|
| ⌘F | Search input gains focus |
| Esc (in search) | Blurs |
| Esc (after blur) | Clears query, then deselects clip |
| ↓ / ↑ | Moves selection between clips |
| Ctrl+J / Ctrl+K | Same as ↓ / ↑ |
| ↵ (clip selected) | Copies clip to clipboard, toast |
| ⌘C (clip selected, no text selection) | Copies clip |
| ⌘⌫ | Deletes selected clip |
| ⌘P | Opens pin-note dialog (or unpins if pinned) |
| ⌘, | Opens Settings sheet |
| ? | Toggles shortcut panel |
| Ctrl+H / Ctrl+L | Cycles source filter |

If any fail, the bug is in App.tsx (Task 12) — the keyboard handler block (around line 256) was preserved verbatim, so check that nothing was accidentally trimmed.

- [ ] **Step 18.4: Manual visual check vs mockups**

With `npm run tauri:dev` running:

1. Verify light theme matches `.superpowers/brainstorm/69739-1777614529/content/07-integrated-design.html` "Light · Editorial" panel:
   - Warm bone canvas
   - Lyon/Newsreader serif on clip detail title
   - 56px rail with 4 icons
   - Color-coded source pills (deterministic per machine)
   - Section labels "Today" / "Yesterday" in SF Mono uppercase
2. Toggle to dark theme (sun/moon icon in search bar). Verify it matches the mockup's "Dark · Editorial" panel:
   - Cream-tinted dark canvas (#16140F)
   - Same serif title
   - Translucent cream-tint pills (lower contrast than light)
3. Click Pinned icon: verify list re-groups by pin note.
4. Click Machines icon: verify card grid renders, "this device" badge on current.
5. Resize window to 760×480: verify nothing truncates.

- [ ] **Step 18.5: Final commit if any tweaks**

If steps 18.1-18.4 surfaced minor fixes:

```bash
cd desktop
git add -A
git commit -m "ui: acceptance polish — keyboard shortcut + visual fixes"
```

If everything is clean, no final commit needed.

---

## Self-Review (run after writing the plan)

**1. Spec coverage**

| Spec section | Implementing task |
|---|---|
| §1 Goal · Refined + Simpler | All tasks (kept simple where tradeoffs allow) |
| §2 Inbox hero, Search 1-keystroke | T8 (SearchBar autoFocus + ⌘F kbd), T9 (ClipList) |
| §3 Layout (rail + list + detail + status) | T7, T9, T10, T11, T12 |
| §4 Visual tone (light + dark editorial) | T1 |
| §5 Typography (SF Pro + Lyon serif + SF Mono, drop Inter) | T1, T15, T16 |
| §6 Iconography (object metaphors, 1.7 stroke) | T5 |
| §7.1 Rail | T7 |
| §7.2 ClipList | T9 |
| §7.3 ClipDetail | T10 |
| §7.4 SearchBar | T8 |
| §7.5 StatusBar | T11 |
| §7.6 Pinned panel | T13 |
| §7.7 Machines panel | T14 |
| §7.8 Settings sheet reskin | T16 |
| §7.9 Auth states reskin | T15 |
| §8 Spacing (8 + 12 base) | T1 (--sp-md added) |
| §9 Motion (instant hover, 100ms icon, 150ms theme, 200ms toast) | T7, T9, T10 (transitions on style objects) |
| §10 Component file map | T7-T14 |
| §11 Out of scope | (no task — confirmed deferred) |
| §12 Open questions: Lyon licensing, min window, hash collision | Lyon → Newsreader fallback (T1.1), min window (T17), hash collision tolerated (T2 test) |
| §13.1 Keyboard shortcuts work | T18.3 |
| §13.2 All tests pass | T18.2 |
| §13.3 Visual mockup match | T18.4 |
| §13.4 Inter/JBM removed | T18.1 |
| §13.5 Teal not as primary accent | T16.2 |
| §13.6 760×480 readable | T17, T18.4 |

All spec sections covered.

**2. Placeholder scan**

Searched the plan for: TBD, TODO, "implement later", "fill in", "etc.", "appropriate error handling", "similar to Task N".

- T16 step 16.4 says "For each file: replace Inter and JetBrains Mono font literals" — this is mechanical pattern-matching, not a placeholder. Acceptable because the next sub-step gives the exact replacement values.
- T14.1 says "Read DeviceDashboard.tsx end-to-end and copy its non-JSX logic" with a list of specific items — this is a concrete extraction list, not vague guidance.
- T18.4 says "manual visual check" — this is appropriate for a UI redesign acceptance step; no automated visual diff exists.

No placeholders.

**3. Type/name consistency check**

- `RailPanel` type in T7 = `'inbox' | 'pinned' | 'machines'`. Used identically in T12 (`useState<RailPanel>`).
- `Rail` props: `active`, `onSelect`, `onOpenSettings`. Used identically in T12 step 12.4.
- `ClipList` props: `clips`, `selected`, `onSelect`, `onCopy`, `query`, `deviceNicknames`, `now?`. Used identically in T12.
- `ClipDetail` props: `clip`, `onCopy`, `onPin`, `onDelete`. Used identically in T12 (note: in T12 we pass an `onPin` that toggles between pin and unpin internally; ClipDetail's button label flips based on `clip.is_pinned`).
- `PinnedPanel` props in T13 use `onPin` and `onUnpin` separately. T12 supplies both correctly.
- `MachinesPanel` props in T14: `currentDeviceID`, `onShowToast`, `onDeviceChange`. Used identically in T12.
- `sourcePillVars(source)` in T2 returns `{ bg, fg }` (CSS var strings). Used in T6 (SourcePill), T14 (MachinesPanel).
- `groupByTimeBucket` in T3 returns `BucketGroup<T>[]` with `bucket` and `items`. Used in T9 (ClipList) consistently.
- `clipTitle(clip)` in T4 takes `TitleableClip` (subset of LocalClip). T10 passes a full LocalClip — TS structural typing accepts it.

Consistent.

**4. Scope check**

This plan is a single coherent UI reskin + extraction effort. No backend, no new feature, no protocol change. Could be split into "Foundation + Atoms" (T1-T6) → "Component Extraction" (T7-T14) → "Polish" (T15-T18) if the engineer wants natural review checkpoints, but as one plan it's still tractable: ~80 steps, mostly TDD or mechanical sweeps, ~1-2 days of focused work.

Plan complete.
