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
        if (matchingFilters.length === 0) return;
        setHighlightedFilter(matchingFilters[(safeIdx + 1) % matchingFilters.length]);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (matchingFilters.length === 0) return;
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
  dropdown: {
    position: 'absolute',
    top: '100%',
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
  dot_all:   { background: C.t3 },
  dot_text:  { background: 'var(--info)' },
  dot_image: { background: 'var(--success)' },
  dot_code:  { background: 'var(--warning)' },
  dot_url:   { background: 'var(--accent)' },
};
