use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::clipboard::ClipboardService;
use crate::protocol::{ConfigInfo, DeviceInfo, MultiConfigHandle};
use crate::store::db::{Database, SourceAlertSetting, SourceInfo, SourceSetting};
use crate::store::models::LocalClip;
use crate::ws::WsStatus;

/// Settings-pane retention config (plan 01-06).
///
/// `local_days` = rolling window for the local SQLite cache.
/// `remote_days` = rolling window for relay-stored clips.
/// Default is 30 days per D-05; clamp range is `[7, 365]` per V5.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RetentionConfig {
    pub local_days: i64,
    pub remote_days: i64,
}

const DEFAULT_RETENTION_DAYS: i64 = 30;
const MIN_RETENTION_DAYS: i64 = 7;
const MAX_RETENTION_DAYS: i64 = 365;

/// Best-effort sync of remote_retention_days to the relay.
/// Fails silently -- the relay will fall back to DEFAULT 30 if unreachable.
async fn sync_retention_to_relay(remote_days: i64) {
    let cfg = match crate::protocol::Config::load() {
        Ok(c) => c,
        Err(_) => return,
    };
    let token = match crate::auth::read_credentials(&cfg) {
        Ok(t) => t,
        Err(_) => return, // not authenticated -- skip silently
    };
    if token.is_empty() {
        return;
    }

    let url = format!(
        "{}/devices/self/retention",
        cfg.relay_url.trim_end_matches('/')
    );
    let body = serde_json::json!({ "remote_retention_days": remote_days });

    let client = reqwest::Client::new();
    let _ = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    // Fire-and-forget: don't block the settings save
}

// --- Retention inner helpers (testable without tauri State wrapper) ---

/// Testable inner: read both retention values, defaulting missing / unparseable
/// entries to [`DEFAULT_RETENTION_DAYS`] (D-05).
fn get_retention_config_inner(db: &Database) -> Result<RetentionConfig, String> {
    let local_days = db
        .get_setting("local_retention_days")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    let remote_days = db
        .get_setting("remote_retention_days")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS);
    Ok(RetentionConfig {
        local_days,
        remote_days,
    })
}

/// Testable inner: validate inputs fall in `[MIN_RETENTION_DAYS, MAX_RETENTION_DAYS]`
/// (V5 input-validation gate, T-06-01) then persist both via
/// `Database::set_setting`. Out-of-range input is rejected BEFORE any write,
/// so an invalid call cannot mutate state.
fn set_retention_config_inner(
    db: &Database,
    local_days: i64,
    remote_days: i64,
) -> Result<(), String> {
    if !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&local_days)
        || !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&remote_days)
    {
        return Err(format!(
            "retention out of range [{}, {}]: local={}, remote={}",
            MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, local_days, remote_days,
        ));
    }
    db.set_setting("local_retention_days", &local_days.to_string())?;
    db.set_setting("remote_retention_days", &remote_days.to_string())?;
    Ok(())
}

// --- Retention tauri commands (plan 01-06) ---

#[tauri::command]
#[specta::specta]
pub fn get_retention_config(db: State<'_, Arc<Database>>) -> Result<RetentionConfig, String> {
    get_retention_config_inner(&db)
}

#[tauri::command]
#[specta::specta]
pub async fn set_retention_config(
    db: State<'_, Arc<Database>>,
    local_days: i64,
    remote_days: i64,
) -> Result<(), String> {
    set_retention_config_inner(&db, local_days, remote_days)?;
    // PRV-02: best-effort relay sync -- don't fail the local save if relay is unreachable
    let rd = remote_days;
    tauri::async_runtime::spawn(async move {
        sync_retention_to_relay(rd).await;
    });
    Ok(())
}

/// Return the number of clips that would be deleted if `local_retention_days`
/// were set to `days` right now. Backs the Settings-pane retroactive-purge
/// confirmation dialog. Uses `Database::count_clips_before`.
///
/// `days` is clamped to `[MIN_RETENTION_DAYS, MAX_RETENTION_DAYS]` (T-06-02):
/// `365 * 86_400 = 31_536_000` stays well within `i64`, so no overflow is
/// possible within bounds.
#[tauri::command]
#[specta::specta]
pub fn preview_retention_change(db: State<'_, Arc<Database>>, days: i64) -> Result<i64, String> {
    if !(MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&days) {
        return Err(format!(
            "preview days out of range [{}, {}]: {}",
            MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, days,
        ));
    }
    let cutoff = chrono::Utc::now().timestamp() - days * 86_400;
    db.count_clips_before(cutoff)
}

/// Wipe every clip row + cascade-delete media files. Returns the number of
/// rows deleted. Used by the "Clear local history" Settings button (PRV-03).
#[tauri::command]
#[specta::specta]
pub fn clear_local_history(db: State<'_, Arc<Database>>) -> Result<i64, String> {
    db.clear_all_clips()
}

#[tauri::command]
#[specta::specta]
pub fn list_pinned_clips(db: State<'_, Arc<Database>>) -> Result<Vec<LocalClip>, String> {
    db.list_pinned_clips()
}

#[tauri::command]
#[specta::specta]
pub async fn pin_clip(
    db: State<'_, Arc<Database>>,
    mc: State<'_, MultiConfigHandle>,
    id: String,
    note: Option<String>,
) -> Result<(), String> {
    db.pin_clip(&id, note.as_deref())?;
    if let Ok((relay_url, token)) = resolve_active_creds(&mc) {
        match client_core::http::RestClient::new(relay_url, token) {
            Ok(client) => {
                if let Err(e) = client.set_clip_pin(&id, true, note.as_deref()).await {
                    log::warn!("relay set_clip_pin failed for {}: {}", id, e);
                }
            }
            Err(e) => {
                log::warn!("could not build REST client for pin_clip {}: {}", id, e);
            }
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn unpin_clip(
    db: State<'_, Arc<Database>>,
    mc: State<'_, MultiConfigHandle>,
    id: String,
) -> Result<(), String> {
    db.unpin_clip(&id)?;
    if let Ok((relay_url, token)) = resolve_active_creds(&mc) {
        match client_core::http::RestClient::new(relay_url, token) {
            Ok(client) => {
                if let Err(e) = client.set_clip_pin(&id, false, None).await {
                    log::warn!("relay unpin_clip failed for {}: {}", id, e);
                }
            }
            Err(e) => {
                log::warn!("could not build REST client for unpin_clip {}: {}", id, e);
            }
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn list_clips(
    db: State<'_, Arc<Database>>,
    source: Option<String>,
    content_type: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<LocalClip>, String> {
    db.list_clips(
        source.as_deref(),
        content_type.as_deref(),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
#[specta::specta]
pub fn search_clips(
    db: State<'_, Arc<Database>>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<LocalClip>, String> {
    db.search_clips(&query, limit.unwrap_or(50))
}

#[tauri::command]
#[specta::specta]
pub fn get_sources(db: State<'_, Arc<Database>>) -> Result<Vec<SourceInfo>, String> {
    db.get_sources()
}

#[tauri::command]
#[specta::specta]
pub async fn delete_clip(
    db: State<'_, Arc<Database>>,
    mc: State<'_, MultiConfigHandle>,
    id: String,
) -> Result<(), String> {
    // Best-effort relay deletion: propagate to other devices via clip_deleted broadcast.
    // If the relay is unreachable or returns an error, log and continue — the relay's
    // TTL will eventually expire the clip. The originating device will also receive
    // the clip_deleted WS broadcast back; ws.rs handles that with a no-op local delete.
    if let Ok((relay_url, token)) = resolve_active_creds(&mc) {
        match client_core::http::RestClient::new(relay_url, token) {
            Ok(client) => {
                if let Err(e) = client.delete_clip(&id).await {
                    log::warn!("relay delete_clip failed for {}: {}", id, e);
                }
            }
            Err(e) => {
                log::warn!("could not build REST client for delete_clip {}: {}", id, e);
            }
        }
    }
    db.delete_clip(&id)
}

#[tauri::command]
#[specta::specta]
pub fn get_clip_count(db: State<'_, Arc<Database>>) -> Result<i64, String> {
    db.clip_count()
}

#[tauri::command]
#[specta::specta]
pub fn get_config_info(mc: State<'_, MultiConfigHandle>) -> ConfigInfo {
    let guard = mc.lock().unwrap();
    let cfg = guard.to_active_config();
    ConfigInfo {
        relay_url: cfg.relay_url.clone(),
        user_id: cfg.user_id.clone(),
        hostname: cfg.hostname.clone(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_source_auto_copy(db: State<'_, Arc<Database>>, source: String) -> Result<bool, String> {
    db.is_source_auto_copy(&source)
}

#[tauri::command]
#[specta::specta]
pub fn set_source_auto_copy(
    db: State<'_, Arc<Database>>,
    source: String,
    enabled: bool,
) -> Result<(), String> {
    db.set_source_auto_copy(&source, enabled)
}

#[tauri::command]
#[specta::specta]
pub fn get_all_source_settings(db: State<'_, Arc<Database>>) -> Result<Vec<SourceSetting>, String> {
    db.get_all_source_settings()
}

#[tauri::command]
#[specta::specta]
pub fn get_source_alert_enabled(
    db: State<'_, Arc<Database>>,
    source: String,
) -> Result<bool, String> {
    db.is_source_alert_enabled(&source)
}

#[tauri::command]
#[specta::specta]
pub fn set_source_alert_enabled(
    db: State<'_, Arc<Database>>,
    source: String,
    enabled: bool,
) -> Result<(), String> {
    db.set_source_alert_enabled(&source, enabled)
}

#[tauri::command]
#[specta::specta]
pub fn get_all_source_alert_settings(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<SourceAlertSetting>, String> {
    db.get_all_source_alert_settings()
}

#[tauri::command]
#[specta::specta]
pub fn mark_clip_copied(db: State<'_, Arc<Database>>, id: String) -> Result<(), String> {
    db.mark_clip_copied(&id, chrono::Utc::now().timestamp())
}

#[tauri::command]
#[specta::specta]
pub fn copy_clip_to_clipboard(
    clipboard: State<'_, Arc<ClipboardService>>,
    content: String,
) -> Result<(), String> {
    clipboard.write_text(&content).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn copy_image_to_clipboard(
    clipboard: State<'_, Arc<ClipboardService>>,
    media_path: String,
) -> Result<(), String> {
    let safe_path = crate::sanitize_media_path(&media_path)
        .map_err(|e| format!("invalid media_path: {}", e))?;
    let base_dir = dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".local/share"))
        .join("com.cinch.app");
    let full_path = base_dir.join(safe_path);
    if !full_path.exists() {
        return Err(format!("media file not found: {}", media_path));
    }
    clipboard
        .write_image_from_png_file(&full_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_excluded_apps(
    db: State<'_, Arc<Database>>,
    clipboard: State<'_, Arc<ClipboardService>>,
) -> Result<Vec<String>, String> {
    match db.get_setting("excluded_apps")? {
        Some(json) => {
            serde_json::from_str(&json).map_err(|e| format!("parse excluded_apps: {}", e))
        }
        None => Ok(clipboard.default_excluded_apps()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_excluded_apps(db: State<'_, Arc<Database>>, apps: Vec<String>) -> Result<(), String> {
    let json =
        serde_json::to_string(&apps).map_err(|e| format!("serialize excluded_apps: {}", e))?;
    db.set_setting("excluded_apps", &json)
}

#[tauri::command]
#[specta::specta]
pub fn save_config(app: tauri::AppHandle, relay_url: String, token: String) -> Result<(), String> {
    if relay_url.trim().is_empty() || token.trim().is_empty() {
        return Err("relay_url and token are required".to_string());
    }
    let relay_url = relay_url.trim().trim_end_matches('/').to_string();
    let hostname = client_core::machine::hostname_or_unknown();

    // This command is invoked from the React SetupScreen, which does NOT know
    // user_id or device_id (those come from the relay during /auth/login). Phase 4's
    // cinch:// deep-link flow will pass them explicitly. For Phase 2, we continue to
    // accept a bare token from SetupScreen and store it under a placeholder account
    // key — the `sign_in` tauri command (Plan 03 Task 2) is the forward-looking path.
    //
    // Backward-compat: write to keyring under account "<user_id>:<device_id>" if we
    // already have those in the existing config; else fall through to plaintext.
    let existing = crate::protocol::Config::load().unwrap_or_default();
    let user_id = if existing.user_id.is_empty() {
        "unknown-user".to_string()
    } else {
        existing.user_id
    };
    let device_id = if existing.active_device_id.is_empty() {
        "unknown-device".to_string()
    } else {
        existing.active_device_id
    };

    crate::auth::credential::write_credentials(
        &user_id,
        &device_id,
        token.trim(),
        &relay_url,
        &hostname,
    )
    .map_err(|e| format!("write_credentials: {}", e))?;

    log::info!("save_config succeeded");

    // Keep app.restart() for Phase 2 — SetupScreen full reload is the existing UX.
    // Phase 3 (T1-02) will remove the restart as part of the LocalOnly-first-class rework.
    app.restart();
}

fn resolve_active_creds(mc: &State<'_, MultiConfigHandle>) -> Result<(String, String), String> {
    let guard = mc.lock().unwrap();
    let profile = guard.active_profile().ok_or("no active relay configured")?;
    let token = if profile.token.is_empty() {
        let cfg = profile.to_config();
        crate::auth::read_credentials(&cfg).map_err(|_| "not authenticated".to_string())?
    } else {
        profile.token.clone()
    };
    if token.is_empty() {
        return Err("not authenticated".to_string());
    }
    Ok((profile.relay_url.clone(), token))
}

#[tauri::command]
#[specta::specta]
pub async fn list_devices(mc: State<'_, MultiConfigHandle>) -> Result<Vec<DeviceInfo>, String> {
    let (relay_url, token) = resolve_active_creds(&mc)?;
    let url = format!("{}/devices", relay_url);
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("relay returned {}", response.status()));
    }

    let devices: Vec<DeviceInfo> = response
        .json()
        .await
        .map_err(|e| format!("parse failed: {}", e))?;

    Ok(devices)
}

// --- Device management commands (plan 05-03) ---

#[tauri::command]
#[specta::specta]
pub async fn set_device_nickname(
    mc: State<'_, MultiConfigHandle>,
    device_id: String,
    nickname: String,
) -> Result<(), String> {
    let (relay_url, token) = resolve_active_creds(&mc)?;
    let url = format!("{}/devices/{}/nickname", relay_url, device_id);
    let client = reqwest::Client::new();
    let response = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "nickname": nickname }))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("relay returned {}: {}", status, body));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn revoke_device(
    mc: State<'_, MultiConfigHandle>,
    device_id: String,
) -> Result<(), String> {
    let (relay_url, token) = resolve_active_creds(&mc)?;
    let url = format!("{}/auth/device/revoke", relay_url);
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "device_id": device_id }))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("relay returned {}: {}", status, body));
    }
    Ok(())
}

// --- Global shortcut persistence (plan 03-04, D-08) ---

const DEFAULT_GLOBAL_SHORTCUT: &str = "CmdOrCtrl+Shift+V";

/// Modifier key names recognized by Tauri's global-shortcut plugin.
const MODIFIER_NAMES: &[&str] = &[
    "cmd",
    "ctrl",
    "alt",
    "shift",
    "super",
    "meta",
    "commandorcontrol",
    "cmdorctrl",
];

/// Testable inner: read persisted global shortcut or return the default.
fn get_global_shortcut_inner(db: &Database) -> Result<String, String> {
    Ok(db
        .get_setting("global_shortcut")?
        .unwrap_or_else(|| DEFAULT_GLOBAL_SHORTCUT.to_string()))
}

/// Testable inner: validate and persist a global shortcut string (T-03-06).
///
/// Validation rules:
/// 1. Must contain at least one modifier key (Cmd, Ctrl, Alt, Shift, etc.)
/// 2. Must contain at least one regular (non-modifier) key
fn set_global_shortcut_inner(db: &Database, shortcut: &str) -> Result<(), String> {
    let parts: Vec<&str> = shortcut.split('+').collect();
    let has_modifier = parts
        .iter()
        .any(|p| MODIFIER_NAMES.contains(&p.to_lowercase().as_str()));
    if !has_modifier {
        return Err(
            "Shortcut must include at least one modifier key (Cmd, Ctrl, Alt, Shift)".to_string(),
        );
    }
    let has_regular_key = parts
        .iter()
        .any(|p| !MODIFIER_NAMES.contains(&p.to_lowercase().as_str()));
    if !has_regular_key {
        return Err("Shortcut must include a regular key (e.g., V, C, Space)".to_string());
    }
    db.set_setting("global_shortcut", shortcut)
}

#[tauri::command]
#[specta::specta]
pub fn get_global_shortcut(db: State<'_, Arc<Database>>) -> Result<String, String> {
    get_global_shortcut_inner(&db)
}

#[tauri::command]
#[specta::specta]
pub fn set_global_shortcut(db: State<'_, Arc<Database>>, shortcut: String) -> Result<(), String> {
    set_global_shortcut_inner(&db, &shortcut)
}

#[tauri::command]
#[specta::specta]
pub fn get_ws_status(ws_status: State<'_, Arc<WsStatus>>) -> String {
    ws_status.get()
}

/// Restore focus to the app that was frontmost before Cinch was shown, then hide the
/// Cinch window. On non-macOS platforms this simply hides the window.
#[tauri::command]
#[specta::specta]
pub fn focus_previous_app(
    app: tauri::AppHandle,
    previous_pid: State<'_, crate::PreviousAppPid>,
) -> Result<(), String> {
    use tauri::Manager;
    #[cfg(target_os = "macos")]
    {
        let pid_opt = *previous_pid.lock().map_err(|e| e.to_string())?;
        if let Some(pid) = pid_opt {
            crate::activate_app_by_pid(pid);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::db::Database;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_db() -> Database {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp: PathBuf =
            std::env::temp_dir().join(format!("cinch-cmd-test-{}-{}.db", std::process::id(), n));
        let _ = std::fs::remove_file(&tmp);
        Database::open(&tmp).unwrap()
    }

    #[test]
    fn retention_roundtrip() {
        let db = test_db();
        set_retention_config_inner(&db, 14, 60).unwrap();
        let cfg = get_retention_config_inner(&db).unwrap();
        assert_eq!(cfg.local_days, 14);
        assert_eq!(cfg.remote_days, 60);
    }

    #[test]
    fn retention_defaults_to_30_when_missing() {
        let db = test_db();
        let cfg = get_retention_config_inner(&db).unwrap();
        assert_eq!(cfg.local_days, DEFAULT_RETENTION_DAYS);
        assert_eq!(cfg.remote_days, DEFAULT_RETENTION_DAYS);
    }

    #[test]
    fn retention_out_of_range_low() {
        let db = test_db();
        assert!(set_retention_config_inner(&db, 3, 30).is_err());
        // Invalid write must not persist — missing keys fall through to defaults.
        let cfg = get_retention_config_inner(&db).unwrap();
        assert_eq!(
            cfg.local_days, DEFAULT_RETENTION_DAYS,
            "invalid write must not persist"
        );
    }

    #[test]
    fn retention_out_of_range_high() {
        let db = test_db();
        assert!(set_retention_config_inner(&db, 30, 1000).is_err());
    }

    #[test]
    fn retention_accepts_boundary_values() {
        let db = test_db();
        assert!(set_retention_config_inner(&db, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS).is_ok());
        let cfg = get_retention_config_inner(&db).unwrap();
        assert_eq!(cfg.local_days, MIN_RETENTION_DAYS);
        assert_eq!(cfg.remote_days, MAX_RETENTION_DAYS);
    }

    // --- Global shortcut tests (plan 03-04) ---

    #[test]
    fn global_shortcut_defaults_when_missing() {
        let db = test_db();
        let s = get_global_shortcut_inner(&db).unwrap();
        assert_eq!(s, DEFAULT_GLOBAL_SHORTCUT);
    }

    #[test]
    fn global_shortcut_roundtrip() {
        let db = test_db();
        set_global_shortcut_inner(&db, "CmdOrCtrl+Shift+B").unwrap();
        let s = get_global_shortcut_inner(&db).unwrap();
        assert_eq!(s, "CmdOrCtrl+Shift+B");
    }

    #[test]
    fn global_shortcut_rejects_no_modifier() {
        let db = test_db();
        let err = set_global_shortcut_inner(&db, "V").unwrap_err();
        assert!(
            err.contains("modifier"),
            "error should mention modifier: {}",
            err
        );
    }

    #[test]
    fn global_shortcut_rejects_modifier_only() {
        let db = test_db();
        let err = set_global_shortcut_inner(&db, "Cmd+Shift").unwrap_err();
        assert!(
            err.contains("regular key"),
            "error should mention regular key: {}",
            err
        );
    }

    #[test]
    fn global_shortcut_accepts_alt_combo() {
        let db = test_db();
        assert!(set_global_shortcut_inner(&db, "Alt+Space").is_ok());
        assert_eq!(get_global_shortcut_inner(&db).unwrap(), "Alt+Space");
    }
}
