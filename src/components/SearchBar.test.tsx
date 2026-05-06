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
      const input = screen.getByLabelText('Search clips');
      fireEvent.change(input, { target: { value: '#' } });
      fireEvent.mouseDown(screen.getByTestId('filter-option-all'));
      expect(onFilterChange).toHaveBeenCalledWith('all');
    });
  });

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
});
