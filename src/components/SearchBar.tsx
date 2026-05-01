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
