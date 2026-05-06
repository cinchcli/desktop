import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { commands } from '../bindings';
import { MachinesPanel } from './MachinesPanel';

vi.mock('../bindings', () => ({
  commands: {
    listDevices: vi.fn(),
    getSources: vi.fn(),
    getAllSourceAlertSettings: vi.fn(),
    setSourceAlertEnabled: vi.fn(),
    setDeviceNickname: vi.fn(),
    revokeDevice: vi.fn(),
  },
}));

describe('MachinesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.listDevices).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'd-prod',
          hostname: 'prod',
          source_key: 'remote:prod',
          clip_count: 3,
          last_push_at: '2026-05-06T01:00:00Z',
          online: true,
          nickname: 'Prod',
        },
      ],
    });
    vi.mocked(commands.getSources).mockResolvedValue({ status: 'ok', data: [] });
    vi.mocked(commands.getAllSourceAlertSettings).mockResolvedValue({
      status: 'ok',
      data: [{ source: 'remote:prod', alert_enabled: false }],
    });
    vi.mocked(commands.setSourceAlertEnabled).mockResolvedValue({ status: 'ok', data: null });
  });

  it('shows a per-machine desktop alert toggle and persists changes', async () => {
    render(
      <MachinesPanel
        currentDeviceID="local-device"
        onShowToast={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole('button', { name: /turn desktop alerts on for prod/i });
    expect(toggle).toHaveTextContent(/alerts off/i);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(commands.setSourceAlertEnabled).toHaveBeenCalledWith('remote:prod', true);
    });
  });
});
