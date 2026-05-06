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
});
