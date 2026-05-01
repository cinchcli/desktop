import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands, events } from './bindings';
import type { LocalClip, SourceInfo, Device } from './bindings';
import { unwrap } from './lib/tauri';
import { C } from './design';
import { useAuthState, retryAuth, type AuthProgress, type AuthErrorReason } from './state/auth';
import SettingsPane from './SettingsPane';
import { LocalOnlyView } from './components/LocalOnlyView';
import { AdoptedAuthToast } from './components/AdoptedAuthToast';
import { AddRelayDialog } from './components/AddRelayDialog';
import { Rail, type RailPanel } from './components/Rail';
import { SearchBar } from './components/SearchBar';
import { ClipList } from './components/ClipList';
import { ClipDetail } from './components/ClipDetail';
import { StatusBar } from './components/StatusBar';
import { PinnedPanel } from './components/PinnedPanel';
import { MachinesPanel } from './components/MachinesPanel';
import { dialogStyles } from './components/dialogPrimitives';
import { IconCopy, IconTrash } from './icons';
import './App.css';

// ─── Theme ─────────────────────────────────────────────────

type Theme = 'dark' | 'light';

function systemPreference(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolveTheme(): Theme {
  return (localStorage.getItem('cinch-theme') as Theme) ?? systemPreference();
}

function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  // Apply html class whenever theme changes
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Follow system preference changes — only when user hasn't explicitly chosen
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem('cinch-theme')) {
        setTheme(e.matches ? 'light' : 'dark');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      localStorage.setItem('cinch-theme', next);
      return next;
    });

  return { theme, toggle };
}


function handleWindowDrag(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest('button, input, a, textarea')) {
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
      setHandoffRelay(e.payload.relay_url || '');
    });
    return () => { unsubP.then((f) => f()); };
  }, []);
  const [_status, setStatus] = useState('connecting');
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [selectedClip, setSelectedClip] = useState<LocalClip | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [newSourcePrompt, setNewSourcePrompt] = useState<string | null>(null);
  const [pinNoteDialog, setPinNoteDialog] = useState<{ clip: LocalClip } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [activePanel, setActivePanel] = useState<RailPanel>('inbox');
  const searchRef = useRef<HTMLInputElement>(null);
  const clipListRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<{ message: string; icon: 'copy' | 'trash' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, icon: 'copy' | 'trash') => {
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
      if (activePanel === 'pinned') {
        const pinned = await unwrap(commands.listPinnedClips());
        const q = debouncedQuery.trim().toLowerCase();
        setClips(q
          ? pinned.filter(
              c => c.content.toLowerCase().includes(q) || c.pin_note?.toLowerCase().includes(q),
            )
          : pinned);
        return;
      }
      if (debouncedQuery.trim()) {
        const results = await unwrap(commands.searchClips(debouncedQuery, 100));
        const filtered = selectedSource ? results.filter((c) => c.source === selectedSource) : results;
        setClips(filtered);
      } else {
        const results = await unwrap(commands.listClips(selectedSource, null, 100));
        setClips(results);
      }
    } catch (e) {
      console.error('failed to load clips:', e);
    }
  }, [activePanel, debouncedQuery, selectedSource]);

  const refreshSources = useCallback(async () => {
    try {
      setSources(await unwrap(commands.getSources()));
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

  const handleNewSourceResponse = async (source: string, enable: boolean) => {
    await unwrap(commands.setSourceAutoCopy(source, enable));
    setNewSourcePrompt(null);
  };

  useEffect(() => {
    if (auth.variant !== 'Authenticated') return;
    const timer = setTimeout(() => {
      refreshClips();
      refreshSources();
      refreshDevices();
    }, 1000);
    return () => clearTimeout(timer);
  }, [auth.variant, refreshClips, refreshSources, refreshDevices]);

  useEffect(() => { refreshClips(); }, [refreshClips]);

  // Scroll selected clip into view when navigating with keyboard
  useEffect(() => {
    if (!selectedClip || !clipListRef.current) return;
    const el = clipListRef.current.querySelector<HTMLElement>(`[data-id="${selectedClip.id}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedClip]);

  useEffect(() => {
    commands.getWsStatus().then(setStatus).catch(() => {});
    const unsubs = [
      events.wsStatus.listen((e) => setStatus(e.payload)),
      events.clipReceived.listen(() => { refreshClips(); refreshSources(); }),
      events.clipDeleted.listen(() => { refreshClips(); refreshSources(); }),
      events.newSourceDetected.listen((e) => {
        setNewSourcePrompt(e.payload);
      }),
    ];
    return () => { unsubs.forEach((p) => p.then((f) => f())); };
  }, [refreshClips, refreshSources]);

  const copyClip = useCallback((clip: LocalClip) => {
    if (clip.content_type === 'image' && clip.media_path) {
      unwrap(commands.copyImageToClipboard(clip.media_path));
      showToast('Copied image to clipboard', 'copy');
    } else {
      unwrap(commands.copyClipToClipboard(clip.content));
      showToast('Copied to clipboard', 'copy');
    }
  }, [showToast]);

  const handleDelete = async (id: string) => {
    await unwrap(commands.deleteClip(id));
    if (selectedClip?.id === id) setSelectedClip(null);
    refreshClips();
    refreshSources();
    showToast('Deleted', 'trash');
  };

  const handlePin = async (clip: LocalClip, note: string | null) => {
    await unwrap(commands.pinClip(clip.id, note));
    setPinNoteDialog(null);
    refreshClips();
    showToast('Pinned', 'copy');
  };

  const handleUnpin = async (clip: LocalClip) => {
    await unwrap(commands.unpinClip(clip.id));
    refreshClips();
    showToast('Unpinned', 'trash');
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
        } else if (searchQuery) {
          setSearchQuery('');
        } else if (selectedClip) {
          setSelectedClip(null);
        }
      }
      if (e.key === '?' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setShowShortcuts(v => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(v => !v);
        return;
      }
      if (selectedClip) {
        if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          copyClip(selectedClip);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
          e.preventDefault();
          handleDelete(selectedClip.id);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
          if (!window.getSelection()?.toString()) copyClip(selectedClip);
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          if (selectedClip.is_pinned) {
            handleUnpin(selectedClip);
          } else {
            setPinNoteDialog({ clip: selectedClip });
          }
        }
      }
      // Ctrl+H / Ctrl+L — cycle sources (only when not typing in search)
      if (e.ctrlKey && (e.key === 'h' || e.key === 'l') && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        const all = [null, ...sources.map((s) => s.source)];
        const idx = all.indexOf(selectedSource);
        const next = e.key === 'l'
          ? (idx + 1) % all.length
          : (idx - 1 + all.length) % all.length;
        setSelectedSource(all[next]);
        setSelectedClip(null);
      }
      const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'j');
      const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'k');
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
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchQuery, selectedClip, clips, sources, selectedSource, copyClip, showShortcuts]);

  const totalClips = sources.reduce((sum, s) => sum + s.clip_count, 0);

  // from: token parsing for device-scoped clip filtering (T3-04)
  const fromMatch = searchQuery.match(/from:(\S+)/i);
  const sourceFilterToken = fromMatch ? fromMatch[1] : null;
  const sourceFilter = useMemo(() => {
    if (!sourceFilterToken) return null;
    const nick = sourceFilterToken.toLowerCase();
    const matched = devices.find(
      d => (d.nickname?.toLowerCase() === nick) || (d.hostname?.toLowerCase() === nick)
    );
    return matched ? matched.source_key : '__no_match__';
  }, [sourceFilterToken, devices]);

  // Apply from: filter to clip list
  const filteredClips = useMemo(() => {
    if (!sourceFilter) return clips;
    if (sourceFilter === '__no_match__') return [];
    return clips.filter(c => c.source === sourceFilter);
  }, [clips, sourceFilter]);

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
    auth.variant === 'Authenticated' ? auth.payload.device_id : '';

  // Settings overlay — lifted above auth checks so it works in all auth states
  const settingsOverlay = showSettings ? (
    <SettingsPane onClose={() => { setShowSettings(false); if (auth.variant === 'Authenticated') refreshDevices(); }} clipCount={totalClips} />
  ) : null;

  const handoffDialog = handoffRelay !== null ? (
    <AddRelayDialog
      onClose={() => setHandoffRelay(null)}
      initialRelayUrl={handoffRelay}
      fromCli
    />
  ) : null;

  if (auth.variant === 'LocalOnly') {
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
  if (auth.variant === 'Authenticating') {
    return <AuthLoadingScreen progress={auth.payload.progress} />;
  }
  if (auth.variant === 'ErrorRecoverable') {
    return (
      <AuthErrorScreen
        reason={auth.payload.reason}
        retryAfterMs={auth.payload.retry_after_ms}
      />
    );
  }
  // auth.variant === 'Authenticated' — render dashboard.

  return (
    <main data-testid="dashboard-root" style={S.main}>
      <SearchBar
        ref={searchRef}
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
        theme={theme}
        onToggleTheme={toggleTheme}
        onMouseDown={handleWindowDrag}
      />

      <div style={S.body}>
        <Rail
          active={activePanel}
          onSelect={(panel) => {
            setActivePanel(panel);
            setSelectedClip(null);
            setSelectedSource(null);
          }}
          onOpenSettings={() => setShowSettings(true)}
        />

        {activePanel === 'machines' ? (
          <MachinesPanel
            currentDeviceID={currentDeviceID}
            onShowToast={(msg) => showToast(msg, 'copy')}
            onDeviceChange={refreshDevices}
          />
        ) : activePanel === 'pinned' ? (
          <PinnedPanel
            clips={filteredClips}
            selected={selectedClip}
            onSelect={setSelectedClip}
            onCopy={copyClip}
            onPin={(c) => setPinNoteDialog({ clip: c })}
            onUnpin={handleUnpin}
            onDelete={(c) => handleDelete(c.id)}
            query={debouncedQuery}
            deviceNicknames={nicknameBySource}
            listRef={clipListRef}
          />
        ) : (
          <>
            <ClipList
              ref={clipListRef}
              clips={filteredClips}
              selected={selectedClip}
              onSelect={setSelectedClip}
              onCopy={copyClip}
              query={debouncedQuery}
              deviceNicknames={nicknameBySource}
            />
            <ClipDetail
              clip={selectedClip}
              onCopy={copyClip}
              onPin={(c) => c.is_pinned ? handleUnpin(c) : setPinNoteDialog({ clip: c })}
              onDelete={(c) => handleDelete(c.id)}
            />
          </>
        )}
      </div>

      <StatusBar
        clipCount={totalClips}
        machinesOnline={devices.length > 0 ? devices.filter(d => d.online).length : undefined}
        machinesTotal={devices.length > 0 ? devices.length : undefined}
        hints={selectedClip
          ? [
              { keys: '↵', label: 'copy' },
              { keys: '⌘⌫', label: 'delete' },
              { keys: '?', label: 'shortcuts' },
            ]
          : [
              { keys: '⌘F', label: 'search' },
              { keys: '↑↓', label: 'navigate' },
              { keys: '?', label: 'shortcuts' },
            ]}
        onMouseDown={handleWindowDrag}
      />

      {selectedClip && (
        <HiddenActions
          onCopy={() => copyClip(selectedClip)}
          onDelete={() => handleDelete(selectedClip.id)}
        />
      )}

      {pinNoteDialog && (
        <PinNoteDialog
          clip={pinNoteDialog.clip}
          onConfirm={(note) => handlePin(pinNoteDialog.clip, note || null)}
          onCancel={() => setPinNoteDialog(null)}
        />
      )}

      {newSourcePrompt && (
        <NewSourceDialog
          source={newSourcePrompt}
          onAccept={() => setNewSourcePrompt(null)}
          onDisableAutoCopy={() => handleNewSourceResponse(newSourcePrompt, false)}
        />
      )}

      {settingsOverlay}
      {showShortcuts && <ShortcutPanel onClose={() => setShowShortcuts(false)} />}
      {toast && <Toast message={toast.message} icon={toast.icon} />}
      <AdoptedAuthToast />
      {handoffDialog}
    </main>
  );
}

// ─── Auth transition screens (plumbing only per D-14 — no visual redesign) ────

function AuthLoadingScreen({ progress }: { progress: AuthProgress }) {
  const [timedOut, setTimedOut] = useState(false);
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 5 * 60 * 1000); // 5 minutes
    return () => clearTimeout(timer);
  }, []);

  const heading = timedOut
    ? 'Sign-in timed out.'
    : progress.kind === 'SigningIn'
      ? 'Signing in...'
      : progress.kind === 'Pairing'
        ? 'Pairing device...'
        : 'Rotating token...';

  const subtext = timedOut
    ? 'Try again when ready.'
    : 'Complete sign-in in your browser.';

  const buttonLabel = timedOut ? 'Back to local mode' : 'Stop sign-in';

  const handleCancel = async () => {
    try {
      const { signOut } = await import('./state/auth');
      await signOut();
    } catch (e) {
      console.error('cancel auth failed:', e);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 24,
        color: C.t1,
        background: C.bg,
        fontFamily: 'inherit',
      }}
    >
      {/* Spinner or static dot */}
      {prefersReducedMotion ? (
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            backgroundColor: C.accent,
          }}
        />
      ) : (
        <span
          style={{
            width: 20,
            height: 20,
            border: '2px solid transparent',
            borderTopColor: C.accent,
            borderRightColor: C.accent,
            borderBottomColor: C.accent,
            borderRadius: '50%',
            animation: 'spin 800ms linear infinite',
            boxSizing: 'border-box',
          }}
        />
      )}

      {/* Heading */}
      <span
        style={{
          fontFamily: 'Inter, system-ui, sans-serif',
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
          fontFamily: 'Inter, system-ui, sans-serif',
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
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 14,
          fontWeight: 500,
          color: C.t3,
          padding: '6px 14px',
          borderRadius: 4,
          transition: 'color 150ms ease',
        }}
        onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
        onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = 'var(--text-faint)'; }}
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
    reason.kind === 'RelayUnreachable'
      ? 'Relay unreachable'
      : reason.kind === 'KeyringUnavailable'
        ? 'Keyring unavailable'
        : reason.kind === 'NetworkDown'
          ? 'No network connection'
          : 'Invalid pair token';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 16,
        color: C.t1,
        background: C.bg,
        fontFamily: 'inherit',
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
        style={dialogStyles.btnPrimary}
      >
        Retry now
      </button>
    </div>
  );
}

// ─── Internal helper components ────────────────────────────

// Off-screen buttons so screen-readers/keyboard can still trigger actions.
function HiddenActions({ onCopy, onDelete }: { onCopy: () => void; onDelete: () => void }) {
  return (
    <div style={{ position: 'absolute', left: -9999, top: -9999 }} aria-hidden="true">
      <button onClick={onCopy}><IconCopy /></button>
      <button onClick={onDelete}><IconTrash /></button>
    </div>
  );
}

function ShortcutPanel({ onClose }: { onClose: () => void }) {
  const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: 'Navigation',
      rows: [
        { keys: ['↑', '↓'], label: 'Move between clips' },
        { keys: ['^J', '^K'], label: 'Move between clips (vim)' },
        { keys: ['^H', '^L'], label: 'Cycle source filter' },
      ],
    },
    {
      title: 'Actions',
      rows: [
        { keys: ['↵'], label: 'Copy selected clip' },
        { keys: ['⌘C'], label: 'Copy selected clip' },
        { keys: ['⌘⌫'], label: 'Delete selected clip' },
        { keys: ['⌘P'], label: 'Pin / unpin selected clip' },
      ],
    },
    {
      title: 'Search',
      rows: [
        { keys: ['⌘F'], label: 'Focus search' },
        { keys: ['Esc'], label: 'Clear search / deselect' },
      ],
    },
    {
      title: 'General',
      rows: [
        { keys: ['?'], label: 'Toggle this panel' },
        { keys: ['⌘,'], label: 'Open settings' },
      ],
    },
  ];

  const kbdStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '1px 5px',
    background: 'var(--kbd-bg)',
    border: '1px solid var(--kbd-border)',
    borderRadius: 3,
    color: 'var(--kbd-color)',
    lineHeight: 1.4,
    minWidth: 16,
    textAlign: 'center',
  };

  return (
    <div style={dialogStyles.overlay} onClick={onClose}>
      <div style={{ ...dialogStyles.dialog, maxWidth: 340, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.t1 }}>Keyboard shortcuts</span>
          <button style={{ ...dialogStyles.btnGhost, padding: '2px 8px', fontSize: 11 }} onClick={onClose}>Esc</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {groups.map((g) => (
            <div key={g.title}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.t3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                {g.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {g.rows.map((r) => (
                  <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: C.t2 }}>{r.label}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {r.keys.map((k) => (
                        <kbd key={k} style={kbdStyle}>{k}</kbd>
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
  const [note, setNote] = useState(clip.pin_note ?? '');
  const preview = clip.content.replace(/\s+/g, ' ').trim().substring(0, 60);

  return (
    <div style={dialogStyles.overlay} onClick={onCancel}>
      <div style={{ ...dialogStyles.dialog, maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div style={dialogStyles.title}>Pin clip</div>
        <div style={{ fontSize: 11, color: C.t3, marginBottom: 10, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview || '(image)'}
        </div>
        <textarea
          autoFocus
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onConfirm(note); }
            if (e.key === 'Escape') onCancel();
          }}
          style={{
            width: '100%',
            minHeight: 60,
            background: C.card2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.t1,
            fontSize: 12,
            fontFamily: 'inherit',
            padding: '6px 8px',
            resize: 'none',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: 12,
          }}
        />
        <div style={dialogStyles.actions}>
          <button style={dialogStyles.btnGhost} onClick={onCancel}>Cancel</button>
          <button style={dialogStyles.btnPrimary} onClick={() => onConfirm(note)}>Pin</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, icon }: { message: string; icon: 'copy' | 'trash' }) {
  const toastStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 44,
    left: '50%',
    transform: 'translateX(-50%)',
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '6px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    zIndex: 200,
    pointerEvents: 'none',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    whiteSpace: 'nowrap',
  };
  const textStyle: React.CSSProperties = { fontSize: 12, color: C.t2 };
  return (
    <div style={toastStyle}>
      <span style={{ color: C.t3, display: 'flex', alignItems: 'center' }}>
        {icon === 'copy' ? <IconCopy size={12} /> : <IconTrash size={12} />}
      </span>
      <span style={textStyle}>{message}</span>
    </div>
  );
}

function NewSourceDialog({
  source,
  onAccept,
  onDisableAutoCopy,
}: {
  source: string;
  onAccept: () => void;
  onDisableAutoCopy: () => void;
}) {
  return (
    <div style={dialogStyles.overlay} onClick={onAccept}>
      <div style={dialogStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={dialogStyles.title}>New source detected</div>
        <div style={dialogStyles.body}>
          <code style={{ color: C.accent, fontFamily: 'var(--font-mono)' }}>
            {source.replace('remote:', '')}
          </code>{' '}
          is sending clips. Auto-copy is on by default.
        </div>
        <div style={dialogStyles.actions}>
          <button style={dialogStyles.btnGhost} onClick={onDisableAutoCopy}>
            Disable auto-copy
          </button>
          <button style={dialogStyles.btnPrimary} onClick={onAccept}>OK</button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  main: {
    background: C.bg,
    color: C.t1,
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden',
    border: `1px solid ${C.border}`,
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
};

export default App;
