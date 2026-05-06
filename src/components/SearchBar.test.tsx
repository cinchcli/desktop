import { describe, it, expect, vi } from 'vitest';
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
