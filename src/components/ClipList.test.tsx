import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipList } from './ClipList';
import type { LocalClip } from '../bindings';

const NOW = 1_777_614_529; // matches our visual companion timestamp roughly

const clip = (overrides: Partial<LocalClip>): LocalClip => {
  const createdAt = overrides.created_at ?? NOW - 60;
  return {
    id: 'c1',
    content: 'hello world',
    content_type: 'text',
    byte_size: 11,
    source: 'local',
    created_at: createdAt,
    is_pinned: false,
    pin_note: null,
    media_path: null,
    user_id: 'u1',
    label: '',
    synced: false,
    received_at: overrides.received_at ?? createdAt,
    ...overrides,
  };
};

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

  it('groups copied-again historical clips by received_at recency', () => {
    render(
      <ClipList
        clips={[clip({ id: 'old', created_at: NOW - 86400 * 30, received_at: NOW - 60 })]}
        selected={null}
        onSelect={() => {}}
        onCopy={() => {}}
        query=""
        deviceNicknames={{}}
        now={NOW}
      />
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.queryByText('Older')).not.toBeInTheDocument();
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
