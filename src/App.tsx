import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, events } from "./bindings";
import type { LocalClip, SourceInfo, Device } from "./bindings";
import { unwrap } from "./lib/tauri";
import { C, formatTime, formatBytes } from "./design";
import { useAuthState, retryAuth, type AuthProgress, type AuthErrorReason } from "./state/auth";
import {
  IconSearch,
  IconX,
  IconCopy,
  IconTrash,
  IconImage,
  IconSun,
  IconMoon,
  IconGear,
  IconAutoCopy,
  IconPin,
  typeGlyph,
} from "./icons";
import SettingsPane from "./SettingsPane";
import { LocalOnlyView } from "./components/LocalOnlyView";
import { SourcePill } from "./components/SourcePill";
import { DeviceDashboard } from "./components/DeviceDashboard";
import { AdoptedAuthToast } from "./components/AdoptedAuthToast";
import { AddRelayDialog } from "./components/AddRelayDialog";
import "./App.css";

// ─── Theme ─────────────────────────────────────────────────

type Theme = "dark" | "light";

function systemPreference(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveTheme(): Theme {
  return (localStorage.getItem("cinch-theme") as Theme) ?? systemPreference();
}

function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  // Apply html class whenever theme changes
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  // Follow system preference changes — only when user hasn't explicitly chosen
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem("cinch-theme")) {
        setTheme(e.matches ? "light" : "dark");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggle = () =>
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("cinch-theme", next);
      return next;
    });

  return { theme, toggle };
}


function handleWindowDrag(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest("button, input, a, textarea")) {
    getCurrentWindow().startDragging();
  }
}

function App() {
  const { theme, toggle: toggleTheme } = useTheme();
  const auth = useAuthState();
  // CLI handoff (cinch://login from `cinch auth login`). Shown above all
  // auth-state branches so the dialog opens regardless of LocalOnly /
  // Authenticating / Authenticated.
  const [handoffRelay, setHandoffRelay] = useState<string | null>(null);
  useEffect(() => {
    const unsubP = events.cliHandoffRequested.listen((e) => {
      setHandoffRelay(e.payload.relay_url || "");
    });
    return () => { unsubP.then((f) => f()); };
  }, []);
  const [_status, setStatus] = useState("connecting");
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [selectedClip, setSelectedClip] = useState<LocalClip | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sourceSettings, setSourceSettings] = useState<Record<string, boolean>>({});
  const [devices, setDevices] = useState<Device[]>([]);
  const [newSourcePrompt, setNewSourcePrompt] = useState<string | null>(null);
  const [pinNoteDialog, setPinNoteDialog] = useState<{ clip: LocalClip } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [activePanel, setActivePanel] = useState<"clips" | "machines">("clips");
  const searchRef = useRef<HTMLInputElement>(null);
  const clipListRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<{ message: string; icon: "copy" | "trash" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, icon: "copy" | "trash") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, icon });
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const refreshClips = useCallback(async () => {
    try {
      if (selectedSource === "__pinned__") {
        const pinned = await unwrap(commands.listPinnedClips());
        const filtered = debouncedQuery.trim()
          ? pinned.filter(
              (c) =>
                c.content.toLowerCase().includes(debouncedQuery.toLowerCase()) ||
                c.pin_note?.toLowerCase().includes(debouncedQuery.toLowerCase()),
            )
          : pinned;
        setClips(filtered);
        return;
      }
      if (debouncedQuery.trim()) {
        const results = await unwrap(commands.searchClips(debouncedQuery, 100));
        const filtered = selectedSource
          ? results.filter((c) => c.source === selectedSource)
          : results;
        setClips(filtered);
      } else {
        const results = await unwrap(commands.listClips(selectedSource, null, 100));
        setClips(results);
      }
    } catch (e) {
      console.error("failed to load clips:", e);
    }
  }, [debouncedQuery, selectedSource]);

  const refreshSources = useCallback(async () => {
    try {
      setSources(await unwrap(commands.getSources()));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshSourceSettings = useCallback(async () => {
    try {
      const settings = await unwrap(commands.getAllSourceSettings());
      const map: Record<string, boolean> = {};
      for (const s of settings) map[s.source] = s.auto_copy;
      setSourceSettings(map);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await unwrap(commands.listDevices()));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const handleToggleAutoCopy = async (source: string) => {
    const current = sourceSettings[source] ?? false;
    await unwrap(commands.setSourceAutoCopy(source, !current));
    setSourceSettings((p) => ({ ...p, [source]: !current }));
  };

  const handleNewSourceResponse = async (source: string, enable: boolean) => {
    await unwrap(commands.setSourceAutoCopy(source, enable));
    setSourceSettings((p) => ({ ...p, [source]: enable }));
    setNewSourcePrompt(null);
  };

  useEffect(() => {
    if (auth.variant !== "Authenticated") return;
    const timer = setTimeout(() => {
      refreshClips();
      refreshSources();
      refreshSourceSettings();
      refreshDevices();
    }, 1000);
    return () => clearTimeout(timer);
  }, [auth.variant, refreshClips, refreshSources, refreshSourceSettings, refreshDevices]);

  useEffect(() => { refreshClips(); }, [refreshClips]);

  // Scroll selected clip into view when navigating with keyboard
  useEffect(() => {
    if (!selectedClip || !clipListRef.current) return;
    const el = clipListRef.current.querySelector<HTMLElement>(`[data-id="${selectedClip.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedClip]);

  useEffect(() => {
    commands.getWsStatus().then(setStatus).catch(() => {});
    const unsubs = [
      events.wsStatus.listen((e) => setStatus(e.payload)),
      events.clipReceived.listen(() => { refreshClips(); refreshSources(); }),
      events.clipDeleted.listen(() => { refreshClips(); refreshSources(); }),
      events.newSourceDetected.listen((e) => {
        setNewSourcePrompt(e.payload);
        refreshSourceSettings();
      }),
    ];
    return () => { unsubs.forEach((p) => p.then((f) => f())); };
  }, [refreshClips, refreshSources, refreshSourceSettings]);

  const copyClip = useCallback((clip: LocalClip) => {
    if (clip.content_type === "image" && clip.media_path) {
      unwrap(commands.copyImageToClipboard(clip.media_path));
      showToast("Copied image to clipboard", "copy");
    } else {
      unwrap(commands.copyClipToClipboard(clip.content));
      showToast("Copied to clipboard", "copy");
    }
  }, [showToast]);

  const handleDelete = async (id: string) => {
    await unwrap(commands.deleteClip(id));
    if (selectedClip?.id === id) setSelectedClip(null);
    refreshClips();
    refreshSources();
    showToast("Deleted", "trash");
  };

  const handlePin = async (clip: LocalClip, note: string | null) => {
    await unwrap(commands.pinClip(clip.id, note));
    setPinNoteDialog(null);
    refreshClips();
    showToast("Pinned", "copy");
  };

  const handleUnpin = async (clip: LocalClip) => {
    await unwrap(commands.unpinClip(clip.id));
    refreshClips();
    showToast("Unpinned", "trash");
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === "Escape") {
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
        } else if (searchQuery) {
          setSearchQuery("");
        } else if (selectedClip) {
          setSelectedClip(null);
        }
      }
      if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setShowShortcuts(v => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings(v => !v);
        return;
      }
      if (selectedClip) {
        if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          copyClip(selectedClip);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
          e.preventDefault();
          handleDelete(selectedClip.id);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "c") {
          if (!window.getSelection()?.toString()) copyClip(selectedClip);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "p" && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          if (selectedClip.is_pinned) {
            handleUnpin(selectedClip);
          } else {
            setPinNoteDialog({ clip: selectedClip });
          }
        }
      }
      // Ctrl+H / Ctrl+L — cycle sources (only when not typing in search)
      if (e.ctrlKey && (e.key === "h" || e.key === "l") && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        const all = [null, ...sources.map((s) => s.source)];
        const idx = all.indexOf(selectedSource);
        const next = e.key === "l"
          ? (idx + 1) % all.length
          : (idx - 1 + all.length) % all.length;
        setSelectedSource(all[next]);
        setSelectedClip(null);
      }
      const isDown = e.key === "ArrowDown" || (e.ctrlKey && e.key === "j");
      const isUp = e.key === "ArrowUp" || (e.ctrlKey && e.key === "k");
      if (isDown || isUp) {
        if (clips.length === 0) return;
        e.preventDefault();
        const idx = selectedClip ? clips.findIndex((c) => c.id === selectedClip.id) : -1;
        const next = isDown
          ? Math.min(idx + 1, clips.length - 1)
          : Math.max(idx - 1, 0);
        setSelectedClip(clips[next]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchQuery, selectedClip, clips, sources, selectedSource, copyClip, showShortcuts]);

  const totalClips = sources.reduce((sum, s) => sum + s.clip_count, 0);

  // from: token parsing for device-scoped clip filtering (T3-04)
  const fromMatch = searchQuery.match(/from:(\S+)/i);
  const sourceFilterToken = fromMatch ? fromMatch[1] : null;
  const sourceFilterNoMatch = useMemo(() => {
    if (!sourceFilterToken) return false;
    const nick = sourceFilterToken.toLowerCase();
    return !devices.some(
      d => (d.nickname?.toLowerCase() === nick) || (d.hostname?.toLowerCase() === nick)
    );
  }, [sourceFilterToken, devices]);

  const sourceFilter = useMemo(() => {
    if (!sourceFilterToken) return null;
    const nick = sourceFilterToken.toLowerCase();
    const matched = devices.find(
      d => (d.nickname?.toLowerCase() === nick) || (d.hostname?.toLowerCase() === nick)
    );
    return matched ? matched.source_key : "__no_match__";
  }, [sourceFilterToken, devices]);

  // Apply from: filter to clip list
  const filteredClips = useMemo(() => {
    if (!sourceFilter) return clips;
    if (sourceFilter === "__no_match__") return [];
    return clips.filter(c => c.source === sourceFilter);
  }, [clips, sourceFilter]);

  const deviceBySource: Record<string, Device> = {};
  for (const d of devices) {
    if (d.source_key) deviceBySource[d.source_key] = d;
  }

  // Build source -> nickname map for SourcePill and from: filter
  const nicknameBySource = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of devices) {
      if (d.nickname && d.source_key) {
        map[d.source_key] = d.nickname;
      }
    }
    return map;
  }, [devices]);

  const currentDeviceID =
    auth.variant === "Authenticated" ? auth.payload.device_id : "";

  // Settings overlay — lifted above auth checks so it works in all auth states
  const settingsOverlay = showSettings ? (
    <SettingsPane onClose={() => { setShowSettings(false); if (auth.variant === "Authenticated") refreshDevices(); }} clipCount={totalClips} />
  ) : null;

  const handoffDialog = handoffRelay !== null ? (
    <AddRelayDialog
      onClose={() => setHandoffRelay(null)}
      initialRelayUrl={handoffRelay}
      fromCli
    />
  ) : null;

  if (auth.variant === "LocalOnly") {
    return (
      <>
        <LocalOnlyView
          theme={theme}
          toggleTheme={toggleTheme}
          onOpenSettings={() => setShowSettings(true)}
        />
        {settingsOverlay}
        {handoffDialog}
        <AdoptedAuthToast />
      </>
    );
  }
  if (auth.variant === "Authenticating") {
    return <AuthLoadingScreen progress={auth.payload.progress} />;
  }
  if (auth.variant === "ErrorRecoverable") {
    return (
      <AuthErrorScreen
        reason={auth.payload.reason}
        retryAfterMs={auth.payload.retry_after_ms}
      />
    );
  }
  // auth.variant === "Authenticated" — render existing dashboard.

  return (
    <main data-testid="dashboard-root" style={S.main}>
      {/* Top: search bar with logo mark ──────────────────── */}
      <div style={S.searchBar} onMouseDown={handleWindowDrag}>
        <span style={S.searchIcon}><IconSearch size={14} /></span>
        <input
          ref={searchRef}
          style={S.searchInput}
          placeholder="Search clips"
          aria-label="Search clips"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {searchQuery && (
          <button
            style={S.searchClear}
            onClick={() => setSearchQuery("")}
            aria-label="Clear search"
          >
            <IconX size={12} />
          </button>
        )}
        <button
          style={S.themeBtn}
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <IconSun size={13} /> : <IconMoon size={13} />}
        </button>
        <button
          style={S.themeBtn}
          onClick={() => setShowSettings(true)}
          aria-label="Open settings"
          title="Settings"
        >
          <IconGear size={13} />
        </button>
      </div>



      {/* Main content: rail · list · detail ───────────────── */}
      <div style={S.content}>
        <nav style={S.rail} aria-label="Sources">
          <RailItem
            label="All clips"
            active={selectedSource === null && activePanel === "clips"}
            onClick={() => { setActivePanel("clips"); setSelectedSource(null); }}
          />
          <RailItem
            label="Pinned"
            active={selectedSource === "__pinned__" && activePanel === "clips"}
            pinned
            onClick={() => {
              setActivePanel("clips");
              setSelectedSource(selectedSource === "__pinned__" ? null : "__pinned__");
              setSelectedClip(null);
            }}
          />
          <div style={{ borderBottom: `1px solid ${C.border}`, margin: "4px 6px" }} />

          {/* Machines tab */}
          <div
            style={{
              ...S.railItem,
              ...(activePanel === "machines" ? S.railItemActive : {}),
              cursor: "pointer",
            }}
            onClick={() => setActivePanel(activePanel === "machines" ? "clips" : "machines")}
            aria-current={activePanel === "machines" ? "page" : undefined}
          >
            <span style={{ width: 6, height: 6 }} />
            <span style={S.railLabel}>Machines</span>
            {devices.length > 0 && (
              <span style={{ fontSize: 12, fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", color: C.t3 }}>
                {devices.filter(d => d.online).length}/{devices.length}
              </span>
            )}
          </div>
          <div style={{ borderBottom: `1px solid ${C.border}`, margin: "4px 6px" }} />

          {sources.map((s) => {
            const d = deviceBySource[s.source];
            const name = d?.nickname || s.source.replace("remote:", "");
            return (
              <RailItem
                key={s.source}
                label={name}
                online={d?.online}
                autoCopy={sourceSettings[s.source]}
                active={selectedSource === s.source && activePanel === "clips"}
                onToggleAutoCopy={(e) => {
                  e.stopPropagation();
                  handleToggleAutoCopy(s.source);
                }}
                onClick={() => {
                  setActivePanel("clips");
                  setSelectedSource(selectedSource === s.source ? null : s.source);
                }}
              />
            );
          })}
        </nav>

        {activePanel === "machines" ? (
          <DeviceDashboard
            currentDeviceID={currentDeviceID}
            onShowToast={(msg) => showToast(msg, "copy")}
            onDeviceChange={refreshDevices}
          />
        ) : (
          <>
            <div ref={clipListRef} style={S.listCol}>
              {filteredClips.length === 0 ? (
                <div style={S.empty}>
                  <div style={{ color: C.t2, fontSize: 13, marginBottom: 6 }}>
                    {sourceFilterToken && sourceFilterNoMatch
                      ? `No device matching 'from:${sourceFilterToken}'`
                      : debouncedQuery ? `No results for "${debouncedQuery}"` : "No clips"}
                  </div>
                  {!debouncedQuery && !sourceFilterToken && (
                    <code style={{ fontSize: 11, color: C.t3, fontFamily: "'JetBrains Mono', monospace" }}>
                      echo "hello" | cinch push
                    </code>
                  )}
                </div>
              ) : (
                filteredClips.map((clip) => (
                  <ClipRow
                    key={clip.id}
                    clip={clip}
                    selected={selectedClip?.id === clip.id}
                    onClick={() => setSelectedClip(clip)}
                    onDoubleClick={() => { setSelectedClip(clip); copyClip(clip); }}
                    nickname={nicknameBySource[clip.source]}
                    onPin={() => setPinNoteDialog({ clip })}
                    onUnpin={() => handleUnpin(clip)}
                  />
                ))
              )}
            </div>

            <div style={S.detailCol}>
              {selectedClip ? (
                <ClipDetail clip={selectedClip} />
              ) : (
                <div style={S.emptyDetail}>Select a clip</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Bottom status bar (Raycast-style) ────────────────── */}
      <footer style={S.statusBar} role="contentinfo" onMouseDown={handleWindowDrag}>
        <div style={S.statusLeft}>
          <span style={S.statusText}>
            {totalClips} {totalClips === 1 ? "clip" : "clips"}
          </span>
          {devices.length > 0 && (
            <>
              <span style={S.statusSep}>·</span>
              <span style={S.statusText}>
                {devices.filter((d) => d.online).length}/{devices.length} online
              </span>
            </>
          )}
        </div>
        <div style={S.statusRight}>
          {selectedClip ? (
            <>
              <Hint keys="↵" label="Copy" />
              <Hint keys="⌘⌫" label="Delete" />
              <Hint keys="^H/L" label="Source" />
            </>
          ) : (
            <>
              <Hint keys="⌘F" label="Search" />
              <Hint keys="↑↓" label="Navigate" />
              <Hint keys="^H/L" label="Source" />
            </>
          )}
          <Hint keys="?" label="Shortcuts" />
        </div>
      </footer>

      {/* Action overlay for selected clip (triggered via buttons in detail) */}
      {selectedClip && (
        <HiddenActions
          onCopy={() => copyClip(selectedClip)}
          onDelete={() => handleDelete(selectedClip.id)}
        />
      )}

      {/* Pin note dialog */}
      {pinNoteDialog && (
        <PinNoteDialog
          clip={pinNoteDialog.clip}
          onConfirm={(note) => handlePin(pinNoteDialog.clip, note || null)}
          onCancel={() => setPinNoteDialog(null)}
        />
      )}

      {/* New source prompt */}
      {newSourcePrompt && (
        <div style={S.overlay} onClick={() => setNewSourcePrompt(null)}>
          <div style={S.dialog} onClick={(e) => e.stopPropagation()}>
            <div style={S.dialogTitle}>New source detected</div>
            <div style={S.dialogBody}>
              <code style={{ color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>
                {newSourcePrompt.replace("remote:", "")}
              </code>{" "}
              is sending clips. Auto-copy is on by default.
            </div>
            <div style={S.dialogActions}>
              <button
                style={S.btnGhost}
                onClick={() => handleNewSourceResponse(newSourcePrompt, false)}
              >
                Disable auto-copy
              </button>
              <button style={S.btnPrimary} onClick={() => setNewSourcePrompt(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings pane (plan 01-07) */}
      {settingsOverlay}

      {/* Shortcut reference panel */}
      {showShortcuts && (
        <ShortcutPanel onClose={() => setShowShortcuts(false)} />
      )}

      {/* Toast notification */}
      {toast && <Toast message={toast.message} icon={toast.icon} />}

      {/* Cross-process adoption toast — fires once when CLI sign-in lands */}
      <AdoptedAuthToast />

      {/* CLI handoff dialog — opens when `cinch auth login` deep-links here */}
      {handoffDialog}
    </main>
  );
}

// ─── Auth transition screens (plumbing only per D-14 — no visual redesign) ────

function AuthLoadingScreen({ progress }: { progress: AuthProgress }) {
  const [timedOut, setTimedOut] = useState(false);
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 5 * 60 * 1000); // 5 minutes
    return () => clearTimeout(timer);
  }, []);

  const heading = timedOut
    ? "Sign-in timed out."
    : progress.kind === "SigningIn"
      ? "Signing in..."
      : progress.kind === "Pairing"
        ? "Pairing device..."
        : "Rotating token...";

  const subtext = timedOut
    ? "Try again when ready."
    : "Complete sign-in in your browser.";

  const buttonLabel = timedOut ? "Back to local mode" : "Stop sign-in";

  const handleCancel = async () => {
    try {
      const { signOut } = await import("./state/auth");
      await signOut();
    } catch (e) {
      console.error("cancel auth failed:", e);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 24,
        color: C.t1,
        background: C.bg,
        fontFamily: "inherit",
      }}
    >
      {/* Spinner or static dot */}
      {prefersReducedMotion ? (
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            backgroundColor: C.accent,
          }}
        />
      ) : (
        <span
          style={{
            width: 20,
            height: 20,
            border: `2px solid transparent`,
            borderTopColor: C.accent,
            borderRightColor: C.accent,
            borderBottomColor: C.accent,
            borderRadius: "50%",
            animation: "spin 800ms linear infinite",
            boxSizing: "border-box",
          }}
        />
      )}

      {/* Heading */}
      <span
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 20,
          fontWeight: 500,
          color: C.t1,
        }}
      >
        {heading}
      </span>

      {/* Subtext */}
      <span
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 500,
          color: C.t2,
          marginTop: -16,
        }}
      >
        {subtext}
      </span>

      {/* Cancel button — ghost style */}
      <button
        onClick={handleCancel}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 500,
          color: C.t3,
          padding: "6px 14px",
          borderRadius: 4,
          transition: "color 150ms ease",
        }}
        onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "var(--text-primary)"; }}
        onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "var(--text-faint)"; }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function AuthErrorScreen({
  reason,
  retryAfterMs,
}: {
  reason: AuthErrorReason;
  retryAfterMs: number | null;
}) {
  const [retrying, setRetrying] = useState(false);
  const label =
    reason.kind === "RelayUnreachable"
      ? "Relay unreachable"
      : reason.kind === "KeyringUnavailable"
        ? "Keyring unavailable"
        : reason.kind === "NetworkDown"
          ? "No network connection"
          : "Invalid pair token";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 16,
        color: C.t1,
        background: C.bg,
        fontFamily: "inherit",
      }}
    >
      <span>{label}</span>
      {retryAfterMs !== null && (
        <span style={{ color: C.t3, fontSize: 14 }}>
          Auto-retry in {Math.round(retryAfterMs / 1000)}s
        </span>
      )}
      <button
        onClick={async () => {
          setRetrying(true);
          await retryAuth();
          setRetrying(false);
        }}
        disabled={retrying}
        style={S.btnPrimary}
      >
        Retry now
      </button>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────

function RailItem({
  label, active, online, autoCopy, pinned, onToggleAutoCopy, onClick,
}: {
  label: string;
  active: boolean;
  online?: boolean;
  autoCopy?: boolean;
  pinned?: boolean;
  onToggleAutoCopy?: (e: React.MouseEvent) => void;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const dotColor = online === undefined ? C.t4 : online ? C.success : C.t4;
  return (
    <div
      style={{
        ...S.railItem,
        ...(active ? S.railItemActive : {}),
        ...(hover && !active ? { background: C.hover } : {}),
      }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {pinned ? (
        <span style={{ display: "flex", alignItems: "center", color: active ? C.accent : C.t3 }}>
          <IconPin size={10} />
        </span>
      ) : online !== undefined ? (
        <span style={{ ...S.dot, background: dotColor, width: 6, height: 6 }} />
      ) : (
        <span style={{ width: 6, height: 6 }} />
      )}
      <span style={S.railLabel}>{label}</span>
      {onToggleAutoCopy && (hover || autoCopy) && (
        <button
          title={autoCopy ? "Auto-copy: on — new clips copied automatically" : "Auto-copy: off — click to enable"}
          aria-label={autoCopy ? "Disable auto-copy" : "Enable auto-copy"}
          style={{
            ...S.railAutoCopy,
            color: autoCopy ? C.accent : C.t3,
          }}
          onClick={onToggleAutoCopy}
        >
          <IconAutoCopy size={10} />
        </button>
      )}
    </div>
  );
}

function ClipRow({
  clip, selected, onClick, onDoubleClick, nickname, onPin, onUnpin,
}: {
  clip: LocalClip;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  nickname?: string;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const [hover, setHover] = useState(false);
  const isImage = clip.content_type === "image" && !!clip.media_path;
  const preview = clip.content.replace(/\s+/g, " ").trim().substring(0, 140);
  return (
    <div
      role="button"
      data-id={clip.id}
      aria-selected={selected}
      style={{ ...S.row, ...(selected ? S.rowActive : {}) }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={S.rowGlyph}>
        {isImage ? (
          <img
            src={`cinch://media/${clip.id}`}
            alt=""
            style={S.rowThumb}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <span style={{ color: C.t2 }}>{typeGlyph(clip.content_type, 14)}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.rowPreview}>
          {isImage ? `Image (${formatBytes(clip.byte_size)})` : preview || " "}
        </div>
        <div style={S.rowMeta}>
          <SourcePill
            source={clip.source}
            status={clip.source === "local" ? "local" : "remote"}
            nickname={nickname}
          />
          <span style={S.metaDot}>·</span>
          <span>{formatTime(clip.created_at)}</span>
          {clip.pin_note && (
            <>
              <span style={S.metaDot}>·</span>
              <span style={{ color: C.accent, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {clip.pin_note}
              </span>
            </>
          )}
        </div>
      </div>
      {(hover || clip.is_pinned) && (
        <button
          title={clip.is_pinned ? "Unpin" : "Pin clip"}
          aria-label={clip.is_pinned ? "Unpin" : "Pin clip"}
          style={{
            ...S.rowAction,
            color: clip.is_pinned ? C.accent : C.t3,
            opacity: hover || clip.is_pinned ? 1 : 0,
          }}
          onClick={(e) => { e.stopPropagation(); clip.is_pinned ? onUnpin() : onPin(); }}
        >
          <IconPin size={12} />
        </button>
      )}
    </div>
  );
}

function ClipDetail({ clip }: { clip: LocalClip }) {
  const body =
    clip.content_type === "json" || looksLikeJson(clip.content)
      ? tryPrettyJson(clip.content)
      : clip.content;
  const isImage = clip.content_type === "image" && !!clip.media_path;
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { setDims(null); }, [clip.id]);

  return (
    <>
      <div style={S.detailHeader}>
        <SourcePill
          source={clip.source}
          status={clip.source === "local" ? "local" : "remote"}
        />
        <span style={S.metaDot}>·</span>
        <span style={S.detailTimestamp}>
          {new Date(clip.created_at * 1000).toLocaleString()}
        </span>
        <span style={{ marginLeft: "auto", ...S.detailType }}>{clip.content_type}</span>
      </div>

      <div style={S.detailContent}>
        <div style={S.detailContentBody}>
          {isImage ? (
            <div style={S.imgFrame}>
              <img
                src={`cinch://media/${clip.id}`}
                alt={`Clipboard image from ${clip.source}`}
                style={S.img}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth && img.naturalHeight) {
                    setDims({ w: img.naturalWidth, h: img.naturalHeight });
                  }
                }}
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  const parent = el.parentElement;
                  if (parent) {
                    el.style.display = "none";
                    parent.appendChild(
                      Object.assign(document.createElement("div"), {
                        style: "color:#5A5A63;font-size:12px",
                        textContent: "Image unavailable",
                      }),
                    );
                  }
                }}
              />
            </div>
          ) : (
            <pre style={S.codeBlock}>{body}</pre>
          )}
        </div>

        <dl style={S.metaList}>
          <MetaRow label="source" value={clip.source.startsWith("remote:") ? clip.source.replace("remote:", "") : clip.source} />
          <MetaRow label="type" value={clip.content_type} />
          <MetaRow label="size" value={formatBytes(clip.byte_size)} />
          {isImage && dims && (
            <MetaRow label="dimensions" value={`${dims.w} × ${dims.h}`} />
          )}
          {clip.is_pinned && (
            <MetaRow label="note" value={clip.pin_note ?? "(no note)"} />
          )}
        </dl>
      </div>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.metaRow}>
      <dt style={S.metaKey}>{label}</dt>
      <dd style={S.metaVal}>{value}</dd>
    </div>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span style={S.hint}>
      <kbd style={S.kbd}>{keys}</kbd>
      <span style={S.hintLabel}>{label}</span>
    </span>
  );
}

// Off-screen buttons so screen-readers/keyboard can still trigger actions.
function HiddenActions({ onCopy, onDelete }: { onCopy: () => void; onDelete: () => void }) {
  return (
    <div style={{ position: "absolute", left: -9999, top: -9999 }} aria-hidden="true">
      <button onClick={onCopy}><IconCopy /></button>
      <button onClick={onDelete}><IconTrash /></button>
    </div>
  );
}

function ShortcutPanel({ onClose }: { onClose: () => void }) {
  const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: "Navigation",
      rows: [
        { keys: ["↑", "↓"], label: "Move between clips" },
        { keys: ["^J", "^K"], label: "Move between clips (vim)" },
        { keys: ["^H", "^L"], label: "Cycle source filter" },
      ],
    },
    {
      title: "Actions",
      rows: [
        { keys: ["↵"], label: "Copy selected clip" },
        { keys: ["⌘C"], label: "Copy selected clip" },
        { keys: ["⌘⌫"], label: "Delete selected clip" },
        { keys: ["⌘P"], label: "Pin / unpin selected clip" },
      ],
    },
    {
      title: "Search",
      rows: [
        { keys: ["⌘F"], label: "Focus search" },
        { keys: ["Esc"], label: "Clear search / deselect" },
      ],
    },
    {
      title: "General",
      rows: [
        { keys: ["?"], label: "Toggle this panel" },
        { keys: ["⌘,"], label: "Open settings" },
      ],
    },
  ];

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.dialog, maxWidth: 340, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>Keyboard shortcuts</span>
          <button style={{ ...S.btnGhost, padding: "2px 8px", fontSize: 11 }} onClick={onClose}>Esc</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {groups.map((g) => (
            <div key={g.title}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.t3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                {g.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {g.rows.map((r) => (
                  <div key={r.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, color: C.t2 }}>{r.label}</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {r.keys.map((k) => (
                        <kbd key={k} style={S.kbd}>{k}</kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PinNoteDialog({
  clip,
  onConfirm,
  onCancel,
}: {
  clip: LocalClip;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState(clip.pin_note ?? "");
  const preview = clip.content.replace(/\s+/g, " ").trim().substring(0, 60);

  return (
    <div style={S.overlay} onClick={onCancel}>
      <div style={{ ...S.dialog, maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.dialogTitle}>Pin clip</div>
        <div style={{ fontSize: 11, color: C.t3, marginBottom: 10, fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {preview || "(image)"}
        </div>
        <textarea
          autoFocus
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onConfirm(note); }
            if (e.key === "Escape") onCancel();
          }}
          style={{
            width: "100%",
            minHeight: 60,
            background: C.card2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.t1,
            fontSize: 12,
            fontFamily: "inherit",
            padding: "6px 8px",
            resize: "none",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 12,
          }}
        />
        <div style={S.dialogActions}>
          <button style={S.btnGhost} onClick={onCancel}>Cancel</button>
          <button style={S.btnPrimary} onClick={() => onConfirm(note)}>Pin</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, icon }: { message: string; icon: "copy" | "trash" }) {
  return (
    <div style={S.toast}>
      <span style={{ color: C.t3, display: "flex", alignItems: "center" }}>
        {icon === "copy" ? <IconCopy size={12} /> : <IconTrash size={12} />}
      </span>
      <span style={S.toastText}>{message}</span>
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function tryPrettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// Suppress unused import warning; IconImage reserved for empty-state future use.
void IconImage;

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    background: C.bg,
    color: C.t1,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    border: `1px solid ${C.border}`,
  },

  // Search bar (top)
  searchBar: {
    display: "flex",
    alignItems: "center",
    height: 46,
    padding: "0 14px",
    gap: 10,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  themeBtn: {
    background: "transparent",
    border: "none",
    color: C.t3,
    cursor: "pointer",
    padding: 5,
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    flexShrink: 0,
  },
  searchIcon: { color: C.t2, display: "flex", alignItems: "center" },
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    color: C.t1,
    fontSize: 15,
    fontWeight: 400,
    fontFamily: "inherit",
    outline: "none",
    letterSpacing: "-0.01em",
  },
  searchClear: {
    background: "transparent",
    border: "none",
    color: C.t3,
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
  },


  // Main content
  content: {
    display: "flex",
    flex: 1,
    minHeight: 0,
  },

  // Rail (sources)
  rail: {
    width: 148,
    borderRight: `1px solid ${C.border}`,
    overflowY: "auto",
    padding: "6px 6px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  railItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 8px",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    color: C.t2,
    minHeight: 24,
  },
  railItemActive: {
    background: C.selected,
    color: C.t1,
  },
  railLabel: {
    flex: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  railAutoCopy: {
    width: 16,
    height: 16,
    borderRadius: 3,
    background: "transparent",
    border: `1px solid ${C.border}`,
    fontSize: 9,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  // Clip list
  listCol: {
    width: 340,
    borderRight: `1px solid ${C.border}`,
    overflowY: "auto",
    flexShrink: 0,
    padding: "4px 0",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "7px 12px",
    cursor: "pointer",
    borderLeft: "2px solid transparent",
  },
  rowActive: {
    background: C.selected,
    borderLeftColor: C.accent,
  },
  rowGlyph: {
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
  },
  rowThumb: {
    width: 22,
    height: 22,
    objectFit: "cover",
    borderRadius: 3,
    background: C.card2,
  },
  rowAction: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "2px 4px",
    display: "flex",
    alignItems: "center",
    borderRadius: 3,
    flexShrink: 0,
    transition: "color 100ms ease",
  },
  rowPreview: {
    fontSize: 13,
    color: C.t1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    lineHeight: 1.4,
  },
  rowMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: C.t3,
    marginTop: 2,
  },
  rowSource: {
    color: C.t2,
  },
  metaDot: { color: C.t4 },

  empty: {
    padding: "40px 20px",
    textAlign: "center",
  },

  // Detail
  detailCol: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  detailHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 18px",
    borderBottom: `1px solid ${C.border}`,
    fontSize: 11,
    color: C.t3,
    flexShrink: 0,
  },
  detailSource: { color: C.t1, fontWeight: 500 },
  detailTimestamp: { color: C.t3 },
  detailType: {
    fontSize: 10,
    color: C.t3,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  detailContent: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 18px 20px",
    display: "flex",
    flexDirection: "column",
  },
  detailContentBody: {
    flex: 1,
    marginBottom: 16,
  },
  codeBlock: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: "12px 14px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12.5,
    lineHeight: 1.65,
    color: C.t1,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: 0,
  },
  imgFrame: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: 18,
    minHeight: 160,
  },
  img: {
    maxWidth: "100%",
    maxHeight: "60vh",
    objectFit: "contain",
    borderRadius: 2,
  },
  emptyDetail: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: C.t3,
    fontSize: 12,
  },

  // Metadata list
  metaList: {
    margin: 0,
    paddingTop: 16,
    borderTop: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  metaRow: {
    display: "flex",
    padding: "4px 0",
    fontSize: 12,
  },
  metaKey: {
    width: 80,
    color: C.t3,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    margin: 0,
  },
  metaVal: {
    flex: 1,
    color: C.t1,
    fontFamily: "'JetBrains Mono', monospace",
    margin: 0,
    wordBreak: "break-all",
  },

  // Status bar (bottom)
  statusBar: {
    display: "flex",
    alignItems: "center",
    height: 30,
    padding: "0 12px",
    borderTop: `1px solid ${C.border}`,
    background: C.bg,
    flexShrink: 0,
    gap: 16,
  },
  statusLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: C.t2,
  },
  statusRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  statusText: { color: C.t2 },
  statusSep: { color: C.t4 },
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },

  hint: { display: "flex", alignItems: "center", gap: 5 },
  kbd: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    padding: "1px 5px",
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 3,
    color: C.t2,
    lineHeight: 1.4,
    minWidth: 16,
    textAlign: "center" as const,
  },
  hintLabel: { fontSize: 11, color: C.t3 },

  // Toast notification
  toast: {
    position: "fixed" as const,
    bottom: 44,
    left: "50%",
    transform: "translateX(-50%)",
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: "6px 14px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    zIndex: 200,
    pointerEvents: "none" as const,
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    whiteSpace: "nowrap" as const,
  },
  toastText: {
    fontSize: 12,
    color: C.t2,
  },

  // Dialog
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  dialog: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 18,
    maxWidth: 380,
    width: "100%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
  },
  dialogTitle: { fontSize: 13, fontWeight: 600, color: C.t1, marginBottom: 6 },
  dialogBody: { fontSize: 12, color: C.t2, marginBottom: 16, lineHeight: 1.55 },
  dialogActions: { display: "flex", gap: 8, justifyContent: "flex-end" },
  btnPrimary: {
    padding: "6px 14px",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    background: C.t1,
    color: C.bg,
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  btnGhost: {
    padding: "6px 14px",
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    background: "transparent",
    color: C.t2,
    border: `1px solid ${C.border}`,
    cursor: "pointer",
    fontFamily: "inherit",
  },
};

export default App;
