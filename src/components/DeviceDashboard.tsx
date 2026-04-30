import { useState, useEffect, useCallback, useRef } from "react";
import { commands } from "../bindings";
import { unwrap } from "../lib/tauri";
import { C, formatTime } from "../design";
import type { Device, SourceInfo } from "../bindings";

// ─── Props ────────────────────────────────────────────────

interface DeviceDashboardProps {
  currentDeviceID: string;
  onShowToast: (message: string) => void;
  onDeviceChange?: () => void;
}

// ─── Types ────────────────────────────────────────────────

type MergedEntry =
  | { kind: "device"; device: Device }
  | { kind: "source_only"; source: SourceInfo }
  | { kind: "local" };

// ─── Helpers ──────────────────────────────────────────────

/** Deterministic hue from device ID for the identity dot (per D-16). */
function deviceHue(deviceID: string): string {
  let hash = 0;
  for (let i = 0; i < deviceID.length; i++) {
    hash = (hash * 31 + deviceID.charCodeAt(i)) & 0xffff;
  }
  return `hsl(${hash % 360}, 55%, 58%)`;
}

function sourceName(source: string): string {
  return source.replace(/^remote:/, "");
}

// ─── DeviceDashboard ──────────────────────────────────────

export function DeviceDashboard({ currentDeviceID, onShowToast, onDeviceChange }: DeviceDashboardProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingNickname, setSavingNickname] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const nicknameErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Poll lifecycle ──────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [devs, srcs] = await Promise.allSettled([
        unwrap(commands.listDevices()),
        unwrap(commands.getSources()),
      ]);
      if (devs.status === "fulfilled") setDevices(devs.value);
      if (srcs.status === "fulfilled") setSources(srcs.value);
    } catch (e) {
      console.error("fetchAll failed:", e);
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
    const deviceSourceKeys = new Set(devices.map(d => d.source_key));
    const entries: MergedEntry[] = devices.map(d => ({ kind: "device", device: d }));

    for (const s of sources) {
      if (s.source === "local") {
        // current machine — add as local entry only if not already represented
        if (!entries.some(e => e.kind === "local")) {
          entries.push({ kind: "local" });
        }
      } else if (!deviceSourceKeys.has(s.source)) {
        entries.push({ kind: "source_only", source: s });
      }
    }

    return entries;
  })();

  // ── Nickname save ───────────────────────────────────────

  const saveNickname = async (deviceId: string, nickname: string) => {
    setSavingNickname(true);
    try {
      await unwrap(commands.setDeviceNickname(deviceId, nickname));
      await fetchAll();
      onDeviceChange?.();
    } catch (_e) {
      setNicknameError("Save failed \u2014 try again");
      if (nicknameErrorTimer.current) clearTimeout(nicknameErrorTimer.current);
      nicknameErrorTimer.current = setTimeout(() => setNicknameError(null), 3000);
    } finally {
      setSavingNickname(false);
      setEditingDeviceId(null);
    }
  };

  // ── Revoke ──────────────────────────────────────────────

  const revokeDevice = async (deviceId: string) => {
    try {
      await unwrap(commands.revokeDevice(deviceId));
      onShowToast("Device revoked");
      await fetchAll();
      onDeviceChange?.();
    } catch (_e) {
      onShowToast("Failed to revoke device \u2014 try again");
    }
    setConfirmingRevokeId(null);
  };

  // ── Nickname edit interaction ───────────────────────────

  const startEdit = (device: Device) => {
    setEditingDeviceId(device.id ?? null);
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

  useEffect(() => {
    if (editingDeviceId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingDeviceId]);

  useEffect(() => {
    if (!confirmingRevokeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingRevokeId(null);
      if (e.key === "Enter") revokeDevice(confirmingRevokeId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmingRevokeId]);

  const lastSeen = (device: Device): string => {
    return device.last_push_at
      ? formatTime(Math.floor(new Date(device.last_push_at).getTime() / 1000))
      : "never";
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

  if (merged.length === 0) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>MACHINES</span>
          <span style={S.headerCount}>0 machines</span>
        </div>
        <div style={S.emptyState}>
          <div style={S.emptyHeading}>No machines yet</div>
          <div style={S.emptyBody}>Pair a device to route clips between machines.</div>
          <code style={S.emptyCode}>cinch auth pair</code>
        </div>
      </div>
    );
  }

  const pairedCount = devices.length;
  const totalCount = merged.length;

  // ── Machine list ─────────────────────────────────────────

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.headerTitle}>MACHINES</span>
        <span style={S.headerCount}>
          {pairedCount} paired · {totalCount} total
        </span>
      </div>

      <div role="list" aria-label="Machines" style={S.listContainer}>
        {merged.map((entry) => {
          if (entry.kind === "local") {
            return (
              <div key="local" role="listitem" style={S.deviceRow}>
                <span style={{ ...S.dot, backgroundColor: C.t4 }} aria-hidden="true" />
                <span style={{ ...S.dot, backgroundColor: C.success }} aria-label="Online" />
                <div style={S.nameCol}>
                  <span style={S.nickname}>This machine</span>
                  <span style={S.hostname}>local clips</span>
                </div>
                <span style={S.lastSeen} />
                <div style={S.actionCol}>
                  <span style={S.thisDeviceBadge}>This device</span>
                </div>
              </div>
            );
          }

          if (entry.kind === "source_only") {
            const s = entry.source;
            return (
              <div key={s.source} role="listitem" style={S.deviceRow}>
                <span style={{ ...S.dot, backgroundColor: C.t4 }} aria-hidden="true" />
                <span style={{ ...S.dot, backgroundColor: C.t4 }} aria-label="Unknown status" />
                <div style={S.nameCol}>
                  <span style={S.nickname}>{sourceName(s.source)}</span>
                  <span style={S.hostname}>{s.clip_count} clips</span>
                </div>
                <span style={S.lastSeen}>
                  {formatTime(s.last_seen)}
                </span>
                <div style={S.actionCol}>
                  <span style={{ ...S.thisDeviceBadge, color: C.t4 }}>Not paired</span>
                </div>
              </div>
            );
          }

          // entry.kind === "device"
          const device = entry.device;
          const isCurrentDevice = device.id === currentDeviceID;
          const isEditing = editingDeviceId === device.id;
          const isConfirmingRevoke = confirmingRevokeId === device.id;
          const displayName = device.nickname || device.hostname;

          return (
            <div key={device.id} role="listitem" style={S.deviceRow}>
              <span
                style={{ ...S.dot, backgroundColor: deviceHue(device.id ?? "") }}
                aria-hidden="true"
              />
              <span
                style={{ ...S.dot, backgroundColor: device.online ? C.success : C.t4 }}
                aria-label={device.online ? "Online" : "Offline"}
              />

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
                    onBlur={() => commitEdit(device.id ?? "")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitEdit(device.id ?? ""); }
                      if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
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

              <span style={S.lastSeen}>{lastSeen(device)}</span>

              <div style={S.actionCol}>
                {isConfirmingRevoke ? (
                  <div style={S.revokeConfirm}>
                    <button style={S.keepBtn} onClick={() => setConfirmingRevokeId(null)}>
                      Keep
                    </button>
                    <button style={S.revokeConfirmBtn} onClick={() => revokeDevice(device.id ?? "")}>
                      Revoke &ldquo;{displayName}&rdquo;
                    </button>
                  </div>
                ) : (
                  <>
                    {isCurrentDevice && (
                      <span style={S.thisDeviceBadge}>This device</span>
                    )}
                    <button style={S.revokeBtn} onClick={() => setConfirmingRevokeId(device.id ?? null)}>
                      Revoke
                    </button>
                  </>
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
