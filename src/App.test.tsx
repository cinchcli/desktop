import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import { useAuthState, type AuthState } from './lib/state/auth';
import type { LocalClip } from './bindings';

// Mock the auth module: AuthProvider becomes a pass-through; useAuthState is type-safely mocked.
vi.mock('./lib/state/auth', () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAuthState: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    retryAuth: vi.fn(),
}));

// Mock Tauri APIs that are not available in the jsdom test environment.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn((cmd) => {
        if (cmd === 'list_clips' || cmd === 'list_pinned_clips' || cmd === 'get_sources' || cmd === 'list_devices') {
            return Promise.resolve([]);
        }
        if (cmd === 'get_ws_status') return Promise.resolve('connected');
        return Promise.resolve();
    }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/api/dpi', () => ({
    LogicalSize: vi.fn().mockImplementation((w: number, h: number) => ({ width: w, height: h })),
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: vi.fn(() => ({
        startDragging: vi.fn(),
        hide: vi.fn(),
        setSize: vi.fn(() => Promise.resolve()),
        listen: vi.fn(() => Promise.resolve(() => {})),
    })),
}));

describe('App', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Element.prototype.scrollIntoView = vi.fn();
        vi.mocked(invoke).mockImplementation((cmd) => {
            if (cmd === 'list_clips' || cmd === 'list_pinned_clips' || cmd === 'get_sources' || cmd === 'list_devices') {
                return Promise.resolve([]);
            }
            if (cmd === 'get_ws_status') return Promise.resolve('connected');
            return Promise.resolve();
        });
    });

    it('renders AddRelayDialog on LocalOnly variant', async () => {
        const state: AuthState = { variant: 'LocalOnly' };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByText(/Connect to relay/i)).toBeInTheDocument();
        });
        expect(screen.queryByTestId('setup-screen')).not.toBeInTheDocument();
    });

    it('does NOT render AddRelayDialog on Authenticated variant', async () => {
        const state: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'http://localhost:8080', active_relay_id: 'r1', machine_id: 'm1' },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByTestId('dashboard-root')).toBeInTheDocument();
        });
        expect(screen.queryByText(/Connect to relay/i)).not.toBeInTheDocument();
    });

    it('renders AuthLoadingScreen on Authenticating variant', async () => {
        const state: AuthState = {
            variant: 'Authenticating',
            payload: { progress: { kind: 'SigningIn' } },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByText(/signing in/i)).toBeInTheDocument();
        });
    });

    it('renders AuthErrorScreen on ErrorRecoverable variant', async () => {
        const state: AuthState = {
            variant: 'ErrorRecoverable',
            payload: { reason: { kind: 'RelayUnreachable' }, retry_after_ms: 5000 },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByText(/relay unreachable/i)).toBeInTheDocument();
        });
        expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument();
    });

    it('focuses search when / is pressed outside text input', async () => {
        const state: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'http://localhost:8080', active_relay_id: 'r1', machine_id: 'm1' },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);

        const input = await screen.findByLabelText('Search clips');
        input.blur();
        fireEvent.keyDown(window, { key: '/' });

        expect(input).toHaveFocus();
    });

    it('clears the search query after copying the selected search result with Enter', async () => {
        const clip: LocalClip = {
            id: 'c1',
            user_id: 'u1',
            content: 'needle clip',
            content_type: 'text',
            source: 'local',
            label: '',
            byte_size: 11,
            media_path: null,
            created_at: 1_777_614_529,
            synced: true,
            is_pinned: false,
            pin_note: null,
            received_at: 1_777_614_529,
        };
        vi.mocked(invoke).mockImplementation((cmd) => {
            if (cmd === 'list_clips') return Promise.resolve([clip]);
            if (cmd === 'list_pinned_clips' || cmd === 'get_sources' || cmd === 'list_devices') return Promise.resolve([]);
            if (cmd === 'get_ws_status') return Promise.resolve('connected');
            return Promise.resolve();
        });
        const state: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'http://localhost:8080', active_relay_id: 'r1', machine_id: 'm1' },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);

        const input = await screen.findByLabelText('Search clips');
        fireEvent.change(input, { target: { value: 'needle' } });
        const row = await screen.findByRole('button', { name: /needle clip/i });
        fireEvent.click(row);
        fireEvent.keyDown(window, { key: 'Enter' });

        await waitFor(() => expect(input).toHaveValue(''));
        expect(invoke).toHaveBeenCalledWith('mark_clip_copied', { id: 'c1' });
    });
});
