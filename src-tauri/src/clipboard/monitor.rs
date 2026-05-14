//! Clipboard polling loop. Drives `ClipboardService`, applies dedup,
//! excluded-app filter, and DB persistence.

use log::{error, info};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::time::{self, Duration};

use super::backend::{PollContent, PollSnapshot};
use super::service::ClipboardService;
use crate::store::db::Database;
use crate::store::models::{detect_content_type, LocalClip};

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
    relay_connected: Arc<AtomicBool>,
) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        info!("clipboard monitor started");
        run_monitor_loop(&app_handle, &db, &service, &relay_connected).await;
    });
}

async fn run_monitor_loop(
    app: &AppHandle,
    db: &Arc<Database>,
    service: &Arc<ClipboardService>,
    relay_connected: &Arc<AtomicBool>,
) {
    let mut last_token: Option<u64> = service.token();
    let mut recent_hashes: VecDeque<RecentHash> = VecDeque::new();
    let mut interval = time::interval(POLL_INTERVAL);

    let excluded_apps = load_excluded_apps(db, service);

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

        let synced = relay_connected.load(Ordering::Relaxed);

        match snapshot.content {
            PollContent::Text(text) if !text.is_empty() => {
                handle_text_clip(text, db, app, &mut recent_hashes, now, synced);
            }
            PollContent::ImagePng(bytes) => {
                if bytes.len() <= MAX_IMAGE_BYTES {
                    handle_image_clip(&bytes, db, app, &mut recent_hashes, now, synced);
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
    db: &Arc<Database>,
    app: &AppHandle,
    recent_hashes: &mut VecDeque<RecentHash>,
    now: i64,
    synced: bool,
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

    let clip_id = ulid::Ulid::new().to_string();
    let content_type = detect_content_type(&text, "text");
    let byte_size = text.len() as i64;

    let local_clip = LocalClip {
        id: clip_id,
        user_id: String::new(),
        content: text,
        content_type,
        source: "local".to_string(),
        label: String::new(),
        byte_size,
        media_path: None,
        created_at: now,
        synced,
        is_pinned: false,
        pin_note: None,
        received_at: now,
    };

    if let Err(e) = db.insert_clip(&local_clip) {
        error!("failed to insert local clip: {}", e);
        return;
    }
    if !synced {
        if let Err(e) = db.enforce_offline_cap(500) {
            error!("enforce_offline_cap failed: {}", e);
        }
    }
    crate::events::ClipReceived(
        crate::commands::clips::LocalClip::from_legacy(local_clip.clone()),
    )
    .emit(app)
    .ok();
    info!(
        "captured local clip: {} bytes (synced={})",
        byte_size, synced
    );
}

fn handle_image_clip(
    image_data: &[u8],
    db: &Arc<Database>,
    app: &AppHandle,
    recent_hashes: &mut VecDeque<RecentHash>,
    now: i64,
    synced: bool,
) {
    let hash = compute_hash(image_data);

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

    let clip_id = ulid::Ulid::new().to_string();
    let media_dir = dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".local/share"))
        .join("com.cinch.app")
        .join("media");

    if std::fs::create_dir_all(&media_dir).is_err() {
        error!("failed to create media directory");
        return;
    }

    let filename = format!("{}.png", clip_id);
    let file_path = media_dir.join(&filename);

    let png_data = match image::load_from_memory(image_data) {
        Ok(img) => {
            let mut buf = Vec::new();
            if img
                .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .is_err()
            {
                error!("failed to encode PNG");
                return;
            }
            buf
        }
        Err(_) => image_data.to_vec(),
    };

    if std::fs::write(&file_path, &png_data).is_err() {
        error!("failed to write image file");
        return;
    }

    let byte_size = png_data.len() as i64;
    let media_path = format!("media/{}", filename);

    let local_clip = LocalClip {
        id: clip_id,
        user_id: String::new(),
        content: String::new(),
        content_type: "image".to_string(),
        source: "local".to_string(),
        label: String::new(),
        byte_size,
        media_path: Some(media_path),
        created_at: now,
        synced,
        is_pinned: false,
        pin_note: None,
        received_at: now,
    };

    if let Err(e) = db.insert_clip(&local_clip) {
        error!("failed to insert image clip: {}", e);
        return;
    }
    if !synced {
        if let Err(e) = db.enforce_offline_cap(500) {
            error!("enforce_offline_cap failed: {}", e);
        }
    }
    crate::events::ClipReceived(
        crate::commands::clips::LocalClip::from_legacy(local_clip.clone()),
    )
    .emit(app)
    .ok();
    info!(
        "captured local image clip: {} bytes (synced={})",
        byte_size, synced
    );
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
