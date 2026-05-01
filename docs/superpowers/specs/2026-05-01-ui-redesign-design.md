# Cinch Desktop · UI Redesign Spec

**Date**: 2026-05-01
**Status**: Approved (brainstorming complete)
**Scope**: Visual redesign of the Tauri desktop frontend (`desktop/src/`). No backend, no Tauri command, no event signature changes.

---

## 1. Goal

Two qualities, in this order:

1. **Refined** — editorial polish. Every surface looks deliberate. Reads like a tool you'd pay for.
2. **Simpler** — a non-developer should grasp the screen in 10 seconds. Reduce surface area, lead with one obvious action.

Constraints inherited from existing product:
- Existing keyboard shortcuts are preserved (muscle memory matters).
- Existing Tauri command/event surface is preserved (zero backend churn).
- Local-only mode, deep-link auth handoff, image clips, FTS5 search, pin notes, per-source auto-copy: all preserved.

## 2. Primary scenario

The hero (first surface a user sees on launch) is the **Inbox** — a chronological feed of recent clip arrivals, freshest first. The mental model is "did the thing I just pushed from my SSH box arrive?"

Secondary scenario, one keystroke away (`⌘F`): **Search** — find a clip from days ago.

Pinned and Machines are *one click in* from the rail; not on the hero.

## 3. Layout

Master-detail, three regions across:

```
┌─ traffic lights ────────────────────────────┐
│ search bar (Lyon serif placeholder, ⌘F kbd) │
├──┬──────────────────┬───────────────────────┤
│  │                  │                       │
│ R│   Clip list      │     Clip detail       │
│ a│   (320px)        │     (flex)            │
│ i│                  │                       │
│ l│                  │                       │
│56│                  │                       │
│px│                  │                       │
├──┴──────────────────┴───────────────────────┤
│ status bar — counts, kbd hints              │
└─────────────────────────────────────────────┘
```

- **Rail**: 56px wide, icon-only with hover tooltips. Items: Inbox (default), Pinned, Machines, [spacer], Settings.
- **Clip list**: 320px fixed width. Time-grouped by section labels (Today / Yesterday / This week / Older).
- **Clip detail**: fills remaining width. Header (source pill + timestamp) → Lyon serif title → code block → action buttons row → metadata list.
- **Search bar**: 50px tall, top, full width minus traffic lights.
- **Status bar**: 28px tall, bottom, full width. Clip count, machines online, kbd hints.

The 3-column rail-list-detail layout from today's app remains, but the rail shrinks (148px → 56px) and the per-source list inside today's rail is replaced by a single Machines icon that opens a dedicated machines view one click in.

## 4. Visual tone

Two themes that look like sisters, not a recolor:

### Light · Editorial

| Token | Value |
|---|---|
| Canvas | `#FBFBFA` (warm bone) |
| Surface (cards, rail, list, detail bg) | `#FFFFFF` |
| Surface-2 (selected row, codeblock, kbd) | `#F7F6F3` |
| Border | `#EAEAEA` (1px, never thicker) |
| Text · primary | `#2F3437` |
| Text · muted | `#787774` |
| Text · faint | `#B4B4B0` |
| Selection bar | `#2F3437` (2px left border) |

### Dark · Editorial

| Token | Value |
|---|---|
| Canvas | `#16140F` (warm cream-tinted dark) |
| Surface | `#1E1A12` |
| Surface-2 | `rgba(237, 230, 214, 0.05)` |
| Border | `rgba(237, 230, 214, 0.08)` |
| Text · primary | `#EDE6D6` (warm cream) |
| Text · muted | `#9C9486` |
| Text · faint | `#6A6357` |
| Selection bar | `#EDE6D6` (2px left border) |

### Source pills (color-coded, both themes)

Pills carry the source machine identity. Desaturated, never neon. Light theme uses pastel tints; dark theme uses translucent cream-tints of the same hue family.

| Source kind | Light bg / fg | Dark bg / fg |
|---|---|---|
| `prod-shell` (green) | `#EDF3EC` / `#346538` | `rgba(190,217,215,0.10)` / `#BED9D7` |
| `ci-runner-3` (amber) | `#FBF3DB` / `#956400` | `rgba(255,200,140,0.10)` / `#E8B98C` |
| `macbook` (blue) | `#E1F3FE` / `#1F6C9F` | `rgba(180,200,230,0.10)` / `#B4C8E6` |
| `local` (neutral) | `#F7F6F3` / `#787774` | `rgba(237,230,214,0.06)` / `#9C9486` |

The pill color for each source is assigned deterministically from a hash of the source key, so a given machine always reads in the same color.

### Porcelain Teal removal

Today's `--accent: #4FB3A9` is dropped as a primary surface accent. Selection in both themes is rendered with text-color contrast, not color. Teal is preserved only inside the existing semantic palette for things like the offline pulse dot and `:focus-visible` rings — it stops being a brand accent.

## 5. Typography

| Role | Light | Dark |
|---|---|---|
| Body, UI | SF Pro Display, system fallbacks (`-apple-system, system-ui`) | same |
| Clip detail title (h1) | Lyon Text, then Newsreader, Georgia fallback. 22px, weight 400, line-height 1.2, letter-spacing -0.02em | same |
| Search placeholder | Lyon Text, 15px, color = text-faint | same |
| Section labels (Today / Yesterday) | SF Mono, 10px, uppercase, letter-spacing 0.08em, color = text-faint | same |
| Source pills, timestamps, kbd | SF Mono, 9.5–10.5px depending on context, letter-spacing 0.04em | same |
| Code block | SF Mono, 12px, line-height 1.6 | same |
| Clip preview row | SF Pro Display, 13.5px, weight 400, letter-spacing -0.005em | same |

**Inter is removed.** Today's `--font-body: 'Inter'` is replaced with `'SF Pro Display', '-apple-system', system-ui, sans-serif`. JetBrains Mono is replaced by SF Mono (system) for tabular text. Lyon Text is web-loaded for the clip title and search placeholder; Newsreader is a free fallback if Lyon is unlicensed.

Font feature settings (`'calt' 1, 'kern' 1, 'liga' 1, 'ss03' 1`) on Inter are dropped — SF Pro doesn't need them.

## 6. Iconography

**Object metaphors** — concrete physical things, line weight 1.7px (Phosphor Regular family). All four glyphs are bespoke SVGs in `src/icons.tsx`:

| Function | Glyph | Why this metaphor |
|---|---|---|
| Inbox | Tray with arrow (envelope-into-tray) | Universal "things arrive here" — Mail, mailroom, paper inbox |
| Pinned | Pushpin (vintage map pin) | Universal "fastened to a board" — corkboard, sticky |
| Machines | Desktop monitor with stand | Universal "connected device" — every Mac user reads this instantly |
| Settings | Gear | Universal "system controls" |

Icon size in rail: 20px. Tooltip on hover (`title` attribute first, escalate to a styled tooltip later). Active state: pill-shaped 36px square with text-primary color and a 2px left bar (the same selection bar pattern used on rows).

## 7. Component-level changes

### 7.1 Rail (`src/App.tsx` → new `src/components/Rail.tsx`)

- 56px wide, full height between search and status bar.
- Vertical icon stack: Inbox, Pinned, Machines, spacer (`flex: 1`), Settings.
- No labels, no per-source items in the rail. (The per-source items in today's rail move into the Machines view.)
- Icon click switches the active panel (`activePanel` state lifts up to App).

### 7.2 Clip list (`src/components/ClipList.tsx`, extracted from App.tsx)

- 320px wide, scrollable.
- Section labels inserted between time buckets: Today, Yesterday, This week, Older. Computed client-side from `created_at`.
- Row markup:
  - Preview line (one line, ellipsis): SF Pro 13.5px, text-primary.
  - Meta line: source pill + middle dot + relative timestamp.
- Hover state: surface-2 background, no chrome change.
- Selected state: surface-2 background + 2px text-primary left border (replaces today's `border-left: 2px solid C.accent` teal bar).
- Type glyphs in rows are removed. Type identity is shown in the detail panel only.

### 7.3 Clip detail (`src/components/ClipDetail.tsx`, extracted)

Order top-to-bottom:

1. **Stamp line** — source pill · timestamp (full date, e.g. "Apr 30, 2026 · 14:32:18"). SF Mono 10px, uppercase, letter-spacing 0.08em.
2. **Title** — Lyon Text 22px, weight 400, letter-spacing -0.02em. Generated client-side: `<source-machine> · <type>` for terminal output, first 60 chars for text, "Image (size)" for images. The title is decorative — the underlying clip content is unchanged.
3. **Code block** — SF Mono 12px in a surface-2 box with 1px border. Wraps long lines. Image clips render as `<img>` instead.
4. **Action row** — Copy (primary, dark filled) · Pin (ghost) · Delete (ghost, right-aligned). Each button has its keyboard hint inline as a faded suffix (e.g. "Copy ↵", "Pin ⌘P", "Delete ⌘⌫").
5. **Metadata grid** — `dl`/`dt`/`dd` 2-column. SF Mono 11px. Labels uppercase letter-spacing 0.06em. Rows: Source, Type, Size, Auto-copy, Note (only if pinned).

Today's `MetaRow` and `SourcePill` components are reused. The dialog-style sub-components (`PinNoteDialog`, etc.) are reskinned with the new tokens but otherwise unchanged.

### 7.4 Search bar (top, full width)

- 50px tall.
- Lyon Text serif placeholder ("Search clips") — italic-feeling without italic.
- Right side: ⌘F kbd hint, theme toggle, settings gear (settings opens a sheet, not a separate panel).
- `from:<nickname>` token search continues to work; no syntax change.

### 7.5 Status bar (bottom, full width)

- 28px tall.
- Left: clip count · "N machines online".
- Right: kbd hints (`↵ copy`, `⌘⌫ delete`, `? shortcuts`). Hints adapt to whether a clip is selected.
- No theme toggle here (moved to search bar) — this surface is for state, not actions.

### 7.6 Pinned panel

Pinned panel uses the same master-detail layout, but the list filters to `is_pinned = true` and the section labels become groups by pin note (or "Unnamed" for untagged pins).

### 7.7 Machines panel

Machines panel replaces today's `DeviceDashboard` with a card grid (2 or 3 columns depending on width). Each card:

- Source pill in its assigned color (top-left).
- Hostname / nickname in Lyon Text 17px.
- Status badge: `online` (cream pill, dark text) or `offline` (faint pill, faint text).
- Recent clip count and last-active timestamp.
- "Pair" card with dashed border at the end.

Existing pairing flow (`AddRelayDialog`, deep-link handoff) opens unchanged.

### 7.8 Settings sheet

Existing `SettingsPane` is reskinned. Same content, new tokens. Retention slider keeps its existing CSS — the focus ring color shifts from teal to text-primary.

### 7.9 Auth states (LocalOnly, Authenticating, ErrorRecoverable)

- `LocalOnlyView` adopts the new tokens but keeps the existing ClipCard/EmptyState/UpgradePrompt structure. Search bar uses Lyon serif placeholder.
- `AuthLoadingScreen`: spinner color shifts from `--accent` to `--text-primary`. Title type changes to Lyon Text 20px.
- `AuthErrorScreen`: same.

## 8. Spacing scale

- 2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 px. (Today's tokens with one addition: 12px.)
- Whitespace between major blocks (search bar to list, list to detail, detail sections) increases by ~30% relative to today's app. Section padding grows from 18px to 22–26px.
- Border radius: 4px (kbd, codeblock corners), 6px (icon hover, codeblock), 8px (cards, dialog), 10px (window). Never larger.

## 9. Motion

Subtle, never decorative.

- Row hover: instant (no transition on background).
- Selection: instant.
- Icon hover: 100ms ease.
- Theme switch: 150ms ease on text and background.
- Toast appearance: 200ms fade + 4px translateY on enter, 200ms fade on exit. Auto-dismiss at 1800ms (existing).
- No scroll-entry animations, no staggered reveals — this is a tool, not a marketing page.

`prefers-reduced-motion` continues to be respected (existing offline pulse + spinner already do this).

## 10. Component file map

```
desktop/src/
├── App.tsx                  ← Slim orchestrator (auth gate, panel switcher, keybindings)
├── App.css                  ← New CSS custom properties (light + dark, both editorial)
├── design.ts                ← Same tokens, new values
├── icons.tsx                ← Replace 4 of the 11 existing icons (Inbox, Pin, Machines, Gear)
├── components/
│   ├── Rail.tsx             ← New, extracted from App.tsx
│   ├── SearchBar.tsx        ← New, extracted
│   ├── ClipList.tsx         ← New, extracted (includes section labels)
│   ├── ClipDetail.tsx       ← New, extracted (Lyon serif title, action row)
│   ├── StatusBar.tsx        ← New, extracted
│   ├── ClipCard.tsx         ← Reskinned (LocalOnlyView only)
│   ├── DeviceDashboard.tsx  ← Replaced by MachinesPanel.tsx
│   ├── MachinesPanel.tsx    ← New (card grid)
│   ├── PinnedPanel.tsx      ← New (master-detail with note grouping)
│   ├── SourcePill.tsx       ← Updated palette (deterministic hash → color)
│   ├── AddRelayDialog.tsx   ← Reskinned only
│   ├── AdoptedAuthToast.tsx ← Reskinned only
│   ├── EmptyState.tsx       ← Lyon serif heading
│   ├── LocalOnlyView.tsx    ← Reskinned only (no structural change)
│   ├── OfflineBar.tsx       ← Reskinned only
│   └── UpgradePrompt.tsx    ← Reskinned only
└── SettingsPane.tsx         ← Reskinned only
```

`SourcePill` deterministic color hash: a small palette of ~6 desaturated hues; pick one by `hash(source_key) % palette_length`. `local` is always neutral. `prod-shell`, `ci-runner-3`, `macbook` colors in mockups are illustrative — real machines get colors from the hash.

## 11. Out of scope (deferred)

The following ideas surfaced during brainstorming but are explicitly not in this redesign. Each can land later as its own spec.

- Search-as-command tokens (`is:pinned`, `:machines`) beyond today's `from:` token.
- Command palette (⌘K).
- Inline expand layout for clip detail.
- Snippet library (organized pinned clips with folders).
- Menu-bar popover mode.
- Onboarding flow redesign (today's flow is preserved structurally).
- Clip title generation with LLM (the v1 title is mechanical: source · type, content first 60 chars, etc.).

## 12. Open questions

- **Lyon Text licensing**: Lyon is a paid foundry typeface. If we don't have a license, ship with **Newsreader** (free, well-maintained, similar editorial feel) and treat Lyon as a future upgrade.
- **Window minimum size**: today's app has no enforced minimum. With 56 + 320 + 360 = 736px minimum for the master-detail to read well, propose a `tauri.conf.json` `minWidth: 760, minHeight: 480`. Confirm with implementation.
- **Per-source color hash collision**: 6 hues + ~20 typical machines per user = ~16% chance of two adjacent machines sharing a hue. Acceptable, since the hostname text disambiguates. If it becomes a problem, add a manual override in Machines panel.

## 13. Acceptance criteria

The redesign ships when:

1. Every existing keyboard shortcut still works (`⌘F`, `↵`, `⌘⌫`, `⌘P`, `?`, `⌘,`, `↑↓`, `⌃H/L`, `⌘C`, `⌘+Shift+C`).
2. All existing Vitest unit tests pass without backend changes (component snapshots will need regeneration; that's expected).
3. Light and dark themes both render the integrated mockup faithfully (manual visual check against `desktop/.superpowers/brainstorm/.../07-integrated-design.html`).
4. Inter and JetBrains Mono are removed from the font load path.
5. Porcelain Teal is no longer used as a primary surface accent (still allowed in semantic spots: focus rings, offline pulse).
6. The minimum render at 760×480 reads cleanly (no truncation in detail header, no overflow in rail).

---

## Appendix · Brainstorming decision trail

1. **Goal** → Refined + Simpler
2. **Primary scenario** → Inbox (1st), Search (2nd)
3. **Layout** → Master-detail (2-column body inside rail)
4. **Secondary nav** → 56px slim icon rail
5. **Icon motif** → Object metaphors (tray / pushpin / monitor / gear)
6. **Visual tone** → Editorial Light + Editorial Dark (sister themes)

Reference mockups (gitignored, brainstorm session): `.superpowers/brainstorm/69739-1777614529/content/`
