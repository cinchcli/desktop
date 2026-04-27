import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthProvider, useAuthState, type AuthState } from './auth';

// Mock @tauri-apps/api/core and event
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

function Probe() {
    const s = useAuthState();
    return <div data-testid="variant">{s.variant}</div>;
}

describe('useAuthState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders LocalOnly by default', async () => {
        vi.mocked(invoke).mockResolvedValue({ variant: 'LocalOnly' } satisfies AuthState);
        render(<AuthProvider><Probe /></AuthProvider>);
        // Initial DEFAULT_STATE is LocalOnly.
        expect(screen.getByTestId('variant').textContent).toBe('LocalOnly');
    });

    it('reflects Authenticating state when get_auth_state resolves', async () => {
        const mock: AuthState = { variant: 'Authenticating', payload: { progress: { kind: 'SigningIn' } } };
        vi.mocked(invoke).mockResolvedValue(mock);
        render(<AuthProvider><Probe /></AuthProvider>);
        // Flush microtasks for the effect's then().
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByTestId('variant').textContent).toBe('Authenticating');
    });

    it('reflects Authenticated state with payload', async () => {
        const mock: AuthState = {
            variant: 'Authenticated',
            payload: { user_id: 'u1', device_id: 'd1', hostname: 'h', relay_url: 'r' },
        };
        vi.mocked(invoke).mockResolvedValue(mock);
        render(<AuthProvider><Probe /></AuthProvider>);
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByTestId('variant').textContent).toBe('Authenticated');
    });

    it('reflects ErrorRecoverable state', async () => {
        const mock: AuthState = {
            variant: 'ErrorRecoverable',
            payload: { reason: { kind: 'RelayUnreachable' }, retry_after_ms: 5000 },
        };
        vi.mocked(invoke).mockResolvedValue(mock);
        render(<AuthProvider><Probe /></AuthProvider>);
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByTestId('variant').textContent).toBe('ErrorRecoverable');
    });

    it('subscribes to auth-state-changed events', async () => {
        vi.mocked(invoke).mockResolvedValue({ variant: 'LocalOnly' });
        render(<AuthProvider><Probe /></AuthProvider>);
        expect(listen).toHaveBeenCalledWith('auth-state-changed', expect.any(Function));
    });
});
