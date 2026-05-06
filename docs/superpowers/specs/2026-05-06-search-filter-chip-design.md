# Search Filter Chip Design

**Date:** 2026-05-06  
**Status:** Approved

## Summary

Remove the category filter pill row that sits below the search bar and integrate its functionality directly into the search input as a keyboard-driven chip with an autocomplete dropdown.

## Problem

The filter pill row (all / text / image / code / url) occupies a permanent 36px horizontal band beneath the search bar, cluttering the layout even when the filter is not in use. The feature is visual-only and mouse-dependent.

## Design

### Trigger

Typing `#` anywhere in the search input opens the filter dropdown. No `type:` syntax — it would conflict with real clip content (TypeScript/Go code commonly contains `type:` patterns).

### Dropdown

- Appears immediately below the search bar on `#` keypress.
- Shows all five options: `all`, `text`, `image`, `code`, `url`, each with a colored dot and a short hint label on the right.
- As the user continues typing after `#` (e.g. `#c`), the list narrows in real-time: matching items stay highlighted, non-matching items dim. The first match is always pre-highlighted.
- Selection methods (all equivalent):
  - `↑` / `↓` to navigate, `Enter` to confirm
  - Type first letter(s) to narrow, `Enter` to confirm the highlighted item
  - Click any item
- `Escape` closes the dropdown without changing the active filter.

### Chip

- On selection the typed `#xxx` token is removed from the input value and replaced by a colored chip inside the search bar, to the left of the cursor. **Exception: selecting `all` removes any existing chip and resets to default — no chip is shown for the `all` state.**
- The chip uses the same dot colors as the old pills (text → blue, image → green, code → amber, url → purple).
- The chip has an `✕` button. Clicking it removes the filter and resets to `all`.
- Pressing `Backspace` when the text portion of the query is empty also removes the chip.
- Clicking the chip body (not `✕`) reopens the dropdown with the current filter pre-highlighted, allowing the user to switch filters without clearing first.
- If a chip is already active and the user types `#` in the text portion, the dropdown reopens to allow switching the filter. The existing chip is replaced by whatever the user selects next.

### Combining with text search

The chip filter and the text query are independent. A user can have `#code` chip active and type `sort` to fuzzy-search code clips containing "sort". The existing `from:<nickname>` source filter also continues to work alongside the chip filter.

### Placeholder hint

When no filter is active the placeholder reads: `Search clips…  # to filter`

When a filter chip is active the placeholder is empty (the chip is visible).

## Architecture

### Components

**`SearchBar.tsx`** — owns the chip/dropdown UI.

New props:
```ts
activeFilter: ClipFilter        // passed down from App
onFilterChange: (f: ClipFilter) => void
```

Internal state:
```ts
dropdownOpen: boolean
highlightedIndex: number        // index into CLIP_FILTERS
dropdownQuery: string           // characters typed after #
```

Logic:
- `onChange` intercepts input: if it detects a `#` character, strip it and set `dropdownOpen = true`, accumulate subsequent characters in `dropdownQuery` for narrowing.
- On dropdown selection: call `onFilterChange(selected)`, clear `dropdownQuery`, close dropdown, leave `value` clean (no `#` token in it).
- On chip `✕` or Backspace-on-empty: call `onFilterChange('all')`.
- On chip click: reopen dropdown with current filter pre-highlighted.
- `useEffect` adds a `keydown` listener for `Escape` to close dropdown.

**`App.tsx`** — minimal changes:
- Remove the `filterRow` JSX block entirely.
- Pass `activeFilter` and `onFilterChange={setActiveFilter}` to `<SearchBar>`.
- All downstream filter logic (`applyClipFilter`, `typeFilteredClips`) remains unchanged.

**`clipFilters.ts`** — no changes needed.

### Data flow

```
User types # in SearchBar
  → SearchBar opens dropdown
  → User selects "code"
  → SearchBar calls onFilterChange("code")
  → App sets activeFilter = "code"
  → applyClipFilter(filteredClips, "code") → typeFilteredClips
  → ClipList renders filtered clips
```

## What is removed

- The `filterRow` div and all its styles in `App.tsx` (lines ~444–458, ~966–1010).
- The `activeFilter` default reset in the Rail `onSelect` handler stays — switching panels still resets to `all`.

## Keyboard shortcuts

No new global shortcuts added. The `#` trigger is local to the search input. The existing `⌘F` focus shortcut remains.

## Testing

- `SearchBar` unit tests: `#` opens dropdown, typing narrows, Enter selects, Escape closes, Backspace removes chip.
- Integration: filter chip + text query together produce correct clip subset.
- Existing `clipFilters.test.ts` unchanged — filter logic is not touched.
