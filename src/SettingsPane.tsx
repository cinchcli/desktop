// SettingsPane — plan 01-07 UI-SPEC §SettingsPane.
// Modal overlay with three sections (Local retention, Remote retention,
// Clear history) + excluded-apps disclosure + two ConfirmDialog surfaces.
//
// Verbatim copy is load-bearing: the UI-SPEC Copywriting Contract is what
// satisfies PRV-02 / PRV-03 messaging. Do NOT reword without UI-SPEC edit.

import { useEffect, useId, useState, type CSSProperties } from "react";
import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { commands } from "./bindings";
import type { RetentionConfig } from "./bindings";
import { unwrap } from "./lib/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { C } from "./design";
import { IconX } from "./icons";
import ConfirmDialog from "./ConfirmDialog";
import RetentionSlider from "./RetentionSlider";
import { AddRelayDialog } from "./components/AddRelayDialog";
import { MachinesPanel } from "./components/MachinesPanel";
import { useAuthState, signOut } from "./lib/state/auth";

const WINDOW_PRESETS = {
  compact:  { label: "Compact",  width: 760,  height: 480 },
  standard: { label: "Standard", width: 960,  height: 600 },
  spacious: { label: "Spacious", width: 1120, height: 720 },
} as const;
type WindowPreset = keyof typeof WINDOW_PRESETS;

function resolveWindowPreset(): WindowPreset {
  const saved = localStorage.getItem("cinch-window-size");
  return (saved && saved in WINDOW_PRESETS ? saved : "standard") as WindowPreset;
}

interface SettingsPaneProps {
  onClose: () => void;
  clipCount: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; config: RetentionConfig };

/** Format the internal shortcut string for display using macOS symbols. */
function formatShortcutDisplay(shortcut: string): string {
  return shortcut
    .replace(/CommandOrControl/g, "\u2318")
    .replace(/CmdOrCtrl/g, "\u2318")
    .replace(/Shift/g, "\u21E7")
    .replace(/Alt/g, "\u2325")
    .replace(/Control/g, "\u2303")
    .replace(/\+/g, "");
}

/** Register the global shortcut to show/focus the main window. */
async function registerWindowShortcut(shortcut: string): Promise<void> {
  await register(shortcut, (event) => {
    if (event.state === "Pressed") {
      const win = getCurrentWindow();
      win.show();
      win.setFocus();
    }
  });
}

export default function SettingsPane({ onClose, clipCount }: SettingsPaneProps) {
  const titleId = useId();
  const auth = useAuthState();
  const [activeTab, setActiveTab] = useState<"general" | "shortcuts" | "servers">("general");
  const [addRelayOpen, setAddRelayOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [clearOpen, setClearOpen] = useState(false);
  const [purgeDialog, setPurgeDialog] = useState<{
    nextDays: number;
    count: number;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [closeHovered, setCloseHovered] = useState(false);
  const [destructiveHovered, setDestructiveHovered] = useState(false);

  const [windowPreset, setWindowPreset] = useState<WindowPreset>(resolveWindowPreset);

  async function applyWindowPreset(preset: WindowPreset) {
    const { width, height } = WINDOW_PRESETS[preset];
    await getCurrentWindow().setSize(new LogicalSize(width, height));
    localStorage.setItem("cinch-window-size", preset);
    setWindowPreset(preset);
  }

  // Global shortcut state (D-08)
  const [currentShortcut, setCurrentShortcut] = useState<string>("CmdOrCtrl+Shift+W");
  const [shortcutInput, setShortcutInput] = useState<string>("\u2318\u21E7W");
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [shortcutSaving, setShortcutSaving] = useState(false);

  // Load persisted global shortcut on mount.
  useEffect(() => {
    unwrap(commands.getGlobalShortcut()).then((s) => {
      setCurrentShortcut(s);
      setShortcutInput(formatShortcutDisplay(s));
    }).catch(() => {/* use defaults */});
  }, []);

  // Load retention config on mount.
  useEffect(() => {
    unwrap(commands.getRetentionConfig())
      .then((config) => setState({ kind: "ready", config }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: String(e) })
      );
  }, []);

  // Esc closes the pane — but only when no ConfirmDialog is open.
  // ConfirmDialog has its own window-level Esc listener that fires first
  // (registration order) and cancels itself; this listener no-ops while
  // clearOpen or purgeDialog is truthy.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (clearOpen || purgeDialog) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [clearOpen, purgeDialog, onClose]);

  const currentConfig: RetentionConfig | null =
    state.kind === "ready" ? state.config : null;

  async function commitLocalRetention(next: number) {
    if (!currentConfig) return;
    const current = currentConfig.local_days;
    setSaveError(null);

    // If lowering retention, check how many clips would be purged.
    if (next < current) {
      try {
        const count = await unwrap(commands.previewRetentionChange(next));
        if (count > 0) {
          // Wait for user to confirm via Dialog B before persisting.
          setPurgeDialog({ nextDays: next, count });
          return;
        }
      } catch {
        // Preview is advisory — fall through and persist conservatively.
      }
    }

    try {
      await unwrap(commands.setRetentionConfig(next, currentConfig.remote_days));
      setState({
        kind: "ready",
        config: { ...currentConfig, local_days: next },
      });
    } catch (e: unknown) {
      setSaveError(`Couldn't save retention. Try again.`);
      // Re-throw so the slider can observe the failure if it ever chooses to.
      void e;
    }
  }

  async function commitRemoteRetention(next: number) {
    if (!currentConfig) return;
    setSaveError(null);
    try {
      await unwrap(commands.setRetentionConfig(currentConfig.local_days, next));
      setState({
        kind: "ready",
        config: { ...currentConfig, remote_days: next },
      });
    } catch {
      setSaveError(`Couldn't save retention. Try again.`);
    }
  }

  async function confirmPurge() {
    if (!purgeDialog || !currentConfig) return;
    setSaveError(null);
    try {
      await unwrap(commands.setRetentionConfig(purgeDialog.nextDays, currentConfig.remote_days));
      setState({
        kind: "ready",
        config: { ...currentConfig, local_days: purgeDialog.nextDays },
      });
      setPurgeDialog(null);
    } catch {
      setSaveError(`Couldn't save retention. Try again.`);
    }
  }

  async function confirmClear() {
    try {
      await unwrap(commands.clearLocalHistory());
      setClearOpen(false);
      onClose();
    } catch {
      setSaveError(`Couldn't clear history. Try again.`);
    }
  }

  /** Capture modifier+key combination when the shortcut input is focused. */
  const handleShortcutKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const modifiers: string[] = [];
    if (e.metaKey || e.ctrlKey) modifiers.push("CmdOrCtrl");
    if (e.shiftKey) modifiers.push("Shift");
    if (e.altKey) modifiers.push("Alt");

    // Ignore modifier-only presses
    const ignoredKeys = ["Meta", "Control", "Shift", "Alt", "OS"];
    if (ignoredKeys.includes(e.key)) return;

    if (modifiers.length === 0) {
      setShortcutError("Shortcut must include a modifier key");
      return;
    }

    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const newShortcut = [...modifiers, key].join("+");

    setShortcutError(null);
    setShortcutSaving(true);

    try {
      // Persist to DB first via Rust command
      await unwrap(commands.setGlobalShortcut(newShortcut));

      // Unregister old, register new via JS plugin API
      if (await isRegistered(currentShortcut)) {
        await unregister(currentShortcut);
      }
      await registerWindowShortcut(newShortcut);

      setCurrentShortcut(newShortcut);
      setShortcutInput(formatShortcutDisplay(newShortcut));
    } catch {
      setShortcutError("Invalid shortcut");
      // Attempt to re-register the old shortcut on failure
      try {
        if (!(await isRegistered(currentShortcut))) {
          await registerWindowShortcut(currentShortcut);
        }
      } catch { /* old shortcut may also fail */ }
    } finally {
      setShortcutSaving(false);
    }
  };

  const styles: Record<string, CSSProperties> = {
    page: {
      background: C.bg,
      color: C.t1,
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      borderRadius: "var(--radius-xl)",
      border: `1px solid var(--border)`,
      overflow: "hidden",
    },
    header: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "12px 16px",
      borderBottom: `1px solid ${C.border}`,
      flexShrink: 0,
    },
    pane: {
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      padding: "28px 40px",
    },
    titleRow: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 16,
      marginBottom: 4,
    },
    title: {
      fontSize: 13,
      fontWeight: 600,
      letterSpacing: "0.1px",
      color: C.t1,
    },
    closeBtn: {
      width: 28,
      height: 28,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: closeHovered ? C.hover : "transparent",
      border: "none",
      borderRadius: 6,
      color: C.t2,
      cursor: "pointer",
    },
    section: {
      marginBottom: 28,
    },
    sectionDivider: {
      border: "none",
      borderTop: `1px solid var(--border)`,
      margin: "24px 0",
    },
    clearSectionHeader: {
      fontSize: 15,
      fontWeight: 600,
      letterSpacing: '-0.012em',
      color: C.t1,
      marginBottom: 12,
    },
    clearDescription: {
      fontSize: 14,
      fontWeight: 500,
      lineHeight: 1.55,
      letterSpacing: '-0.005em',
      color: C.t2,
      marginBottom: 16,
    },
    destructiveBtn: {
      background: "transparent",
      color: C.error,
      border: `1px solid rgba(255, 99, 99, 0.25)`,
      borderRadius: 6,
      padding: "8px 14px",
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: "0.3px",
      cursor: clipCount === 0 ? "not-allowed" : "pointer",
      opacity: clipCount === 0 ? 0.4 : 1,
      boxShadow:
        destructiveHovered && clipCount > 0
          ? "rgba(255,99,99,0.15) 0 0 20px 5px"
          : "none",
      transition: "box-shadow 150ms",
    },
    excludedDisclosure: {
      fontSize: 14,
      fontWeight: 500,
      lineHeight: 1.55,
      color: C.t3,
      marginTop: 16,
    },
    errorRegion: {
      fontSize: 14,
      fontWeight: 500,
      color: C.error,
      marginTop: 12,
    },
    loading: {
      fontSize: 14,
      fontWeight: 500,
      color: C.t2,
      padding: "12px 0",
    },
  };

  return (
    <div style={styles.page} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      {/* Header bar */}
      <div style={styles.header}>
        <button
          style={styles.closeBtn}
          onClick={onClose}
          onMouseEnter={() => setCloseHovered(true)}
          onMouseLeave={() => setCloseHovered(false)}
          aria-label="Back"
          type="button"
        >
          <IconX size={14} />
        </button>
        <h1 id={titleId} style={styles.title}>Settings</h1>
      </div>

      <div style={styles.pane}>
        {/* Tab bar */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
          {(["general", "shortcuts", "servers"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === tab ? `2px solid ${C.t1}` : "2px solid transparent",
                color: activeTab === tab ? C.t1 : C.t3,
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: "0.3px",
                padding: "6px 12px",
                cursor: "pointer",
                textTransform: "capitalize",
                transition: "color 120ms",
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Servers tab */}
        {activeTab === "servers" && (
          <>
            {/* Relay Server */}
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.012em', color: C.t1, marginBottom: 10 }}>
              Relay server
            </div>
            {auth.variant === "Authenticated" ? (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: C.t1, marginBottom: 2 }}>
                  {(() => { try { return new URL(auth.payload.relay_url).host; } catch { return auth.payload.relay_url; } })()}
                </div>
                <div style={{ fontSize: 11, color: C.t3, marginBottom: 12 }}>{auth.payload.user_id}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setAddRelayOpen(true)}
                    style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 5, color: C.t2, fontSize: 11, fontWeight: 500, padding: "4px 10px", cursor: "pointer" }}
                  >
                    Re-authenticate
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisconnectOpen(true)}
                    style={{ background: "none", border: `1px solid color-mix(in srgb, var(--error) 30%, transparent)`, borderRadius: 5, color: C.error, fontSize: 11, fontWeight: 500, padding: "4px 10px", cursor: "pointer" }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 24 }}>
                <div style={{ fontSize: 13, color: C.t3, marginBottom: 10 }}>No relay connected.</div>
                <button
                  type="button"
                  onClick={() => setAddRelayOpen(true)}
                  style={{ background: C.t1, color: C.bg, border: "none", borderRadius: 5, fontSize: 12, fontWeight: 600, padding: "6px 14px", cursor: "pointer" }}
                >
                  Connect to relay
                </button>
              </div>
            )}

            {/* Remote Machines */}
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.012em', color: C.t1, marginBottom: 10 }}>
              Remote machines
            </div>
            <MachinesPanel
              currentDeviceID={auth.variant === "Authenticated" ? auth.payload.device_id : ""}
              currentMachineId={auth.variant === "Authenticated" ? auth.payload.machine_id : ""}
              onShowToast={() => {}}
            />

            {addRelayOpen && <AddRelayDialog onClose={() => setAddRelayOpen(false)} />}
            <ConfirmDialog
              open={disconnectOpen}
              title="Disconnect from relay?"
              body="This will sign out and remove your credentials. Your local clip history is kept."
              primaryLabel="Disconnect"
              secondaryLabel="Cancel"
              tone="destructive"
              onConfirm={async () => { setDisconnectOpen(false); await signOut(); onClose(); }}
              onCancel={() => setDisconnectOpen(false)}
            />
          </>
        )}

        {/* Shortcuts tab */}
        {activeTab === "shortcuts" && (
          <>
            <div style={styles.section}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.012em', color: C.t1, marginBottom: 4 }}>
                Launch shortcut
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, color: C.t3, marginBottom: 12 }}>
                Press a new key combination to change the global show-window shortcut.
              </div>
              <input
                type="text"
                readOnly
                value={shortcutSaving ? "Saving…" : shortcutInput}
                onKeyDown={handleShortcutKeyDown}
                placeholder="Press a shortcut…"
                aria-label="Global launch shortcut"
                style={{
                  background: C.card,
                  border: `1px solid ${shortcutError ? C.error : C.border}`,
                  borderRadius: 6,
                  color: C.t1,
                  fontSize: 14,
                  fontWeight: 500,
                  padding: "7px 12px",
                  outline: "none",
                  cursor: "pointer",
                  letterSpacing: "0.5px",
                  minWidth: 140,
                }}
              />
              {shortcutError && (
                <div style={{ ...styles.errorRegion, marginTop: 6 }}>{shortcutError}</div>
              )}
            </div>

            <hr style={styles.sectionDivider} />

            <div style={styles.section}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.012em', color: C.t1, marginBottom: 12 }}>
                Built-in shortcuts
              </div>
              {([
                {
                  group: "Navigation",
                  rows: [
                    { keys: ["↑", "↓"], desc: "Move between clips" },
                    { keys: ["j", "k"], desc: "Move between clips (vim)" },
                    { keys: ["Tab"], desc: "Switch between All / Pinned" },
                  ],
                },
                {
                  group: "Actions",
                  rows: [
                    { keys: ["⌘C"], desc: "Copy selected clip" },
                    { keys: ["⌘P"], desc: "Pin / unpin selected clip" },
                    { keys: ["⌘⌫"], desc: "Delete selected clip" },
                  ],
                },
                {
                  group: "Search",
                  rows: [
                    { keys: ["⌘F", "/"], desc: "Focus search" },
                    { keys: ["Esc"], desc: "Clear search / deselect" },
                  ],
                },
                {
                  group: "General",
                  rows: [
                    { keys: ["⌘,"], desc: "Open settings" },
                    { keys: ["Esc"], desc: "Close settings" },
                  ],
                },
              ] as const).map(({ group, rows }) => (
                <div key={group} style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.6px", color: C.t3, textTransform: "uppercase", marginBottom: 6 }}>
                    {group}
                  </div>
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                    {rows.map((row, i) => (
                      <div
                        key={row.desc}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 14px",
                          borderTop: i > 0 ? `1px solid ${C.border}` : "none",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 500, color: C.t2 }}>{row.desc}</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          {row.keys.map((k) => (
                            <kbd
                              key={k}
                              style={{
                                background: C.bg,
                                border: `1px solid ${C.border}`,
                                borderRadius: 4,
                                color: C.t1,
                                fontFamily: "inherit",
                                fontSize: 12,
                                fontWeight: 600,
                                padding: "2px 7px",
                                letterSpacing: "0.2px",
                              }}
                            >
                              {k}
                            </kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* General tab */}
        {activeTab === "general" && state.kind === "loading" && (
          <div style={styles.loading}>Loading retention settings…</div>
        )}

        {activeTab === "general" && state.kind === "error" && (
          <div style={styles.errorRegion}>
            Couldn't load settings: {state.message}
          </div>
        )}

        {activeTab === "general" && state.kind === "ready" && (
          <>
            <div style={styles.section}>
              <RetentionSlider
                id="local-retention"
                label="Local retention"
                description="How long to keep clips copied on this Mac. Clips older than this are deleted automatically."
                value={state.config.local_days}
                onCommit={commitLocalRetention}
              />
            </div>

            <hr style={styles.sectionDivider} />

            <div style={styles.section}>
              <RetentionSlider
                id="remote-retention"
                label="Remote retention"
                description="How long to keep clips on the relay server. Phase 1 saves this locally; enforcement lands with the next release."
                value={state.config.remote_days}
                onCommit={commitRemoteRetention}
              />
            </div>

            <hr style={styles.sectionDivider} />

            <div style={styles.section}>
              <div style={styles.clearSectionHeader}>Clear history</div>
              <div style={styles.clearDescription}>
                Delete every clip stored on this Mac. Remote clips on the relay
                are not affected.
              </div>
              <button
                type="button"
                style={styles.destructiveBtn}
                disabled={clipCount === 0}
                onClick={() => setClearOpen(true)}
                onMouseEnter={() => setDestructiveHovered(true)}
                onMouseLeave={() => setDestructiveHovered(false)}
              >
                {clipCount > 0 ? `Clear ${clipCount} clips…` : "Clear local history"}
              </button>
              <div style={styles.excludedDisclosure}>
                Clips from password managers (1Password, Bitwarden, LastPass,
                Keychain Access) and concealed pasteboard types are never saved.
              </div>
            </div>

            <hr style={styles.sectionDivider} />

            <div style={styles.section}>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.012em', color: C.t1, marginBottom: 4 }}>
                Window size
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, color: C.t3, marginBottom: 12 }}>
                Choose a preset size
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {(Object.keys(WINDOW_PRESETS) as WindowPreset[]).map((key) => {
                  const active = windowPreset === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => void applyWindowPreset(key)}
                      style={{
                        background: active ? C.t1 : "transparent",
                        color: active ? C.bg : C.t2,
                        border: `1px solid ${active ? C.t1 : C.border}`,
                        borderRadius: 6,
                        padding: "6px 14px",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        letterSpacing: "0.2px",
                        transition: "background 120ms, color 120ms",
                      }}
                    >
                      {WINDOW_PRESETS[key].label}
                    </button>
                  );
                })}
              </div>
            </div>

            {saveError && <div style={styles.errorRegion}>{saveError}</div>}
          </>
        )}

        <ConfirmDialog
          open={clearOpen}
          title={`Delete all ${clipCount} clips?`}
          body={
            <>
              This removes every clip stored on this Mac. Remote clips on the relay
              are not affected. This cannot be undone.
            </>
          }
          primaryLabel="Delete clips"
          secondaryLabel="Cancel"
          tone="destructive"
          onConfirm={confirmClear}
          onCancel={() => setClearOpen(false)}
        />

        <ConfirmDialog
          open={!!purgeDialog}
          title={
            purgeDialog
              ? `Lower local retention to ${purgeDialog.nextDays} days?`
              : ""
          }
          body={
            purgeDialog ? (
              <>
                {purgeDialog.count} clips older than {purgeDialog.nextDays} days
                will be deleted from this Mac. Clips newer than{" "}
                {purgeDialog.nextDays} days are kept.
              </>
            ) : null
          }
          primaryLabel={
            purgeDialog ? `Lower and delete ${purgeDialog.count} clips` : ""
          }
          secondaryLabel="Cancel"
          tone="primary"
          onConfirm={confirmPurge}
          onCancel={() => setPurgeDialog(null)}
        />
      </div>
    </div>
  );
}
