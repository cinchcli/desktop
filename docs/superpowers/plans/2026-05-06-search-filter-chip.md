# Search Filter Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static category pill row with an inline chip + autocomplete dropdown triggered by `#` inside the search bar.

**Architecture:** `SearchBar` gains `activeFilter` + `onFilterChange` props and owns all chip/dropdown state internally (`dropdownOpen`, `dropdownQuery`, `highlightedFilter`). `App.tsx` removes the `filterRow` block and passes the two new props. No changes to `clipFilters.ts` or downstream filtering logic.

**Tech Stack:** React (hooks, forwardRef), TypeScript, Vitest + React Testing Library, existing CSS-in-JS via `CSSProperties`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/components/SearchBar.tsx` | Modify | Add chip render, dropdown render, `#` interception, keyboard nav |
| `src/components/SearchBar.test.tsx` | Create | Unit tests for all filter chip behaviours |
| `src/App.tsx` | Modify | Remove `filterRow` JSX + styles, pass `activeFilter`/`onFilterChange` to `SearchBar` |

---

### Task 1: Extend SearchBar interface and scaffold test file

**Files:**
- Modify: `src/components/SearchBar.tsx`
- Create: `src/components/SearchBar.test.tsx`

- [ ] **Step 1: Add filter props to SearchBarProps**

Open `src/components/SearchBar.tsx`. Add two imports and extend the interface:

```tsx
import { forwardRef, useState, type CSSProperties } from 'react';
import { C } from '../design';
import { IconSearch, IconX, IconSun, IconMoon } from '../icons';
import { CLIP_FILTERS, type ClipFilter } from '../lib/clipFilters';

interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  activeFilter: ClipFilter;
  onFilterChange: (f: ClipFilter) => void;
}
```

Update the `forwardRef` destructure to include the two new props:

```tsx
export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ value, onChange, onClear, theme, onToggleTheme, onMouseDown, activeFilter, onFilterChange }, ref) => {
    return (
      <div style={S.bar} onMouseDown={onMouseDown} data-testid="search-bar">
        {/* existing JSX unchanged */}
      </div>
    );
  }
);
```

- [ ] **Step 2: Create SearchBar test scaffold**

Create `src/components/SearchBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { SearchBar } from './SearchBar';
import type { ClipFilter } from '../lib/clipFilters';

function renderBar(overrides: Partial<{
  value: string;
  onChange: (s: string) => void;
  activeFilter: ClipFilter;
  onFilterChange: (f: ClipFilter) => void;
}> = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  const onFilterChange = overrides.onFilterChange ?? vi.fn();
  const result = render(
    <SearchBar
      ref={createRef()}
      value={overrides.value ?? ''}
      onChange={onChange}
      onClear={vi.fn()}
      theme="dark"
      onToggleTheme={vi.fn()}
      onMouseDown={vi.fn()}
      activeFilter={overrides.activeFilter ?? 'all'}
      onFilterChange={onFilterChange}
    />
  );
  return { ...result, onChange, onFilterChange };
}

describe('SearchBar', () => {
  it('renders search input', () => {
    renderBar();
    expect(screen.getByPlaceholderText(/search clips/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to confirm they pass (scaffold only)**

```bash
cd /Users/jinmu/Programming/cinchcli/desktop && npm test -- --reporter=verbose src/components/SearchBar.test.tsx
```

Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/SearchBar.tsx src/components/SearchBar.test.tsx
git commit -m "feat: extend SearchBar with activeFilter/onFilterChange props (scaffold)"
```

---

### Task 2: `#` trigger opens dropdown (TDD)

**Files:**
- Modify: `src/components/SearchBar.test.tsx`
- Modify: `src/components/SearchBar.tsx`

- [ ] **Step 1: Write failing tests**

Add inside the `describe('SearchBar')` block in `SearchBar.test.tsx`:

```tsx
describe('filter dropdown', () => {
  it('opens when # is typed in the input', () => {
    renderBar();
    const input = screen.getByPlaceholderText(/search clips/i);
    fireEvent.change(input, { target: { value: '#' } });
    expect(screen.getByTestId('filter-dropdown')).toBeInTheDocument();
  });

  it('shows all five filter options when dropdown is open', () => {
    renderBar();
    fireEvent.change(screen.getByPlaceholderText(/search clips/i), { target: { value: '#' } });
    expect(screen.getByTestId('filter-option-all')).toBeInTheDocument();
    expect(screen.getByTestId('filter-option-text')).toBeInTheDocument();
    expect(screen.getByTestId('filter-option-image')).toBeInTheDocument();
    expect(screen.getByTestId('filter-option-code')).toBeInTheDocument();
    expect(screen.getByTestId('filter-option-url')).toBeInTheDocument();
  });

  it('strips # from the value passed to onChange', () => {
    const { onChange } = renderBar({ value: 'hello' });
    fireEvent.change(screen.getByPlaceholderText(/search clips/i), { target: { value: 'hello#' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('closes on Escape without calling onFilterChange', () => {
    const { onFilterChange } = renderBar();
    const input = screen.getByPlaceholderText(/search clips/i);
    fireEvent.change(input, { target: { value: '#' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('filter-dropdown')).not.toBeInTheDocument();
    expect(onFilterChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- --reporter=verbose src/components/SearchBar.test.tsx
```

Expected: 4 new tests fail with "Unable to find an element by: [data-testid="filter-dropdown"]".

- [ ] **Step 3: Add dropdown state and render to SearchBar**

Replace the entire `SearchBar.tsx` with the following (keep styles from Step 4 below):

```tsx
import { forwardRef, useState, useCallback, type CSSProperties } from 'react';
import { C } from '../design';
import { IconSearch, IconX, IconSun, IconMoon } from '../icons';
import { CLIP_FILTERS, type ClipFilter } from '../lib/clipFilters';

const FILTER_HINTS: Record<ClipFilter, string> = {
  all:   'show everything',
  text:  'plain / json',
  image: 'screenshots',
  code:  'code blocks',
  url:   'links',
};

interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  activeFilter: ClipFilter;
  onFilterChange: (f: ClipFilter) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ value, onChange, onClear, theme, onToggleTheme, onMouseDown, activeFilter, onFilterChange }, ref) => {
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [dropdownQuery, setDropdownQuery] = useState('');
    const [highlightedFilter, setHighlightedFilter] = useState<ClipFilter>('all');

    const matchingFilters = CLIP_FILTERS.filter(
      f => dropdownQuery === '' || f.startsWith(dropdownQuery)
    );

    const openDropdown = useCallback((preHighlight: ClipFilter = 'all') => {
      setDropdownOpen(true);
      setDropdownQuery('');
      setHighlightedFilter(preHighlight);
    }, []);

    const closeDropdown = useCallback(() => {
      setDropdownOpen(false);
      setDropdownQuery('');
    }, []);

    const selectFilter = useCallback((f: ClipFilter) => {
      onFilterChange(f);
      closeDropdown();
    }, [onFilterChange, closeDropdown]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const hashIdx = raw.indexOf('#');
      if (hashIdx !== -1) {
        openDropdown(CLIP_FILTERS[0]);
        onChange(raw.slice(0, hashIdx));
        return;
      }
      onChange(raw);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Remove chip on Backspace when text is empty and no dropdown
      if (e.key === 'Backspace' && !dropdownOpen && value === '' && activeFilter !== 'all') {
        onFilterChange('all');
        return;
      }
      if (!dropdownOpen) return;

      const idx = matchingFilters.indexOf(highlightedFilter);
      const safeIdx = idx === -1 ? 0 : idx;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedFilter(matchingFilters[(safeIdx + 1) % matchingFilters.length]);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedFilter(matchingFilters[(safeIdx - 1 + matchingFilters.length) % matchingFilters.length]);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectFilter(highlightedFilter);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (dropdownQuery.length > 0) {
          const q = dropdownQuery.slice(0, -1);
          setDropdownQuery(q);
          const first = CLIP_FILTERS.find(f => q === '' || f.startsWith(q)) ?? highlightedFilter;
          setHighlightedFilter(first);
        } else {
          closeDropdown();
        }
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const q = dropdownQuery + e.key.toLowerCase();
        setDropdownQuery(q);
        const first = CLIP_FILTERS.find(f => f.startsWith(q)) ?? highlightedFilter;
        setHighlightedFilter(first);
      }
    };

    return (
      <div style={S.bar} onMouseDown={onMouseDown} data-testid="search-bar">
        <span style={S.glass}><IconSearch size={14} /></span>

        {activeFilter !== 'all' && (
          <span
            style={{ ...S.chip, ...S[`chip_${activeFilter}`] }}
            data-testid="filter-chip"
            onClick={() => openDropdown(activeFilter)}
          >
            <span style={{ ...S.chipDot, ...S[`dot_${activeFilter}`] }} />
            {activeFilter}
            <span
              style={S.chipX}
              data-testid="filter-chip-x"
              onClick={(e) => { e.stopPropagation(); onFilterChange('all'); }}
            >
              ✕
            </span>
          </span>
        )}

        <input
          ref={ref}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={activeFilter === 'all' ? 'Search clips…  # to filter' : ''}
          aria-label="Search clips"
          spellCheck={false}
          autoFocus
          style={S.input}
        />

        {value && (
          <button type="button" onClick={onClear} aria-label="Clear search" style={S.iconBtn}>
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

        {dropdownOpen && (
          <div style={S.dropdown} data-testid="filter-dropdown">
            {CLIP_FILTERS.map((f) => {
              const matches = dropdownQuery === '' || f.startsWith(dropdownQuery);
              return (
                <div
                  key={f}
                  style={{
                    ...S.dropItem,
                    ...(highlightedFilter === f ? S.dropItemHL : {}),
                    ...(!matches ? S.dropItemDim : {}),
                  }}
                  aria-selected={highlightedFilter === f}
                  data-testid={`filter-option-${f}`}
                  onMouseDown={(e) => { e.preventDefault(); selectFilter(f); }}
                >
                  <span style={{ ...S.dropDot, ...S[`dot_${f}`] }} />
                  {f}
                  <span style={S.dropHint}>{FILTER_HINTS[f]}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';
```

- [ ] **Step 4: Add styles**

After the component, replace the `S` object with:

```tsx
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
    position: 'relative',
  },
  glass: { color: C.t2, display: 'flex', alignItems: 'center' },
  input: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    fontFamily: 'var(--font-body)',
    fontSize: 15,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: C.t1,
    minWidth: 0,
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
  // Chip
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 7px',
    borderRadius: 20,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.03em',
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
  },
  chip_text:  { background: 'rgba(74,158,255,0.12)', color: 'var(--info)',    border: '1px solid rgba(74,158,255,0.25)' },
  chip_image: { background: 'rgba(74,223,128,0.12)', color: 'var(--success)', border: '1px solid rgba(74,223,128,0.25)' },
  chip_code:  { background: 'rgba(255,170,51,0.12)', color: 'var(--warning)', border: '1px solid rgba(255,170,51,0.25)' },
  chip_url:   { background: 'rgba(170,102,255,0.12)', color: 'var(--accent)', border: '1px solid rgba(170,102,255,0.25)' },
  chipDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'currentColor',
    flexShrink: 0,
  },
  chipX: {
    fontSize: 9,
    opacity: 0.55,
    marginLeft: 2,
    cursor: 'pointer',
  },
  // Dropdown
  dropdown: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderTop: 'none',
    zIndex: 100,
    padding: '3px 0',
  },
  dropItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 18px',
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    color: C.t2,
  },
  dropItemHL: {
    background: C.selected,
    color: C.t1,
  },
  dropItemDim: {
    opacity: 0.28,
  },
  dropHint: {
    marginLeft: 'auto',
    fontSize: 11,
    color: C.t4,
  },
  dropDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    flexShrink: 0,
  },
  // Dot colors (shared by chip and dropdown)
  dot_all:   { background: C.t3 },
  dot_text:  { background: 'var(--info)' },
  dot_image: { background: 'var(--success)' },
  dot_code:  { background: 'var(--warning)' },
  dot_url:   { background: 'var(--accent)' },
};
```

- [ ] **Step 5: Run tests — confirm 4 new tests pass**

```bash
npm test -- --reporter=verbose src/components/SearchBar.test.tsx
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/SearchBar.tsx src/components/SearchBar.test.tsx
git commit -m "feat: open filter dropdown on # in search bar"
```

---

### Task 3: Dropdown narrowing and keyboard navigation (TDD)

**Files:**
- Modify: `src/components/SearchBar.test.tsx`

The implementation is already in place from Task 2. This task adds tests to lock in the behaviour.

- [ ] **Step 1: Add narrowing and keyboard nav tests**

Add inside `describe('filter dropdown')`:

```tsx
it('dims non-matching items when a letter is typed after #', () => {
  renderBar();
  const input = screen.getByPlaceholderText(/search clips/i);
  fireEvent.change(input, { target: { value: '#' } });
  fireEvent.keyDown(input, { key: 'c' });
  // 'code' matches 'c', others do not
  const codeOption = screen.getByTestId('filter-option-code');
  const textOption = screen.getByTestId('filter-option-text');
  expect(codeOption).not.toHaveStyle({ opacity: '0.28' });
  expect(textOption).toHaveStyle({ opacity: '0.28' });
});

it('Enter selects the highlighted filter and closes dropdown', () => {
  const { onFilterChange } = renderBar();
  const input = screen.getByPlaceholderText(/search clips/i);
  fireEvent.change(input, { target: { value: '#' } });
  fireEvent.keyDown(input, { key: 'c' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onFilterChange).toHaveBeenCalledWith('code');
  expect(screen.queryByTestId('filter-dropdown')).not.toBeInTheDocument();
});

it('ArrowDown moves highlight to the next matching item', () => {
  renderBar();
  const input = screen.getByPlaceholderText(/search clips/i);
  fireEvent.change(input, { target: { value: '#' } });
  // initial highlight is 'all' (CLIP_FILTERS[0]); ArrowDown → 'text'
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getByTestId('filter-option-text')).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('filter-option-all')).toHaveAttribute('aria-selected', 'false');
});

it('clicking a dropdown item selects it', () => {
  const { onFilterChange } = renderBar();
  const input = screen.getByPlaceholderText(/search clips/i);
  fireEvent.change(input, { target: { value: '#' } });
  fireEvent.mouseDown(screen.getByTestId('filter-option-image'));
  expect(onFilterChange).toHaveBeenCalledWith('image');
});

it('selecting "all" calls onFilterChange with "all"', () => {
  const { onFilterChange } = renderBar({ activeFilter: 'image' });
  const input = screen.getByPlaceholderText(/search clips/i);
  fireEvent.change(input, { target: { value: '#' } });
  fireEvent.mouseDown(screen.getByTestId('filter-option-all'));
  expect(onFilterChange).toHaveBeenCalledWith('all');
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- --reporter=verbose src/components/SearchBar.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchBar.test.tsx
git commit -m "test: add dropdown narrowing and keyboard nav tests"
```

---

### Task 4: Chip render and removal (TDD)

**Files:**
- Modify: `src/components/SearchBar.test.tsx`

Implementation is already in place. This task adds tests.

- [ ] **Step 1: Add chip tests**

Add a new `describe('filter chip')` block:

```tsx
describe('filter chip', () => {
  it('shows chip when activeFilter is not "all"', () => {
    renderBar({ activeFilter: 'image' });
    expect(screen.getByTestId('filter-chip')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip')).toHaveTextContent('image');
  });

  it('does not show chip when activeFilter is "all"', () => {
    renderBar({ activeFilter: 'all' });
    expect(screen.queryByTestId('filter-chip')).not.toBeInTheDocument();
  });

  it('clicking ✕ calls onFilterChange with "all"', () => {
    const { onFilterChange } = renderBar({ activeFilter: 'code' });
    fireEvent.click(screen.getByTestId('filter-chip-x'));
    expect(onFilterChange).toHaveBeenCalledWith('all');
  });

  it('clicking chip body (not ✕) reopens dropdown', () => {
    renderBar({ activeFilter: 'image' });
    fireEvent.click(screen.getByTestId('filter-chip'));
    expect(screen.getByTestId('filter-dropdown')).toBeInTheDocument();
  });

  it('dropdown pre-highlights current filter when reopened from chip click', () => {
    renderBar({ activeFilter: 'code' });
    fireEvent.click(screen.getByTestId('filter-chip'));
    // 'code' option should have the highlighted style applied
    const codeOption = screen.getByTestId('filter-option-code');
    // highlighted means it does not have the dim style
    expect(codeOption).not.toHaveStyle({ opacity: '0.28' });
  });

  it('Backspace on empty input with active filter calls onFilterChange("all")', () => {
    const { onFilterChange } = renderBar({ value: '', activeFilter: 'url' });
    const input = screen.getByLabelText('Search clips');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onFilterChange).toHaveBeenCalledWith('all');
  });

  it('placeholder shows "# to filter" hint when no filter is active', () => {
    renderBar({ activeFilter: 'all' });
    expect(screen.getByPlaceholderText(/# to filter/i)).toBeInTheDocument();
  });

  it('placeholder is empty when a filter chip is active', () => {
    renderBar({ activeFilter: 'text' });
    expect(screen.getByLabelText('Search clips')).toHaveAttribute('placeholder', '');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- --reporter=verbose src/components/SearchBar.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchBar.test.tsx
git commit -m "test: add filter chip render and removal tests"
```

---

### Task 5: Wire up App.tsx — remove filterRow, pass new props

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Read App.tsx lines 444–460 and 966–1010**

Verify the filterRow JSX block and styles look like this (for reference):

```tsx
{activePanel === 'inbox' && (
  <div style={S.filterRow}>
    {CLIP_FILTERS.map((f) => (
      <button
        key={f}
        style={{ ...S.pill, ...(activeFilter === f ? S.pillActive : {}) }}
        onClick={() => setActiveFilter(f)}
        aria-pressed={activeFilter === f}
      >
        <span style={{ ...S.pillDot, ...S[`dot_${f}`] }} />
        {f}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 2: Remove the filterRow JSX block from App.tsx**

Delete the entire block above (the `{activePanel === 'inbox' && (...)}` block containing the filterRow `<div>`). The `<SearchBar>` render and the `<div style={S.body}>` remain as neighbours.

- [ ] **Step 3: Add activeFilter and onFilterChange to the SearchBar render**

Find the `<SearchBar` call in App.tsx and add the two new props:

```tsx
<SearchBar
  ref={searchRef}
  value={searchQuery}
  onChange={setSearchQuery}
  onClear={() => setSearchQuery('')}
  theme={theme}
  onToggleTheme={toggleTheme}
  onMouseDown={handleWindowDrag}
  activeFilter={activeFilter}
  onFilterChange={setActiveFilter}
/>
```

- [ ] **Step 4: Remove filterRow styles from App.tsx**

Delete these entries from the `S` object at the bottom of `App.tsx`:

```tsx
filterRow: { ... },   // ~line 966
pill: { ... },        // ~line 977
pillActive: { ... },  // ~line 993
pillDot: { ... },     // ~line 998
dot_all: { ... },     // ~line 1004
dot_text: { ... },    // ~line 1005
dot_image: { ... },   // ~line 1006
dot_code: { ... },    // ~line 1007
dot_url: { ... },     // ~line 1008
```

- [ ] **Step 5: Remove unused import**

`CLIP_FILTERS` is no longer used in `App.tsx`. Remove it from the import:

```tsx
// Before:
import { applyClipFilter, CLIP_FILTERS, type ClipFilter } from './lib/clipFilters';
// After:
import { applyClipFilter, type ClipFilter } from './lib/clipFilters';
```

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: all 17 test files pass (≥100 tests).

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: move category filter into search bar chip — remove filterRow"
```

---

### Task 6: Final smoke test

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Verify in browser**

Open the app and confirm:
1. The filter pill row is gone — the layout is tighter (SearchBar → clip list directly).
2. Placeholder in search bar reads `Search clips…  # to filter`.
3. Typing `#` opens the dropdown with all 5 options.
4. Typing `#c` → only `code` is highlighted; others are dimmed.
5. Pressing Enter selects `code` → green chip appears, dropdown closes.
6. Typing additional text in the search bar fuzzy-searches within code clips.
7. Clicking the chip reopens dropdown with `code` pre-highlighted.
8. Clicking `✕` on chip removes it and shows all clips again.
9. Pressing Backspace on empty input (with chip active) removes the chip.
10. Switching panels (Inbox → Pinned) resets filter — chip disappears.

- [ ] **Step 3: Stop dev server and close visual companion**

```bash
/Users/jinmu/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/scripts/stop-server.sh /Users/jinmu/Programming/cinchcli/desktop/.superpowers/brainstorm/40910-1778031551
```
