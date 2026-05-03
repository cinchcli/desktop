import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { useAuthState, type AuthState } from './state/auth';

// Mock the auth module: AuthProvider becomes a pass-through; useAuthState is type-safely mocked.
vi.mock('./state/auth', () => ({
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
    })),
}));

describe('App', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders LocalOnlyView on LocalOnly variant', async () => {
        const state: AuthState = { variant: 'LocalOnly' };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByTestId('local-only-view')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('setup-screen')).not.toBeInTheDocument();
    });

    it('does NOT render LocalOnlyView on Authenticated variant', async () => {
        const state: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'http://localhost:8080', active_relay_id: 'r1' },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        
        await waitFor(() => {
            expect(screen.getByTestId('dashboard-root')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('local-only-view')).not.toBeInTheDocument();
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
});
