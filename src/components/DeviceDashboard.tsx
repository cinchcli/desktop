import { useState, useEffect, useCallback, useRef } from "react";
import { commands } from "../bindings";
import { unwrap } from "../lib/tauri";
import { C, formatTime } from "../design";
import type { DeviceInfo } from "../bindings";

// ─── Props ────────────────────────────────────────────────

interface DeviceDashboardProps {
  currentDeviceID: string;
  onShowToast: (message: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────

/** Deterministic hue from device ID for the identity dot (per D-16). */
function deviceHue(deviceID: string): string {
  let hash = 0;
  for (let i = 0; i < deviceID.length; i++) {
    hash = (hash * 31 + deviceID.charCodeAt(i)) & 0xffff;
  }
  return `hsl(${hash % 360}, 55%, 58%)`;
}

// ─── DeviceDashboard ──────────────────────────────────────

export function DeviceDashboard({ currentDeviceID, onShowToast }: DeviceDashboardProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingNickname, setSavingNickname] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const nicknameErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Poll lifecycle (D-01, D-02, D-03) ──────────────────

  const fetchDevices = useCallback(async () => {
    try {
      const devs = await unwrap(commands.listDevices());
      setDevices(devs);
    } catch (e) {
      console.error("list_devices failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices(); // immediate first fetch
    const id = setInterval(fetchDevices, 5000); // 5s poll
    return () => clearInterval(id); // cleanup stops poll on unmount
  }, [fetchDevices]);

  // ── Nickname save (D-05) ────────────────────────────────

  const saveNickname = async (deviceId: string, nickname: string) => {
    setSavingNickname(true);
    try {
      await unwrap(commands.setDeviceNickname(deviceId, nickname));
      await fetchDevices();
    } catch (_e) {
      // Show inline error, auto-dismiss 3s
      setNicknameError("Save failed \u2014 try again");
      if (nicknameErrorTimer.current) clearTimeout(nicknameErrorTimer.current);
      nicknameErrorTimer.current = setTimeout(() => setNicknameError(null), 3000);
    } finally {
      setSavingNickname(false);
      setEditingDeviceId(null);
    }
  };

  // ── Revoke (D-13 — POST /auth/device/revoke) ───────────

  const revokeDevice = async (deviceId: string) => {
    try {
      await unwrap(commands.revokeDevice(deviceId));
      onShowToast("Device revoked");
      await fetchDevices();
    } catch (_e) {
      onShowToast("Failed to revoke device \u2014 try again");
    }
    setConfirmingRevokeId(null);
  };

  // ── Nickname edit interaction ───────────────────────────

  const startEdit = (device: DeviceInfo) => {
    setEditingDeviceId(device.id);
    setEditValue(device.nickname || "");
    setNicknameError(null);
  };

  const cancelEdit = () => {
    setEditingDeviceId(null);
    setEditValue("");
    setNicknameError(null);
  };

  const commitEdit = (deviceId: string) => {
    const trimmed = editValue.trim();
    if (trimmed) {
      saveNickname(deviceId, trimmed);
    } else {
      cancelEdit();
    }
  };

  // Auto-focus + select all when entering edit mode
  useEffect(() => {
    if (editingDeviceId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingDeviceId]);

  // Global Escape/Enter for revoke confirmation
  useEffect(() => {
    if (!confirmingRevokeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingRevokeId(null);
      if (e.key === "Enter") revokeDevice(confirmingRevokeId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmingRevokeId]);

  // ── Last-seen parse (Pitfall 10 — formatTime expects unix) ──

  const lastSeen = (device: DeviceInfo): string => {
    return device.last_push_at
      ? formatTime(Math.floor(new Date(device.last_push_at).getTime() / 1000))
      : "never";
  };

  // ── Loading state ───────────────────────────────────────

  if (loading) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>DEVICES</span>
        </div>
        <div role="list" aria-label="Devices loading">
          {[0, 1, 2].map((i) => (
            <div key={i} role="listitem" style={S.skeletonRow}>
              <div style={{ ...S.skeletonBlock, width: 8, height: 8, borderRadius: "50%" }} />
              <div style={{ ...S.skeletonBlock, width: 8, height: 8, borderRadius: "50%" }} />
              <div style={{ ...S.skeletonBlock, flex: 1, height: 14, borderRadius: 4 }} />
              <div style={{ ...S.skeletonBlock, width: 32, height: 14, borderRadius: 4 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Empty state ─────────────────────────────────────────

  if (devices.length === 0) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>DEVICES</span>
          <span style={S.headerCount}>0 paired</span>
        </div>
        <div style={S.emptyState}>
          <div style={S.emptyHeading}>No paired devices</div>
          <div style={S.emptyBody}>Pair a device to route clips between machines.</div>
          <code style={S.emptyCode}>cinch auth pair</code>
        </div>
      </div>
    );
  }

  // ── Device list ─────────────────────────────────────────

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.headerTitle}>DEVICES</span>
        <span style={S.headerCount}>{devices.length} paired</span>
      </div>

      <div role="list" aria-label="Paired devices" style={S.listContainer}>
        {devices.map((device) => {
          const isCurrentDevice = device.id === currentDeviceID;
          const isEditing = editingDeviceId === device.id;
          const isConfirmingRevoke = confirmingRevokeId === device.id;
          const displayName = device.nickname || device.hostname;

          return (
            <div
              key={device.id}
              role="listitem"
              style={S.deviceRow}
            >
              {/* ID dot — deterministic color */}
              <span
                style={{
                  ...S.dot,
                  backgroundColor: deviceHue(device.id),
                }}
                aria-hidden="true"
              />

              {/* Online/offline dot */}
              <span
                style={{
                  ...S.dot,
                  backgroundColor: device.online ? C.success : C.t4,
                }}
                aria-label={device.online ? "Online" : "Offline"}
              />

              {/* Name + hostname sub-label */}
              <div style={S.nameCol}>
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    style={{
                      ...S.nicknameInput,
                      opacity: savingNickname ? 0.5 : 1,
                      pointerEvents: savingNickname ? "none" : "auto",
                    }}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitEdit(device.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit(device.id);
                      }
                      if (e.key === "Escape") {
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
                    style={S.nickname}
                    onClick={() => startEdit(device)}
                    title="Click to edit nickname"
                  >
                    {displayName}
                  </span>
                )}
                {nicknameError && editingDeviceId === device.id && (
                  <span style={S.nicknameErrorText}>{nicknameError}</span>
                )}
                <span style={S.hostname}>@{device.hostname}</span>
              </div>

              {/* Last seen */}
              <span style={S.lastSeen}>
                {lastSeen(device)}
              </span>

              {/* Right: This device badge OR Revoke button */}
              <div style={S.actionCol}>
                {isCurrentDevice ? (
                  <span style={S.thisDeviceBadge}>This device</span>
                ) : isConfirmingRevoke ? (
                  <div style={S.revokeConfirm}>
                    <button
                      style={S.keepBtn}
                      onClick={() => setConfirmingRevokeId(null)}
                    >
                      Keep Device
                    </button>
                    <button
                      style={S.revokeConfirmBtn}
                      onClick={() => revokeDevice(device.id)}
                    >
                      Revoke &ldquo;{displayName}&rdquo;
                    </button>
                  </div>
                ) : (
                  <button
                    style={S.revokeBtn}
                    onClick={() => setConfirmingRevokeId(device.id)}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    background: C.bg,
  },

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: C.t2,
    fontFamily: "Inter, system-ui, sans-serif",
  },
  headerCount: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontVariantNumeric: "tabular-nums",
  },

  listContainer: {
    overflowY: "auto",
    flex: 1,
  },

  deviceRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    minHeight: 44,
    borderBottom: `1px solid ${C.border}`,
  },

  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },

  nameCol: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },

  nickname: {
    fontSize: 13,
    fontWeight: 500,
    color: C.t1,
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: "Inter, system-ui, sans-serif",
    lineHeight: 1.4,
  },

  nicknameInput: {
    fontSize: 13,
    fontWeight: 500,
    color: C.t1,
    fontFamily: "Inter, system-ui, sans-serif",
    background: "transparent",
    border: `1px solid ${C.accent}`,
    borderRadius: 4,
    padding: "2px 8px",
    outline: "none",
    boxShadow: `0 0 0 3px rgba(79,179,169,0.18)`,
    lineHeight: 1.4,
    width: "100%",
    boxSizing: "border-box" as const,
  },

  nicknameErrorText: {
    fontSize: 12,
    color: C.error,
    fontFamily: "Inter, system-ui, sans-serif",
  },

  hostname: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: "Inter, system-ui, sans-serif",
    lineHeight: 1.33,
  },

  lastSeen: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t2,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },

  actionCol: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },

  thisDeviceBadge: {
    background: C.card2,
    fontSize: 12,
    fontWeight: 600,
    color: C.t3,
    padding: "2px 8px",
    borderRadius: 6,
    fontFamily: "Inter, system-ui, sans-serif",
    whiteSpace: "nowrap",
  },

  revokeBtn: {
    background: "transparent",
    color: C.error,
    border: "1px solid rgba(255,99,99,0.25)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "Inter, system-ui, sans-serif",
    whiteSpace: "nowrap",
  },

  revokeConfirm: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },

  keepBtn: {
    background: "transparent",
    color: C.t3,
    border: "none",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "Inter, system-ui, sans-serif",
    whiteSpace: "nowrap",
  },

  revokeConfirmBtn: {
    background: "transparent",
    color: C.error,
    border: "1px solid rgba(255,99,99,0.25)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "Inter, system-ui, sans-serif",
    whiteSpace: "nowrap",
  },

  // Empty state
  emptyState: {
    padding: "40px 20px",
    textAlign: "center",
  },
  emptyHeading: {
    fontSize: 13,
    fontWeight: 500,
    color: C.t2,
    marginBottom: 6,
    fontFamily: "Inter, system-ui, sans-serif",
  },
  emptyBody: {
    fontSize: 12,
    fontWeight: 500,
    color: C.t3,
    marginBottom: 12,
    fontFamily: "Inter, system-ui, sans-serif",
    lineHeight: 1.5,
  },
  emptyCode: {
    fontSize: 12,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    color: C.t3,
  },

  // Loading skeleton
  skeletonRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    minHeight: 44,
    borderBottom: `1px solid ${C.border}`,
  },
  skeletonBlock: {
    background: C.card2,
    opacity: 0.5,
  },
};
