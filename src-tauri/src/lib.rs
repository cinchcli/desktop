pub mod auth;
mod clipboard;
mod commands;
pub mod crypto;
pub mod events;
pub mod protocol;
mod store;
mod tray;
mod ws;

#[cfg(test)]
mod tests;

use log::info;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder, Event};

use auth::{AuthState, AuthStateHandle};
use protocol::MultiConfigHandle;

pub fn make_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::clips::list_clips,
            commands::clips::list_pinned_clips,
            commands::clips::pin_clip,
            commands::clips::unpin_clip,
            commands::clips::search_clips,
            commands::clips::get_sources,
            commands::clips::delete_clip,
            commands::clips::get_clip_count,
            commands::clips::get_config_info,
            commands::clips::get_source_auto_copy,
            commands::clips::set_source_auto_copy,
            commands::clips::get_all_source_settings,
            commands::clips::copy_clip_to_clipboard,
            commands::clips::copy_image_to_clipboard,
            commands::clips::list_devices,
            commands::clips::set_device_nickname,
            commands::clips::revoke_device,
            commands::clips::get_excluded_apps,
            commands::clips::set_excluded_apps,
            commands::clips::get_retention_config,
            commands::clips::set_retention_config,
            commands::clips::preview_retention_change,
            commands::clips::clear_local_history,
            commands::clips::save_config,
            commands::clips::get_ws_status,
            commands::clips::get_global_shortcut,
            commands::clips::set_global_shortcut,
            commands::auth::get_auth_state,
            commands::auth::sign_in,
            commands::auth::sign_out,
            commands::auth::retry_auth,
            commands::auth::handle_deeplink,
            commands::auth::pair_via_ssh,
            commands::relays::pair_with_token,
        ])
        .events(collect_events![
            events::AuthStateChanged,
            events::WsStatus,
            events::ClipReceived,
            events::ClipDeleted,
            events::NewSourceDetected,
            events::ImageDownloadFailed,
            events::ImageDownloadComplete,
            events::AuthAdoptedFromCli,
            events::CliHandoffRequested,
            events::SshPairMarkerFound,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Load MultiConfig from ~/.cinch/config.json (migrates legacy single-Config format)
    let multi_config = protocol::MultiConfig::load();
    let config = multi_config.to_active_config();
    if let Some(p) = multi_config.active_profile() {
        info!("config loaded: relay={}, user={}", p.relay_url, p.user_id);
    } else {
        info!("config not found, starting in setup mode");
    }
    let is_configured = config.is_configured();
    let active_relay_id_seed = multi_config.active_relay_id.clone().unwrap_or_default();

    // Open local database
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".local/share"))
        .join("com.cinch.app")
        .join("clips.db");

    let db = match store::db::Database::open(&db_path) {
        Ok(db) => Arc::new(db),
        Err(e) => {
            eprintln!("ERROR: failed to open database: {}", e);
            std::process::exit(1);
        }
    };

    let ws_url = config.ws_url();
    let relay_url_for_backfill = config.relay_url.clone();
    let token_for_backfill = config.token.clone();
    let config_for_auth_seed = config.clone();

    let multi_config_handle: MultiConfigHandle = Arc::new(Mutex::new(multi_config));
    let ws_abort_handle = Arc::new(ws::WsAbortHandle::new());
    let pending_relay_add = Arc::new(commands::relays::PendingRelayAdd::new());

    // Single clipboard service shared by monitor, ws client, and Tauri commands.
    let clipboard_service = Arc::new(clipboard::ClipboardService::new_platform_default());

    let ws_status = Arc::new(ws::WsStatus::new());

    // Shared relay connectivity flag for offline queue logic
    let relay_connected = Arc::new(AtomicBool::new(false));

    // AuthStateHandle — canonical shared AuthState (CONTEXT.md D-12/D-13).
    // Created here so the FS watcher (spawn_credential_watcher) has a handle to funnel
    // `transition()` calls through. Plan 03 Task 1 will extend the initial state setup.
    let auth_state_handle: AuthStateHandle = Arc::new(Mutex::new(AuthState::default()));

    let specta_builder = make_specta_builder();

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export TypeScript bindings");

    tauri::Builder::default()
        .register_uri_scheme_protocol("cinch", {
            move |_app, request| {
                let uri = request.uri().to_string();
                // Parse cinch://media/{clip_id}
                let path = uri
                    .strip_prefix("cinch://media/")
                    .or_else(|| uri.strip_prefix("cinch://media\\"))
                    .unwrap_or("");

                if path.is_empty() {
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap();
                }

                let media_dir = dirs::data_dir()
                    .unwrap_or_else(|| dirs::home_dir().unwrap().join(".local/share"))
                    .join("com.cinch.app")
                    .join("media");

                // Try to find the file (clip_id might or might not have extension)
                let mut file_path = media_dir.join(format!("{}.png", path));
                if !file_path.exists() {
                    file_path = media_dir.join(path);
                }

                match std::fs::read(&file_path) {
                    Ok(data) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/png")
                        .body(data)
                        .unwrap(),
                    Err(_) => tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap(),
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(tray::TrayState::new()))
        .manage(db.clone())
        .manage(multi_config_handle.clone())
        .manage(ws_abort_handle.clone())
        .manage(pending_relay_add.clone())
        .manage(clipboard_service.clone())
        .manage(ws_status.clone())
        .manage(relay_connected.clone())
        .manage(auth_state_handle.clone())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            let handle = app.handle();

            // Setup system tray
            tray::setup_tray(handle)?;

            // Register global shortcuts (⌘⇧V main window focus)
            register_global_shortcuts(handle);

            // Seed AuthState from persisted config. Plan 03 Task 2.
            {
                let auth_handle: AuthStateHandle = app.state::<AuthStateHandle>().inner().clone();
                let initial_state = if config_for_auth_seed.is_configured()
                    && !config_for_auth_seed.active_device_id.is_empty()
                {
                    AuthState::Authenticated {
                        user_id: config_for_auth_seed.user_id.clone(),
                        device_id: config_for_auth_seed.active_device_id.clone(),
                        hostname: config_for_auth_seed.hostname.clone(),
                        relay_url: config_for_auth_seed.relay_url.clone(),
                        active_relay_id: active_relay_id_seed.clone(),
                    }
                } else {
                    AuthState::LocalOnly
                };
                auth::transition(handle, &auth_handle, initial_state);
            }

            // Deep-link handler: cinch://auth/callback?token=X&device_id=Y&user_id=Z&relay_url=R
            // Handles the "hot app" case where the browser redirects while app is running.
            // The "cold start" case (app launched via URL) is handled by React calling
            // handle_deeplink via getCurrent().
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                let dl_auth_handle = auth_state_handle.clone();
                let dl_db = db.clone();
                let dl_app_handle = app.handle().clone();
                let dl_clipboard = clipboard_service.clone();
                let dl_ws_status = ws_status.clone();
                let dl_relay_connected = relay_connected.clone();
                let dl_mc = multi_config_handle.clone();
                let dl_ws_abort = ws_abort_handle.clone();
                let dl_pending = pending_relay_add.clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    for url in &urls {
                        // CLI handoff route: `cinch://login?relay=…&from=cli`.
                        // Focus the main window and emit an event so the React
                        // layer opens the AddRelayDialog with the relay
                        // pre-filled. No credential write here — the user
                        // still has to complete OAuth in the dialog.
                        let is_login = url.host_str() == Some("login")
                            || url.path() == "/login"
                            || (url.scheme() == "cinch" && url.path() == "/login");
                        if is_login {
                            if let Some(window) = dl_app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let relay = url
                                .query_pairs()
                                .find(|(k, _)| k == "relay")
                                .map(|(_, v)| v.to_string())
                                .unwrap_or_default();
                            if let Err(e) = (crate::events::CliHandoffRequested {
                                relay_url: relay,
                            })
                            .emit(&dl_app_handle)
                            {
                                log::warn!("emit CliHandoffRequested failed: {}", e);
                            }
                            continue;
                        }

                        let is_auth =
                            url.host_str() == Some("auth") || url.path() == "/auth/callback";
                        if !is_auth {
                            continue;
                        }

                        let token = url
                            .query_pairs()
                            .find(|(k, _)| k == "token")
                            .map(|(_, v)| v.to_string());
                        let device_id = url
                            .query_pairs()
                            .find(|(k, _)| k == "device_id")
                            .map(|(_, v)| v.to_string());
                        let user_id = url
                            .query_pairs()
                            .find(|(k, _)| k == "user_id")
                            .map(|(_, v)| v.to_string());
                        let relay_url = url
                            .query_pairs()
                            .find(|(k, _)| k == "relay_url")
                            .map(|(_, v)| v.to_string());

                        if let (Some(token), Some(device_id), Some(user_id)) =
                            (token, device_id, user_id)
                        {
                            if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
                                log::warn!("deep-link: rejected malformed token");
                                return;
                            }

                            let relay =
                                relay_url.unwrap_or_else(|| "https://api.cinchcli.com".to_string());

                            if let Err(e) = crate::validate_relay_url(&relay) {
                                log::warn!("deep-link: rejected invalid relay_url: {}", e);
                                return;
                            }

                            let hostname = std::env::var("HOSTNAME")
                                .or_else(|_| std::env::var("COMPUTERNAME"))
                                .unwrap_or_else(|_| "unknown".to_string());

                            let pending_info = dl_pending.take();
                            let active_relay_id = if let Some(info) = pending_info {
                                match crate::auth::add_relay_profile(
                                    &user_id,
                                    &device_id,
                                    &token,
                                    &relay,
                                    &hostname,
                                    info.label.as_deref(),
                                    "",
                                ) {
                                    Ok(relay_id) => {
                                        if let Ok(new_mc) = crate::auth::load_multi_config() {
                                            let mut g = dl_mc.lock().unwrap();
                                            *g = new_mc;
                                        }
                                        relay_id
                                    }
                                    Err(e) => {
                                        log::error!("deep-link add_relay_profile failed: {}", e);
                                        return;
                                    }
                                }
                            } else {
                                if let Err(e) = client_core::auth_session::install_credentials(
                                    client_core::auth_session::InstallParams {
                                        user_id: &user_id,
                                        device_id: &device_id,
                                        token: &token,
                                        relay_url: &relay,
                                        hostname: &hostname,
                                        device_private_key: None,
                                    },
                                ) {
                                    log::error!("deep-link install_credentials failed: {}", e);
                                    return;
                                }
                                let relay_id = crate::auth::load_multi_config()
                                    .ok()
                                    .and_then(|mc| {
                                        let id = mc.active_relay_id.clone();
                                        let mut g = dl_mc.lock().unwrap();
                                        *g = mc;
                                        id
                                    })
                                    .unwrap_or_default();
                                relay_id
                            };

                            crate::auth::transition(
                                &dl_app_handle,
                                &dl_auth_handle,
                                crate::auth::AuthState::Authenticated {
                                    user_id: user_id.clone(),
                                    device_id: device_id.clone(),
                                    hostname: hostname.clone(),
                                    relay_url: relay.clone(),
                                    active_relay_id: active_relay_id.clone(),
                                },
                            );

                            let ws_url = crate::protocol::ws_url_from_relay(&relay, &token);
                            let join_handle = ws::spawn_ws_client(
                                &dl_app_handle,
                                ws_url,
                                dl_db.clone(),
                                dl_clipboard.clone(),
                                dl_ws_status.clone(),
                                dl_auth_handle.clone(),
                                dl_relay_connected.clone(),
                            );
                            dl_ws_abort.replace(join_handle);

                            log::info!(
                                "deep-link auth complete: user={}, device={}, relay_id={}",
                                user_id,
                                device_id,
                                active_relay_id,
                            );
                        }
                    }
                });
            }

            if is_configured {
                // Show dashboard on launch
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                // Backfill clips from relay on first launch
                let db_backfill = db.clone();
                tauri::async_runtime::spawn(async move {
                    backfill_from_relay(&db_backfill, &relay_url_for_backfill, &token_for_backfill)
                        .await;
                });

                // Spawn WebSocket client
                let ws_auth_handle: AuthStateHandle =
                    app.state::<AuthStateHandle>().inner().clone();
                let join = ws::spawn_ws_client(
                    handle,
                    ws_url.clone(),
                    db.clone(),
                    clipboard_service.clone(),
                    ws_status.clone(),
                    ws_auth_handle,
                    relay_connected.clone(),
                );
                ws_abort_handle.replace(join);
            } else {
                // No config — show window immediately with setup instructions
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    crate::events::WsStatus("unconfigured".into()).emit(&h).ok();
                });
            }

            // Spawn TTL cleanup task (every 60s) — always needed
            let db_cleanup = db.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    if let Err(e) = db_cleanup.cleanup_expired() {
                        log::error!("TTL cleanup error: {}", e);
                    }
                }
            });

            // Spawn local clipboard monitor — always runs (relay-independent)
            clipboard::monitor::spawn_clipboard_monitor(
                handle,
                db.clone(),
                clipboard_service.clone(),
                relay_connected.clone(),
            );

            // Spawn local retention sweep — purges clips older than the
            // local_retention_days setting (default 30) every hour. D-06.
            spawn_retention_sweep(db.clone());

            // Spawn the FS watcher for cross-process credential propagation (AUTH-03).
            // Best-effort — if the watcher fails to start, the app still runs but without
            // cross-process propagation (desktop would require restart to see CLI changes).
            if let Err(e) =
                auth::spawn_credential_watcher(handle.clone(), auth_state_handle.clone())
            {
                log::warn!("credential watcher failed to start: {}", e);
            }

            info!("Cinch desktop app started (configured={})", is_configured);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Spawn the local retention sweep — purges clips older than the
/// configured `local_retention_days` setting (default 30 per D-05).
///
/// Cadence: hourly (D-06). Uses `MissedTickBehavior::Skip` so a laptop
/// that slept for 45 days does not trigger 45 back-to-back sweeps —
/// the next aligned tick suffices.
///
/// First tick fires immediately (tokio's documented behavior) — this
/// catches stale clips that accumulated while the app was quit longer
/// than the retention window. Intentional per RESEARCH.md Open Question 1.
fn spawn_retention_sweep(db: Arc<store::db::Database>) {
    tauri::async_runtime::spawn(async move {
        const DEFAULT_RETENTION_DAYS: i64 = 30;
        const SWEEP_INTERVAL_SECS: u64 = 60 * 60;

        let mut interval =
            tokio::time::interval(tokio::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        log::info!(
            "retention sweep started (interval = {}s, default = {}d)",
            SWEEP_INTERVAL_SECS,
            DEFAULT_RETENTION_DAYS,
        );

        loop {
            interval.tick().await; // first tick fires immediately — intentional
            let days = match db.get_setting("local_retention_days") {
                Ok(Some(v)) => v.parse::<i64>().unwrap_or(DEFAULT_RETENTION_DAYS),
                _ => DEFAULT_RETENTION_DAYS,
            };
            let cutoff = chrono::Utc::now().timestamp() - days * 86_400;
            match db.purge_before(cutoff) {
                Ok(n) if n > 0 => {
                    log::info!("retention sweep deleted {} clips older than {}d", n, days,)
                }
                Ok(_) => {}
                Err(e) => log::error!("retention sweep failed: {}", e),
            }
        }
    });
}

fn register_global_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Read persisted shortcut preference, fall back to default (D-08)
    let shortcut_str = app
        .state::<Arc<store::db::Database>>()
        .get_setting("global_shortcut")
        .ok()
        .flatten()
        .unwrap_or_else(|| "CmdOrCtrl+Shift+W".to_string());

    let handle = app.clone();
    if let Err(e) =
        app.global_shortcut()
            .on_shortcut(shortcut_str.as_str(), move |_app, shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    info!("global shortcut pressed: {}", shortcut);
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
    {
        log::warn!(
            "failed to register {} shortcut: {} (may conflict with another app)",
            shortcut_str,
            e
        );
    }
}

/// Validate that a relay URL uses http(s) and has a non-empty host.
/// Prevents deep-link injection where relay_url points to attacker infrastructure.
pub(crate) fn validate_relay_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("invalid relay URL: {}", url))?;
    match parsed.scheme() {
        "https" | "http" => {}
        s => return Err(format!("relay URL scheme must be http(s), got: {}", s)),
    }
    if parsed.host().is_none() {
        return Err("relay URL must have a host".into());
    }
    Ok(())
}

/// Sanitize a relay-provided media_path to prevent path traversal.
/// Allows "media/filename.png" but rejects "../../../etc/passwd" and absolute paths.
pub(crate) fn sanitize_media_path(media_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(media_path);
    if path.is_absolute() {
        return Err("media_path must be relative".into());
    }
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("media_path contains path traversal".into());
        }
    }
    Ok(path.to_path_buf())
}

async fn backfill_from_relay(db: &Arc<store::db::Database>, relay_url: &str, token: &str) {
    info!("backfilling clips from relay...");

    let client = reqwest::Client::new();
    let url = format!("{}/clips", relay_url);

    let response = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::error!("backfill request failed: {}", e);
            return;
        }
    };

    if !response.status().is_success() {
        log::error!("backfill failed: HTTP {}", response.status());
        return;
    }

    let clips: Vec<protocol::Clip> = match response.json().await {
        Ok(c) => c,
        Err(e) => {
            log::error!("backfill parse failed: {}", e);
            return;
        }
    };

    let count = clips.len();
    for clip in &clips {
        let local = store::models::LocalClip::from_proto(clip);
        if let Err(e) = db.insert_clip(&local) {
            log::error!("backfill insert failed: {}", e);
        }
    }

    info!("backfilled {} clips from relay", count);
}
