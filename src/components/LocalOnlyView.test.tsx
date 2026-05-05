import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import type { LocalClip } from '../bindings';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
  getCurrent: vi.fn(() => Promise.resolve(null)),
}));

// Must import after mocks
import { LocalOnlyView } from './LocalOnlyView';

const mockClip = (overrides: Partial<LocalClip> = {}): LocalClip => ({
  id: 'clip-1',
  user_id: 'local',
  content: 'Hello world',
  content_type: 'text',
  source: 'local',
  label: '',
  byte_size: 11,
  media_path: null,
  created_at: Math.floor(Date.now() / 1000) - 60,
  synced: false,
  ...overrides,
});

const defaultProps = {
  theme: 'dark' as const,
  toggleTheme: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe('LocalOnlyView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders clip list when clips exist', async () => {
    const clips = [mockClip(), mockClip({ id: 'clip-2', content: 'Second clip' })];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
      expect(screen.getByText(/Second clip/)).toBeInTheDocument();
    });
  });

  it('renders EmptyState variant="no-clips" when list_clips returns empty array', async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Copy anything to start.')).toBeInTheDocument();
    });
  });

  it('renders EmptyState variant="search-miss" when search_clips returns empty array with active query', async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve([]);
      if (cmd === 'search_clips') return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    const searchInput = screen.getByLabelText('Search clips');
    await userEvent.type(searchInput, 'nonexistent');

    await waitFor(() => {
      expect(screen.getByText(/No clips match/)).toBeInTheDocument();
    });
  });

  it('renders UpgradePrompt footer bar initially, gone after dismiss', async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    // Text is split across a <button> and a sibling text node inside a <span>;
    // check the interactive "Sign in" button instead of the composite string.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();

    const dismissBtn = screen.getByLabelText('Dismiss upgrade prompt');
    await userEvent.click(dismissBtn);

    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('renders loading skeleton before list_clips resolves', async () => {
    let resolveClips: (clips: LocalClip[]) => void;
    const pendingPromise = new Promise<LocalClip[]>((resolve) => {
      resolveClips = resolve;
    });

    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return pendingPromise;
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    // Skeleton should be visible while loading
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();

    // Resolve the clips
    await act(async () => {
      resolveClips!([]);
    });

    // Skeleton should be gone
    expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument();
  });

  it('uses customized filter rules from localStorage', async () => {
    localStorage.setItem('cinch-clip-filter-rules', JSON.stringify({
      text: ['text', 'json', 'error'],
      image: ['image'],
      code: ['code'],
      url: ['url'],
    }));
    const clips = [
      mockClip({ id: 'text-clip', content: 'Plain', content_type: 'text' }),
      mockClip({ id: 'error-clip', content: 'Boom', content_type: 'error' }),
      mockClip({ id: 'image-clip', content: '', content_type: 'image', media_path: 'media/x.png' }),
    ];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Plain/)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'text' }));

    await waitFor(() => {
      expect(screen.getByText(/Boom/)).toBeInTheDocument();
      expect(screen.queryByText(/Image/)).not.toBeInTheDocument();
    });
  });

  // ─── Keyboard handler tests (Task 2) ─────────────────

  it('Cmd+Shift+C on selected clip calls invoke("copy_clip_to_clipboard") with plain text content', async () => {
    const clips = [mockClip()];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    // Wait for clips to load, then click to select
    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    });

    // Click the clip to select it
    const clipEl = screen.getByText(/Hello world/);
    await userEvent.click(clipEl);

    // Simulate Cmd+Shift+C
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'c',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }));
    });

    expect(invoke).toHaveBeenCalledWith('copy_clip_to_clipboard', { content: 'Hello world' });
  });

  it('Cmd+F focuses search input', async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Copy anything to start.')).toBeInTheDocument();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f',
        metaKey: true,
        bubbles: true,
      }));
    });

    expect(document.activeElement).toBe(screen.getByLabelText('Search clips'));
  });

  it('Escape clears search and deselects clip', async () => {
    const clips = [mockClip()];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    });

    // Type in search
    const searchInput = screen.getByLabelText('Search clips');
    await userEvent.type(searchInput, 'test');
    expect(searchInput).toHaveValue('test');

    // Escape while focused on search -> blur
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Search should still have value (first Escape blurs)
    // Second Escape clears search
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(searchInput).toHaveValue('');
  });

  it('ArrowDown navigates clip list selection', async () => {
    const clips = [
      mockClip({ id: 'clip-1', content: 'First' }),
      mockClip({ id: 'clip-2', content: 'Second' }),
    ];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/First/)).toBeInTheDocument();
    });

    // ArrowDown should select first clip
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    // The first clip should now have aria-selected=true
    const firstCard = screen.getByText(/First/).closest('[role="button"]');
    expect(firstCard).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter copies selected clip', async () => {
    const clips = [mockClip()];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'list_clips') return Promise.resolve(clips);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    });

    // Select the clip
    await userEvent.click(screen.getByText(/Hello world/));

    // Press Enter
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(invoke).toHaveBeenCalledWith('copy_clip_to_clipboard', { content: 'Hello world' });
  });

  // ─── Search tests ──────────────────────────────────────

  it('search input filters clips via invoke("search_clips")', async () => {
    const allClips = [mockClip(), mockClip({ id: 'clip-2', content: 'Another' })];
    const searchResult = [mockClip({ id: 'clip-2', content: 'Another' })];

    vi.mocked(invoke).mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_clips') return Promise.resolve(allClips);
      if (cmd === 'search_clips') return Promise.resolve(searchResult);
      return Promise.resolve();
    });

    render(<LocalOnlyView {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Hello world/)).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText('Search clips');
    await userEvent.type(searchInput, 'Another');

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('search_clips', expect.objectContaining({ query: 'Another' }));
    });
  });
});
