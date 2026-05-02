import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipDetail } from './ClipDetail';
import type { LocalClip } from '../bindings';

const baseClip: LocalClip = {
  id: 'c1',
  user_id: 'u1',
  content: 'hello world',
  content_type: 'text',
  source: 'local',
  label: '',
  byte_size: 11,
  media_path: null,
  created_at: 1_777_614_529,
  ttl: 86400,
  synced: false,
  is_pinned: false,
  pin_note: null,
};

const noOp = () => {};

describe('ClipDetail', () => {
  it('renders empty placeholder when no clip selected', () => {
    render(<ClipDetail clip={null} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByText(/select a clip/i)).toBeInTheDocument();
  });

  it('renders clip content for selected clip', () => {
    render(<ClipDetail clip={baseClip} onCopy={noOp} onPin={noOp} onDelete={noOp} />);
    expect(screen.getByText(/hello world/i)).toBeInTheDocument();
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
