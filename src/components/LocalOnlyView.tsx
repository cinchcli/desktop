import { useEffect, useState, useCallback, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, events } from "../bindings";
import type { LocalClip } from "../bindings";
import { unwrap } from "../lib/tauri";
import { applyClipFilter, CLIP_FILTERS, type ClipFilter } from "../lib/clipFilters";
import { C } from "../design";
import { IconSearch, IconX, IconSun, IconMoon, IconGear, IconCopy, IconTrash } from "../icons";
import { ClipCard } from "./ClipCard";
import { ClipDetail } from "./ClipDetail";
import { EmptyState } from "./EmptyState";
import { UpgradePrompt } from "./UpgradePrompt";

// ─── Props ────────────────────────────────────────────────

interface LocalOnlyViewProps {
  theme: "dark" | "light";
  toggleTheme: () => void;
  onOpenSettings: () => void;
}

// ─── Loading Skeleton ─────────────────────────────────────

function LoadingSkeleton() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <div data-testid="loading-skeleton" style={{ padding: "4px 16px" }}>
      {rows.map((i) => (
        <div
          key={i}
          style={{
            height: 44,
            background: C.card,
            borderRadius: 8,
            marginBottom: 4,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            className="shimmer-strip"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "30%",
              height: "100%",
              background: `linear-gradient(90deg, transparent, ${C.card2}, transparent)`,
              animation: "shimmer 1.5s linear infinite",
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────

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

// ─── LocalOnlyView ────────────────────────────────────────

export function LocalOnlyView({ theme, toggleTheme, onOpenSettings }: LocalOnlyViewProps) {
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [selectedClip, setSelectedClip] = useState<LocalClip | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<ClipFilter>("all");
  const [loading, setLoading] = useState(true);
  const [upgradePromptDismissed, setUpgradePromptDismissed] = useState(false);
  const [toast, setToast] = useState<{ message: string; icon: "copy" | "trash" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const clipListRef = useRef<HTMLDivElement>(null);

  // ─── Debounce search ──────────────────────────────────

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ─── Toast helper ─────────────────────────────────────

  const showToast = useCallback((message: string, icon: "copy" | "trash") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, icon });
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  // ─── Clip list logic ──────────────────────────────────

  const refreshClips = useCallback(async () => {
    try {
      const q = debouncedQuery.trim();
      let results: LocalClip[];

      if (q) {
        results = await unwrap(commands.searchClips(q, 500));
      } else {
        results = await unwrap(commands.listClips(null, null, 500));
      }

      results = applyClipFilter(results, activeFilter);

      setClips(results);
    } catch (e) {
      console.error("failed to load clips:", e);
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, activeFilter]);

  // Initial load
  useEffect(() => {
    refreshClips();
  }, [refreshClips]);

  // Event subscriptions
  useEffect(() => {
    const unsubs = [
      events.clipReceived.listen(() => refreshClips()),
      events.clipDeleted.listen(() => refreshClips()),
      events.imageDownloadComplete.listen(() => refreshClips()),
    ];
    return () => {
      unsubs.forEach((p) => p.then((f) => f()));
    };
  }, [refreshClips]);

  useEffect(() => {
    const unsubBlur = getCurrentWindow().listen('tauri://blur', () => {
      setSelectedClip(null);
      setSearchQuery('');
      setDebouncedQuery('');
    });
    return () => { unsubBlur.then((f) => f()); };
  }, []);

  // Scroll selected clip into view
  useEffect(() => {
    if (!selectedClip || !clipListRef.current) return;
    const el = clipListRef.current.querySelector<HTMLElement>(`[data-id="${selectedClip.id}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedClip]);

  // ─── Copy/Delete handlers ─────────────────────────────

  const copyClip = useCallback((clip: LocalClip) => {
    if (clip.content_type === "image" && clip.media_path) {
      unwrap(commands.copyImageToClipboard(clip.media_path));
      showToast("Copied image to clipboard", "copy");
    } else {
      unwrap(commands.copyClipToClipboard(clip.content));
      showToast("Copied to clipboard", "copy");
    }
    setSelectedClip(null);
  }, [showToast]);

  const handleDelete = useCallback(async (id: string) => {
    await unwrap(commands.deleteClip(id));
    if (selectedClip?.id === id) setSelectedClip(null);
    refreshClips();
    showToast("Deleted", "trash");
  }, [selectedClip, refreshClips, showToast]);

  const handlePin = useCallback(async (clip: LocalClip) => {
    if (clip.is_pinned) {
      await unwrap(commands.unpinClip(clip.id));
    } else {
      await unwrap(commands.pinClip(clip.id, null));
    }
    refreshClips();
  }, [refreshClips]);

  // ─── Keyboard handlers ────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+Shift+C: plain-text paste (D-06)
      if (meta && e.shiftKey && e.key === "c") {
        e.preventDefault();
        if (selectedClip) {
          unwrap(commands.copyClipToClipboard(selectedClip.content));
          showToast("Copied as plain text", "copy");
        }
        return;
      }

      // Cmd+F: focus search
      if (meta && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      // Escape: cascade — blur search → clear search → deselect clip
      if (e.key === "Escape") {
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
        } else if (searchQuery) {
          setSearchQuery("");
        } else if (selectedClip) {
          setSelectedClip(null);
        }
        return;
      }

      // Enter: copy selected clip (non-input context)
      if (selectedClip && e.key === "Enter" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        copyClip(selectedClip);
        return;
      }

      // Cmd+C: copy selected clip content if no text selection
      if (selectedClip && meta && e.key === "c" && !e.shiftKey) {
        if (!window.getSelection()?.toString()) {
          copyClip(selectedClip);
        }
        return;
      }

      // ArrowUp/ArrowDown or Ctrl+K/Ctrl+J: navigate clip list
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
  }, [selectedClip, clips, searchQuery, copyClip, handleDelete, showToast]);

  // ─── Render ───────────────────────────────────────────

  return (
    <div data-testid="local-only-view" style={S.container}>
      {/* Top: search bar strip */}
      <div style={S.searchBar}>
        <span style={S.searchIcon}>
          <IconSearch size={14} />
        </span>
        <input
          ref={searchRef}
          style={S.searchInput}
          placeholder="Search clips"
          aria-label="Search clips"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          spellCheck={false}
        />
        {searchQuery && (
          <button
            style={S.clearBtn}
            onClick={() => setSearchQuery("")}
            aria-label="Clear search"
          >
            <IconX size={12} />
          </button>
        )}
        <button
          style={S.iconBtn}
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <IconSun size={13} /> : <IconMoon size={13} />}
        </button>
        <button
          style={S.iconBtn}
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <IconGear size={13} />
        </button>
      </div>

      {/* Filter row */}
      <div style={S.filterRow}>
        {CLIP_FILTERS.map((f) => (
          <button
            key={f}
            style={{
              ...S.pill,
              ...(activeFilter === f ? S.pillActive : {}),
            }}
            onClick={() => setActiveFilter(f)}
            aria-pressed={activeFilter === f}
          >
            <span style={{ ...S.pillDot, ...S[`dot_${f}`] }} />
            {f}
          </button>
        ))}
      </div>

      {/* Middle: clip list + detail pane */}
      <div style={S.body}>
        <div ref={clipListRef} style={S.clipList}>
          {loading ? (
            <LoadingSkeleton />
          ) : clips.length === 0 ? (
            <EmptyState
              variant={debouncedQuery ? "search-miss" : "no-clips"}
              query={debouncedQuery || undefined}
            />
          ) : (
            <div style={{ padding: "4px 0", display: "flex", flexDirection: "column", gap: 4 }}>
              {clips.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  selected={selectedClip?.id === clip.id}
                  onCopy={() => copyClip(clip)}
                  onDelete={() => handleDelete(clip.id)}
                  onClick={() => setSelectedClip(clip)}
                  onDoubleClick={() => {
                    setSelectedClip(clip);
                    copyClip(clip);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div style={S.detailPane}>
          <ClipDetail
            clip={selectedClip}
            onCopy={copyClip}
            onPin={handlePin}
            onDelete={(c) => handleDelete(c.id)}
            searchQuery={debouncedQuery}
          />
        </div>
      </div>

      {/* Bottom: upgrade prompt footer */}
      {!upgradePromptDismissed && (
        <UpgradePrompt onDismiss={() => setUpgradePromptDismissed(true)} />
      )}

      {/* Toast notification */}
      {toast && <Toast message={toast.message} icon={toast.icon} />}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: C.bg,
    color: C.t1,
    position: "relative",
  },
  searchBar: {
    display: "flex",
    alignItems: "center",
    height: 50,
    padding: "0 18px",
    gap: 12,
    background: C.card,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
  },
  searchIcon: {
    color: C.t3,
    display: "flex",
    alignItems: "center",
  },
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    fontFamily: 'var(--font-body)',
    fontSize: 15,
    fontWeight: 400,
    letterSpacing: "-0.01em",
    color: C.t1,
  },
  clearBtn: {
    background: "transparent",
    border: "none",
    color: C.t3,
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: C.t3,
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    flexShrink: 0,
  },
  body: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  clipList: {
    width: 320,
    flexShrink: 0,
    overflowY: "auto",
    background: C.bg,
  },
  detailPane: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    borderLeft: `1px solid ${C.border}`,
    overflow: "hidden",
  },
  filterRow: {
    display: "flex",
    alignItems: "center",
    height: 36,
    padding: "0 14px",
    gap: 5,
    background: C.card,
    borderBottom: `1px solid ${C.border}`,
    flexShrink: 0,
    overflowX: "auto",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 9px",
    borderRadius: 20,
    border: `1px solid ${C.border}`,
    background: "transparent",
    color: C.t3,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.03em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  pillActive: {
    background: C.card2,
    border: `1px solid ${C.borderHover}`,
    color: C.t1,
  },
  pillDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "currentColor",
    flexShrink: 0,
  },
  dot_all:   { background: C.t3 },
  dot_text:  { background: "var(--info)" },
  dot_image: { background: "var(--success)" },
  dot_code:  { background: "var(--warning)" },
  dot_url:   { background: "var(--accent)" },
  toast: {
    position: "fixed",
    bottom: 56,
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
    pointerEvents: "none",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    whiteSpace: "nowrap",
  },
  toastText: {
    fontSize: 12,
    color: C.t2,
  },
};
