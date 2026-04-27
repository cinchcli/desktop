import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Mock @tauri-apps/api/core and event at module scope since App.tsx imports them.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

describe('App', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders LocalOnlyView on LocalOnly variant', () => {
        const state: AuthState = { variant: 'LocalOnly' };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        expect(screen.getByTestId('local-only-view')).toBeInTheDocument();
        expect(screen.queryByTestId('setup-screen')).not.toBeInTheDocument();
    });

    it('does NOT render LocalOnlyView on Authenticated variant', () => {
        const state: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'http://localhost:8080' },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        expect(screen.queryByTestId('local-only-view')).not.toBeInTheDocument();
        expect(screen.getByTestId('dashboard-root')).toBeInTheDocument();
    });

    it('renders AuthLoadingScreen on Authenticating variant', () => {
        const state: AuthState = {
            variant: 'Authenticating',
            payload: { progress: { kind: 'SigningIn' } },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        expect(screen.getByText(/signing in/i)).toBeInTheDocument();
    });

    it('renders AuthErrorScreen on ErrorRecoverable variant', () => {
        const state: AuthState = {
            variant: 'ErrorRecoverable',
            payload: { reason: { kind: 'RelayUnreachable' }, retry_after_ms: 5000 },
        };
        vi.mocked(useAuthState).mockReturnValue(state);
        render(<App />);
        expect(screen.getByText(/relay unreachable/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument();
    });
});
