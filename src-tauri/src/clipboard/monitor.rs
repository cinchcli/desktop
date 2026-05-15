//! Clipboard polling loop. Drives `ClipboardService`, applies dedup and the
//! excluded-app filter, then hands captured clips to `client_core::sync::LocalPusher`
//! which encrypts, pushes to the relay, and write-throughs to the shared store.

use log::{error, info, warn};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::time::{self, Duration};

use super::backend::{PollContent, PollSnapshot};
use super::service::ClipboardService;
use crate::store::db::Database;
use crate::LocalPusherHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const DEDUP_WINDOW_SECS: i64 = 5;
const MAX_RECENT_HASHES: usize = 20;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Pure filter applied in `run_monitor_loop` — returns `false` if the
/// snapshot should be dropped before DB insert.
///
/// Drops when:
/// - content is `Unsupported` (concealed/transient UTI detected upstream in
///   `MacBackend::read_snapshot`) — this is where PRV-01 enforcement lands.
/// - content is `Empty` (nothing to store).
/// - `app_identity` matches any entry in `excluded_apps` (password-manager
///   bundle IDs from `MacBackend::default_excluded_apps`).
///
/// Runs BEFORE self-write dedup (there is no point hashing a clip we'll drop).
pub(crate) fn should_accept_snapshot(snapshot: &PollSnapshot, excluded_apps: &[String]) -> bool {
    if matches!(
        snapshot.content,
        PollContent::Unsupported | PollContent::Empty
    ) {
        return false;
    }
    if let Some(ref bid) = snapshot.app_identity {
        if excluded_apps.iter().any(|e| e == bid) {
            return false;
        }
    }
    true
}

struct RecentHash {
    hash: [u8; 32],
    timestamp: i64,
}

pub fn spawn_clipboard_monitor(
    app: &AppHandle,
    db: Arc<Database>,
    service: Arc<ClipboardService>,
    pusher_handle: LocalPusherHandle,
) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        info!("clipboard monitor started");
        run_monitor_loop(&app_handle, &db, &service, &pusher_handle).await;
    });
}

async fn run_monitor_loop(
    app: &AppHandle,
    db: &Arc<Database>,
    service: &Arc<ClipboardService>,
    pusher_handle: &LocalPusherHandle,
) {
    let mut last_token: Option<u64> = service.token();
    let mut recent_hashes: VecDeque<RecentHash> = VecDeque::new();
    let mut interval = time::interval(POLL_INTERVAL);

    let excluded_apps = load_excluded_apps(db, service);
    let source = format!("remote:{}", client_core::machine::hostname_or_unknown());

    loop {
        interval.tick().await;

        let snapshot = match service.poll_snapshot() {
            Ok(s) => s,
            Err(e) => {
                error!("poll_snapshot failed: {}", e);
                continue;
            }
        };

        // Token fast-path: on platforms with a real change token, skip when
        // nothing has changed. Platforms without a token (Linux) fall through
        // to snapshot-content comparison via the dedup layer.
        if let (Some(cur), Some(last)) = (snapshot.token, last_token) {
            if cur == last {
                continue;
            }
        }
        last_token = snapshot.token;

        // Privacy + excluded-app filter (pure, unit-tested). Runs BEFORE
        // self-write dedup (D-13 ordering) — there is no point hashing a
        // clip we'll drop, and PRV-01 requires that concealed/transient
        // clips never reach later stages. Log excluded-app drops so the
        // operator still sees the signal in the event log.
        if !should_accept_snapshot(&snapshot, &excluded_apps) {
            if let Some(ref bid) = snapshot.app_identity {
                if excluded_apps.iter().any(|e| e == bid) {
                    info!("clipboard change from excluded app: {}", bid);
                }
            }
            continue;
        }

        if service.is_self_write(&snapshot) {
            continue;
        }

        let now = chrono::Utc::now().timestamp();

        match snapshot.content {
            PollContent::Text(text) if !text.is_empty() => {
                handle_text_clip(text, app, pusher_handle, &mut recent_hashes, now, &source);
            }
            PollContent::ImagePng(bytes) => {
                if bytes.len() <= MAX_IMAGE_BYTES {
                    // TODO: image push needs cinch://media URI scheme +
                    // local media-cache write to keep UI rendering working.
                    // Tracked separately; for now log and drop so we don't
                    // store ciphertext orphaned from any cache file.
                    warn!(
                        "clipboard: image clip ({} bytes) detected but not yet pushed — \
                         image ingest path is pending follow-up",
                        bytes.len()
                    );
                } else {
                    info!("skipping oversized image: {} bytes", bytes.len());
                }
            }
            _ => {}
        }
    }
}

fn handle_text_clip(
    text: String,
    app: &AppHandle,
    pusher_handle: &LocalPusherHandle,
    recent_hashes: &mut VecDeque<RecentHash>,
    now: i64,
    source: &str,
) {
    let hash = compute_hash(text.as_bytes());

    while recent_hashes
        .front()
        .is_some_and(|h| now - h.timestamp > DEDUP_WINDOW_SECS)
    {
        recent_hashes.pop_front();
    }
    if recent_hashes.iter().any(|h| h.hash == hash) {
        return;
    }
    recent_hashes.push_back(RecentHash {
        hash,
        timestamp: now,
    });
    if recent_hashes.len() > MAX_RECENT_HASHES {
        recent_hashes.pop_front();
    }

    // Snapshot the pusher (cheap clone — Arcs inside) so the polling loop
    // never holds the Mutex across an await.
    let pusher = {
        let guard = match pusher_handle.lock() {
            Ok(g) => g,
            Err(e) => {
                error!("clipboard: pusher mutex poisoned: {}", e);
                return;
            }
        };
        match &*guard {
            Some(p) => p.clone(),
            None => {
                warn!(
                    "clipboard: dropped {}-byte text clip — not configured \
                     (run `cinch auth login` to enable sync)",
                    text.len()
                );
                return;
            }
        }
    };

    let raw = text.into_bytes();
    let byte_size = raw.len() as i64;
    let source = source.to_string();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        match pusher.push_text(raw, &source, "").await {
            Ok(clip_id) => {
                info!(
                    "clipboard: pushed text clip {} ({} bytes)",
                    clip_id, byte_size
                );
                let payload = clip_received_stub(&clip_id, &source, byte_size);
                let _ = crate::events::ClipReceived(payload).emit(&app);
            }
            Err(e) => {
                warn!("clipboard: text clip ingest failed: {}", e);
            }
        }
    });
}

/// Build a minimal `LocalClip` payload for the `ClipReceived` event. The React
/// listener uses this only as a refresh trigger (it re-fetches via `list_clips`
/// in the handler), so we do not need to round-trip every field.
fn clip_received_stub(
    clip_id: &str,
    source: &str,
    byte_size: i64,
) -> crate::commands::clips::LocalClip {
    let now_secs = chrono::Utc::now().timestamp();
    crate::commands::clips::LocalClip {
        id: clip_id.to_string(),
        user_id: String::new(),
        content: String::new(),
        content_type: "text/plain".to_string(),
        source: source.to_string(),
        label: String::new(),
        byte_size,
        media_path: None,
        created_at: now_secs,
        synced: true,
        is_pinned: false,
        pin_note: None,
        received_at: now_secs,
    }
}

fn load_excluded_apps(db: &Database, service: &ClipboardService) -> Vec<String> {
    match db.get_setting("excluded_apps") {
        Ok(Some(json)) => {
            serde_json::from_str(&json).unwrap_or_else(|_| service.default_excluded_apps())
        }
        _ => {
            let defaults = service.default_excluded_apps();
            let json = serde_json::to_string(&defaults).unwrap();
            db.set_setting("excluded_apps", &json).ok();
            defaults
        }
    }
}

fn compute_hash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hash_deterministic() {
        let h1 = compute_hash(b"hello world");
        let h2 = compute_hash(b"hello world");
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_compute_hash_different_content() {
        let h1 = compute_hash(b"hello");
        let h2 = compute_hash(b"world");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_dedup_window_logic() {
        let hash = compute_hash(b"test content");
        let now = chrono::Utc::now().timestamp();
        let mut recent: VecDeque<RecentHash> = VecDeque::new();
        recent.push_back(RecentHash {
            hash,
            timestamp: now,
        });
        assert!(recent.iter().any(|h| h.hash == hash));
        let other_hash = compute_hash(b"different content");
        assert!(!recent.iter().any(|h| h.hash == other_hash));
    }

    #[test]
    fn test_dedup_window_expiry() {
        let hash = compute_hash(b"test");
        let now = chrono::Utc::now().timestamp();
        let mut recent: VecDeque<RecentHash> = VecDeque::new();
        recent.push_back(RecentHash {
            hash,
            timestamp: now - 10,
        });
        while recent
            .front()
            .is_some_and(|h| now - h.timestamp > DEDUP_WINDOW_SECS)
        {
            recent.pop_front();
        }
        assert!(recent.is_empty());
    }

    // --- Wave 0 tests for `should_accept_snapshot` filter (plan 01-04) ---

    #[test]
    fn should_accept_snapshot_drops_concealed() {
        let snap = PollSnapshot {
            token: Some(1),
            content: PollContent::Unsupported,
            app_identity: None,
        };
        assert!(
            !should_accept_snapshot(&snap, &[]),
            "Unsupported content (concealed/transient UTI) must be dropped"
        );
    }

    #[test]
    fn should_accept_snapshot_drops_empty() {
        let snap = PollSnapshot {
            token: Some(1),
            content: PollContent::Empty,
            app_identity: Some("com.apple.TextEdit".into()),
        };
        assert!(
            !should_accept_snapshot(&snap, &[]),
            "Empty content must be dropped"
        );
    }

    #[test]
    fn should_accept_snapshot_drops_excluded_app() {
        let snap = PollSnapshot {
            token: Some(1),
            content: PollContent::Text("secret".into()),
            app_identity: Some("com.1password.1password".into()),
        };
        assert!(
            !should_accept_snapshot(&snap, &["com.1password.1password".into()]),
            "Clip from excluded bundle ID must be dropped"
        );
    }

    #[test]
    fn should_accept_snapshot_accepts_normal_text() {
        let snap = PollSnapshot {
            token: Some(1),
            content: PollContent::Text("hello".into()),
            app_identity: Some("com.apple.TextEdit".into()),
        };
        assert!(
            should_accept_snapshot(&snap, &["com.1password.1password".into()]),
            "Normal clip from non-excluded app must be accepted"
        );
    }

    #[test]
    fn should_accept_snapshot_accepts_image() {
        let snap = PollSnapshot {
            token: Some(1),
            content: PollContent::ImagePng(vec![0x89, 0x50, 0x4E, 0x47]),
            app_identity: None,
        };
        assert!(
            should_accept_snapshot(&snap, &[]),
            "ImagePng with no excluded app_identity must be accepted"
        );
    }
}
