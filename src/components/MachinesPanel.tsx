import { useState, useEffect, useCallback, useRef } from 'react';
import { commands } from '../bindings';
import { unwrap } from '../lib/tauri';
import { C, formatTime } from '../design';
import { sourcePillVars } from '../lib/sourceColor';
import type { Device, SourceAlertSetting, SourceInfo } from '../bindings';
import ConfirmDialog from '../ConfirmDialog';
import { CleanupDialog } from './CleanupDialog';
import { AddSshMachineDialog } from './AddSshMachineDialog';

// ─── Props ────────────────────────────────────────────────

interface MachinesPanelProps {
  currentDeviceID: string;
  currentMachineId?: string;
  onShowToast: (message: string) => void;
  onDeviceChange?: () => void;
}

// ─── Types ────────────────────────────────────────────────

type MergedEntry =
  | { kind: 'device'; device: Device }
  | { kind: 'source_only'; source: SourceInfo }
  | { kind: 'local' };

function settingsToAlertMap(settings: SourceAlertSetting[]): Record<string, boolean> {
  return Object.fromEntries(settings.map((s) => [s.source, s.alert_enabled]));
}

// ─── MachinesPanel ────────────────────────────────────────

export function MachinesPanel({
  currentDeviceID,
  currentMachineId = '',
  onShowToast,
  onDeviceChange,
}: MachinesPanelProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [alertSettings, setAlertSettings] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingNickname, setSavingNickname] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(
    null,
  );
  const [cleanupHostname, setCleanupHostname] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [showSshDialog, setShowSshDialog] = useState(false);
  const nicknameErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Poll lifecycle ──────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [devs, srcs, alerts] = await Promise.allSettled([
        unwrap(commands.listDevices()),
        unwrap(commands.getSources()),
        unwrap(commands.getAllSourceAlertSettings()),
      ]);
      if (devs.status === 'fulfilled') setDevices(devs.value);
      if (srcs.status === 'fulfilled') setSources(srcs.value);
      if (alerts.status === 'fulfilled') {
        setAlertSettings(settingsToAlertMap(alerts.value));
      }
    } catch (e) {
      console.error('fetchAll failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Merge devices + sources ─────────────────────────────
  // Produce a combined list: paired devices first, then source-only
  // machines (sources without a matching device), then local.
  const merged: MergedEntry[] = (() => {
    const deviceSourceKeys = new Set(devices.map((d) => d.source_key));
    const currentDeviceIsPaired = devices.some(
      (d) =>
        d.id === currentDeviceID ||
        (currentMachineId !== '' && d.machine_id === currentMachineId),
    );
    const entries: MergedEntry[] = devices.map((d) => ({
      kind: 'device',
      device: d,
    }));

    for (const s of sources) {
      if (s.source === 'local') {
        // The "local" source represents clips made on this machine. When the
        // current machine is already in the paired-devices list, that row
        // already represents this machine — adding a synthetic "This machine"
        // row would duplicate it. Only add the synthetic entry if the current
        // device isn't paired (e.g., transient relay/auth lag), and at most
        // once.
        if (
          !currentDeviceIsPaired &&
          !entries.some((e) => e.kind === 'local')
        ) {
          entries.push({ kind: 'local' });
        }
      } else if (!deviceSourceKeys.has(s.source)) {
        entries.push({ kind: 'source_only', source: s });
      }
    }

    return entries;
  })();

  // ── Nickname save ───────────────────────────────────────

  const saveNickname = useCallback(
    async (deviceId: string, nickname: string) => {
      setSavingNickname(true);
      try {
        await unwrap(commands.setDeviceNickname(deviceId, nickname));
        await fetchAll();
        onDeviceChange?.();
      } catch (_e) {
        setNicknameError('Save failed — try again');
        if (nicknameErrorTimer.current)
          clearTimeout(nicknameErrorTimer.current);
        nicknameErrorTimer.current = setTimeout(
          () => setNicknameError(null),
          3000,
        );
      } finally {
        setSavingNickname(false);
        setEditingDeviceId(null);
      }
    },
    [fetchAll, onDeviceChange],
  );

  // ── Revoke ──────────────────────────────────────────────

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      const hostname =
        devices.find((d) => d.id === deviceId)?.hostname || deviceId;
      try {
        await unwrap(commands.revokeDevice(deviceId));
        onShowToast('Device revoked');
        setCleanupHostname(hostname);
        await fetchAll();
        onDeviceChange?.();
      } catch (_e) {
        onShowToast('Failed to revoke device — try again');
      }
      setConfirmingRevokeId(null);
    },
    [devices, fetchAll, onDeviceChange, onShowToast],
  );

  const isAlertEnabled = useCallback(
    (source: string) => alertSettings[source] ?? true,
    [alertSettings],
  );

  const toggleAlert = useCallback(
    async (source: string, name: string) => {
      const next = !isAlertEnabled(source);
      setAlertSettings((prev) => ({ ...prev, [source]: next }));
      try {
        await unwrap(commands.setSourceAlertEnabled(source, next));
        onShowToast(next ? `Desktop alerts on for ${name}` : `Desktop alerts off for ${name}`);
      } catch (_e) {
        setAlertSettings((prev) => ({ ...prev, [source]: !next }));
        onShowToast('Failed to save alert setting');
      }
    },
    [isAlertEnabled, onShowToast],
  );

  // ── Nickname edit interaction ───────────────────────────

  const startEdit = useCallback((device: Device) => {
    setEditingDeviceId(device.id ?? null);
    setEditValue(device.nickname || '');
    setNicknameError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingDeviceId(null);
    setEditValue('');
    setNicknameError(null);
  }, []);

  const commitEdit = useCallback(
    (deviceId: string) => {
      const trimmed = editValue.trim();
      if (trimmed) {
        saveNickname(deviceId, trimmed);
      } else {
        cancelEdit();
      }
    },
    [editValue, saveNickname, cancelEdit],
  );

  // Focus input when editing starts
  useEffect(() => {
    if (editingDeviceId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingDeviceId]);

  // Esc/Enter on revoke confirm dialog (keyboard accessibility)
  useEffect(() => {
    if (!confirmingRevokeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmingRevokeId(null);
      if (e.key === 'Enter') revokeDevice(confirmingRevokeId);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmingRevokeId, revokeDevice]);

  const lastSeen = (device: Device): string => {
    return device.last_push_at
      ? formatTime(Math.floor(new Date(device.last_push_at).getTime() / 1000))
      : 'never';
  };

  // ── Loading state ───────────────────────────────────────

  if (loading) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>MACHINES</span>
        </div>
        <div role="list" aria-label="Machines loading">
          {[0, 1, 2].map((i) => (
            <div key={i} role="listitem" style={S.skeletonRow}>
              <div
                style={{
                  ...S.skeletonBlock,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                }}
              />
              <div
                style={{
                  ...S.skeletonBlock,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                }}
              />
              <div
                style={{
                  ...S.skeletonBlock,
                  flex: 1,
                  height: 14,
                  borderRadius: 4,
                }}
              />
              <div
                style={{
                  ...S.skeletonBlock,
                  width: 32,
                  height: 14,
                  borderRadius: 4,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Empty state ─────────────────────────────────────────

  if (merged.length === 0) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>MACHINES</span>
          <span style={S.headerCount}>0 machines</span>
        </div>
        <div style={S.emptyState}>
          <div style={S.emptyHeading}>No machines yet</div>
          <div style={S.emptyBody}>
            Pair a device to route clips between machines.
          </div>
          <code style={S.emptyCode}>cinch auth pair</code>
        </div>
      </div>
    );
  }

  const pairedCount = devices.length;
  const totalCount = merged.length;

  // The device being confirmed for revoke (needed for ConfirmDialog label)
  const confirmingDevice = confirmingRevokeId
    ? devices.find((d) => d.id === confirmingRevokeId)
    : undefined;
  const confirmingDisplayName = confirmingDevice
    ? confirmingDevice.nickname ||
      confirmingDevice.hostname ||
      confirmingRevokeId
    : confirmingRevokeId;

  // ── Machine grid ─────────────────────────────────────────

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.headerTitle}>MACHINES</span>
        <span style={S.headerCount}>
          {pairedCount} paired · {totalCount} total
        </span>
      </div>

      <div role="list" aria-label="Machines" style={S.grid}>
        {merged.map((entry) => {
          if (entry.kind === 'local') {
            return (
              <div key="local" role="listitem" style={S.card}>
                <div style={S.cardHeader}>
                  <span
                    style={{
                      ...S.statusPill,
                      background: 'var(--surface-2)',
                      color: 'var(--text-primary)',
                    }}
                    aria-label="Online"
                  >
                    online
                  </span>
                  <span style={S.thisDeviceBadge}>This device</span>
                </div>
                <div style={S.cardName}>This machine</div>
                <div style={S.cardMeta}>local clips</div>
              </div>
            );
          }

          if (entry.kind === 'source_only') {
            const s = entry.source;
            const name = s.source.replace(/^remote:/, '');
            const pillVars = sourcePillVars(s.source);
            return (
              <div key={s.source} role="listitem" style={S.card}>
                <div style={S.cardHeader}>
                  <span
                    style={{
                      ...S.statusPill,
                      background: 'var(--surface-2)',
                      color: C.t3,
                    }}
                    aria-label="Unknown status"
                  >
                    offline
                  </span>
                  <span
                    style={{
                      ...S.sourcePill,
                      background: pillVars.bg,
                      color: pillVars.fg,
                    }}
                  >
                    {name}
                  </span>
                </div>
                <div style={S.cardName}>{name}</div>
                <div style={S.cardMeta}>
                  {s.clip_count} clips · {formatTime(s.last_seen)}
                </div>
                <div style={S.cardFooter}>
                  <AlertToggle
                    enabled={isAlertEnabled(s.source)}
                    name={name}
                    onClick={() => toggleAlert(s.source, name)}
                  />
                  <span style={{ ...S.thisDeviceBadge, color: C.t4 }}>
                    Not paired
                  </span>
                </div>
              </div>
            );
          }

          // entry.kind === "device"
          const device = entry.device;
          const isCurrentDevice =
            device.id === currentDeviceID ||
            (currentMachineId !== '' && device.machine_id === currentMachineId);
          const isEditing = editingDeviceId === device.id;
          const displayName = device.nickname || device.hostname || '';
          const pillVars = sourcePillVars(device.source_key ?? device.id ?? '');
          const alertSource = device.source_key;
          const alertName = device.hostname || displayName || 'machine';

          return (
            <div key={device.id} role="listitem" style={S.card}>
              <div style={S.cardHeader}>
                <span
                  style={{
                    ...S.statusPill,
                    background: 'var(--surface-2)',
                    color: device.online ? 'var(--text-primary)' : C.t3,
                  }}
                  aria-label={device.online ? 'Online' : 'Offline'}
                >
                  {device.online ? 'online' : 'offline'}
                </span>
                <span
                  style={{
                    ...S.sourcePill,
                    background: pillVars.bg,
                    color: pillVars.fg,
                  }}
                >
                  {device.hostname ?? 'unknown'}
                </span>
                {isCurrentDevice && (
                  <span style={S.thisDeviceBadge}>This device</span>
                )}
              </div>

              <div style={S.nameRow}>
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    style={{
                      ...S.nicknameInput,
                      opacity: savingNickname ? 0.5 : 1,
                      pointerEvents: savingNickname ? 'none' : 'auto',
                    }}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitEdit(device.id!)}
                    onKeyDown={(e) => {
                      // device.id is non-null here: input only renders when editingDeviceId === device.id,
                      // and startEdit gates on device.id being truthy before setting editingDeviceId.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitEdit(device.id!);
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    maxLength={32}
                    spellCheck={false}
                    aria-label="Edit device nickname"
                  />
                ) : (
                  <span
                    style={S.cardName}
                    onClick={() => startEdit(device)}
                    title="Click to edit nickname"
                  >
                    {displayName}
                  </span>
                )}
                {nicknameError && editingDeviceId === device.id && (
                  <span style={S.nicknameErrorText}>{nicknameError}</span>
                )}
              </div>

              <div style={S.cardMeta}>
                {device.clip_count ?? 0} clips · {lastSeen(device)}
              </div>

              <div style={S.cardFooter}>
                {alertSource && (
                  <AlertToggle
                    enabled={isAlertEnabled(alertSource)}
                    name={alertName}
                    onClick={() => toggleAlert(alertSource, alertName)}
                  />
                )}
                <button
                  style={S.revokeBtn}
                  onClick={() => setConfirmingRevokeId(device.id ?? null)}
                >
                  Revoke
                </button>
              </div>
            </div>
          );
        })}

        {/* Pair card — opens SSH pairing wizard */}
        <button
          style={S.pairCard}
          role="listitem"
          onClick={() => setShowSshDialog(true)}
          aria-label="Add machine via SSH"
        >
          <div style={S.pairCardInner}>
            <div style={S.pairHeading}>Add via SSH</div>
            <div style={S.pairBody}>Pair a remote machine over SSH</div>
          </div>
        </button>
      </div>

      {showSshDialog && (
        <AddSshMachineDialog
          onClose={() => {
            setShowSshDialog(false);
            fetchAll();
          }}
          onShowToast={onShowToast}
        />
      )}

      {/* Revoke confirm dialog */}
      <ConfirmDialog
        open={confirmingRevokeId !== null}
        title="Revoke device?"
        body={
          <>
            Remove <strong>{confirmingDisplayName}</strong> from your account.
            It will no longer sync clips.
          </>
        }
        primaryLabel={`Revoke "${confirmingDisplayName}"`}
        secondaryLabel="Keep"
        tone="destructive"
        onConfirm={() => {
          if (confirmingRevokeId) revokeDevice(confirmingRevokeId);
        }}
        onCancel={() => setConfirmingRevokeId(null)}
      />

      {/* Post-revoke cleanup guide */}
      <CleanupDialog
        open={cleanupHostname !== null}
        hostname={cleanupHostname ?? ''}
        onClose={() => setCleanupHostname(null)}
      />
    </div>
  );
}

function AlertToggle({
  enabled,
  name,
  onClick,
}: {
  enabled: boolean;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      style={{ ...S.alertBtn, ...(enabled ? S.alertBtnOn : S.alertBtnOff) }}
      onClick={onClick}
      aria-label={`${enabled ? 'Turn desktop alerts off' : 'Turn desktop alerts on'} for ${name}`}
    >
      {enabled ? 'Alerts on' : 'Alerts off'}
    </button>
  );
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    background: C.bg,
  },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: C.t2,
    fontFamily: 'var(--font-body)',
  },
  headerCount: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
  },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 12,
    padding: 16,
    overflowY: 'auto',
    flex: 1,
    alignContent: 'start',
  },

  card: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },

  statusPill: {
    padding: '1px 8px',
    borderRadius: 9999,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    flexShrink: 0,
    lineHeight: 1.6,
  },

  sourcePill: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    fontFamily: 'var(--font-body)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 120,
  },

  thisDeviceBadge: {
    background: C.card2,
    fontSize: 11,
    fontWeight: 600,
    color: C.t3,
    padding: '2px 6px',
    borderRadius: 4,
    fontFamily: 'var(--font-body)',
    whiteSpace: 'nowrap',
  },

  nameRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },

  cardName: {
    fontSize: 15,
    fontWeight: 600,
    color: C.t1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    letterSpacing: '-0.012em',
    lineHeight: 1.4,
  },

  nicknameInput: {
    fontSize: 15,
    fontWeight: 600,
    color: C.t1,
    letterSpacing: '-0.012em',
    background: 'transparent',
    border: `1px solid ${C.accent}`,
    borderRadius: 4,
    padding: '2px 8px',
    outline: 'none',
    boxShadow: `0 0 0 3px rgba(79,179,169,0.18)`,
    lineHeight: 1.4,
    width: '100%',
    boxSizing: 'border-box',
  },

  nicknameErrorText: {
    fontSize: 12,
    color: C.error,
    fontFamily: 'var(--font-body)',
  },

  cardMeta: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },

  revokeBtn: {
    background: 'transparent',
    color: C.error,
    border: '1px solid rgba(255,99,99,0.25)',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'var(--font-body)',
    whiteSpace: 'nowrap',
  },
  alertBtn: {
    background: 'transparent',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'var(--font-body)',
    whiteSpace: 'nowrap',
  },
  alertBtnOn: {
    color: C.t2,
    border: `1px solid ${C.border}`,
  },
  alertBtnOff: {
    color: C.t4,
    border: `1px solid ${C.border}`,
  },

  pairCard: {
    background: 'transparent',
    border: `1px dashed ${C.border}`,
    borderRadius: 10,
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    width: '100%',
    boxSizing: 'border-box',
  },

  pairCardInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    textAlign: 'center',
  },

  pairHeading: {
    fontSize: 12,
    fontWeight: 600,
    color: C.accent,
    fontFamily: 'var(--font-body)',
  },

  pairBody: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    fontFamily: 'var(--font-body)',
  },

  emptyState: {
    padding: '40px 20px',
    textAlign: 'center',
  },
  emptyHeading: {
    fontSize: 13,
    fontWeight: 500,
    color: C.t2,
    marginBottom: 6,
    fontFamily: 'var(--font-body)',
  },
  emptyBody: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    marginBottom: 12,
    fontFamily: 'var(--font-body)',
    lineHeight: 1.5,
  },
  emptyCode: {
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    color: C.t3,
  },

  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    minHeight: 44,
    borderBottom: `1px solid ${C.border}`,
  },
  skeletonBlock: {
    background: C.card2,
    opacity: 0.5,
  },
};
