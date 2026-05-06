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

pub type PreviousAppPid = Arc<Mutex<Option<i32>>>;

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
            commands::clips::get_source_alert_enabled,
            commands::clips::set_source_alert_enabled,
            commands::clips::get_all_source_alert_settings,
            commands::clips::mark_clip_copied,
            commands::clips::copy_clip_to_clipboard,
            commands::clips::copy_image_to_clipboard,
            commands::clips::focus_previous_app,
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
            commands::auth::list_ssh_hosts,
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
            events::OfflineQueueDropped,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Desktop always uses ~/.cinch/config.json (0600) for credential storage instead of the
    // OS Keychain. ws.rs reads the AES key via auth::read_encryption_key which is config.json-only,
    // so using Keychain at write time causes a read-miss and decryption failure. Opting out here
    // makes both read and write paths consistent without any Keychain prompt.
    if std::env::var("CINCH_KEYRING").is_err() {
        std::env::set_var("CINCH_KEYRING", "none");
    }

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

    let ws_relay_url = config.relay_url.clone();
    let ws_token = config.token.clone();
    let relay_url_for_delta = config.relay_url.clone();
    let token_for_delta = config.token.clone();
    let config_for_auth_seed = config.clone();

    let multi_config_handle: MultiConfigHandle = Arc::new(Mutex::new(multi_config));
    let ws_abort_handle = Arc::new(ws::WsAbortHandle::new());
    let pending_relay_add = Arc::new(commands::relays::PendingRelayAdd::new());
    let pending_auth_relay = Arc::new(commands::relays::PendingAuthRelay::new());
    let previous_app_pid: PreviousAppPid = Arc::new(Mutex::new(None));

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
        .manage(pending_auth_relay.clone())
        .manage(clipboard_service.clone())
        .manage(ws_status.clone())
        .manage(relay_connected.clone())
        .manage(auth_state_handle.clone())
        .manage(previous_app_pid.clone())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            let handle = app.handle();

            // Setup system tray
            tray::setup_tray(handle)?;

            // Register global shortcuts (⌘⇧V main window focus)
            register_global_shortcuts(handle);

            // Make the window movable by external window managers (Rectangle, Moom, etc.).
            // decorations:false sets NSWindowStyleMaskBorderless whose default is isMovable=false,
            // so Rectangle's AX-based "Move to Next Display" silently fails.
            configure_macos_window(handle);

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
                let dl_pending_auth = pending_auth_relay.clone();
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
                            if let Err(e) =
                                (crate::events::CliHandoffRequested { relay_url: relay })
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
                                // Security: require a pending standard-auth relay URL that
                                // matches the callback.  Rejects crafted deep-links that
                                // arrive with no prior login being initiated (Finding 1).
                                // I3: peek first so a junk deep-link cannot consume the
                                // pending state before the legitimate callback arrives.
                                let pending_auth_url = dl_pending_auth.peek();
                                if let Err(reason) = crate::validate_auth_callback(
                                    pending_auth_url.as_deref(),
                                    &relay,
                                ) {
                                    log::warn!("deep-link: {}", reason);
                                    return;
                                }
                                // Validation passed — now consume the pending state.
                                dl_pending_auth.clear();

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

                            let join_handle = ws::spawn_ws_client(
                                &dl_app_handle,
                                relay.clone(),
                                token.clone(),
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
                show_on_active_monitor(handle);

                // Delta-sync clips from relay on startup (fetches only new clips)
                let db_delta = db.clone();
                tauri::async_runtime::spawn(async move {
                    match client_core::http::RestClient::new(relay_url_for_delta, token_for_delta) {
                        Ok(http) => {
                            let http = std::sync::Arc::new(http);
                            match delta_sync(&db_delta, &http).await {
                                Ok(n) => info!("startup delta_sync complete: {} clips", n),
                                Err(e) => log::error!("startup delta_sync failed: {}", e),
                            }
                            // tombstone sync after delta
                            match tombstone_sync(&db_delta, &http).await {
                                Ok(n) => info!("startup tombstone_sync: applied {} deletions", n),
                                Err(e) => log::warn!("startup tombstone_sync failed: {}", e),
                            }
                        }
                        Err(e) => log::error!("startup delta_sync: cannot build client: {}", e),
                    }
                });

                // Spawn WebSocket client
                let ws_auth_handle: AuthStateHandle =
                    app.state::<AuthStateHandle>().inner().clone();
                let join = ws::spawn_ws_client(
                    handle,
                    ws_relay_url.clone(),
                    ws_token.clone(),
                    db.clone(),
                    clipboard_service.clone(),
                    ws_status.clone(),
                    ws_auth_handle,
                    relay_connected.clone(),
                );
                ws_abort_handle.replace(join);
            } else {
                // No config — show window immediately with setup instructions
                show_on_active_monitor(handle);
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    crate::events::WsStatus("unconfigured".into()).emit(&h).ok();
                });
            }

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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
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

/// Show the main window centered on the monitor that currently has the mouse cursor.
/// Falls back to simple show+focus if cursor or monitor data is unavailable.
pub(crate) fn show_on_active_monitor(app: &tauri::AppHandle) {
    // Capture the frontmost app before Cinch steals focus, so we can restore it on copy.
    #[cfg(target_os = "macos")]
    capture_frontmost_app_pid(app);

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let result = (|| -> tauri::Result<()> {
        let cursor = app.cursor_position()?;
        let monitors = app.available_monitors()?;

        let target = monitors.iter().find(|m| {
            let pos = m.position();
            let size = m.size();
            cursor.x >= pos.x as f64
                && cursor.x < pos.x as f64 + size.width as f64
                && cursor.y >= pos.y as f64
                && cursor.y < pos.y as f64 + size.height as f64
        });

        if let Some(monitor) = target {
            let pos = monitor.position();
            let size = monitor.size();
            let win_size = window
                .outer_size()
                .unwrap_or(tauri::PhysicalSize::new(960, 600));
            let x = pos.x + ((size.width as i32 - win_size.width as i32) / 2);
            let y = pos.y + ((size.height as i32 - win_size.height as i32) / 2);
            window.set_position(tauri::PhysicalPosition::new(x, y))?;
        }
        Ok(())
    })();

    if let Err(e) = result {
        log::warn!("show_on_active_monitor: could not reposition window: {}", e);
    }

    let _ = window.show();
    let _ = window.set_focus();
}

/// Configure the NSWindow so that external window managers (Rectangle, Moom, etc.) can
/// move it via the Accessibility API.
///
/// `decorations: false` produces NSWindowStyleMaskBorderless, whose macOS default is
/// `isMovable = false`. Rectangle calls `AXUIElementSetAttributeValue(kAXPositionAttribute)`
/// which silently no-ops when `isMovable` is false. Setting it to true fixes "Move to
/// Next/Previous Display" while leaving mouse drag behavior unchanged.
///
/// NSWindowCollectionBehaviorManaged (bit 2) makes the window appear in Mission Control
/// and participate in Spaces, which some window managers require before they will manage it.
/// Captures the pid of the macOS frontmost application and stores it in PreviousAppPid state.
#[cfg(target_os = "macos")]
fn capture_frontmost_app_pid(app: &tauri::AppHandle) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let pid: i32 = unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let frontmost: *mut Object = msg_send![workspace, frontmostApplication];
        if frontmost.is_null() {
            return;
        }
        msg_send![frontmost, processIdentifier]
    };

    if let Some(state) = app.try_state::<PreviousAppPid>() {
        if let Ok(mut guard) = state.lock() {
            *guard = Some(pid);
        }
    }
}

/// Activates a macOS application by its process identifier.
#[cfg(target_os = "macos")]
pub(crate) fn activate_app_by_pid(pid: i32) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let app: *mut Object =
            msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            return;
        }
        // NSApplicationActivateIgnoringOtherApps = 2
        let _: bool = msg_send![app, activateWithOptions: 2u64];
    }
}

fn configure_macos_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::{Object, YES};
        use objc::{msg_send, sel, sel_impl};

        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(ns_window_ptr) = window.ns_window() else {
            return;
        };
        unsafe {
            let ns_window = ns_window_ptr as *mut Object;
            // Allow AX-based moves (fixes Rectangle "Move to Next/Prev Display")
            let _: () = msg_send![ns_window, setMovable: YES];
            // NSWindowCollectionBehaviorManaged=4, NSWindowCollectionBehaviorParticipatesInCycle=32
            let behavior: u64 = (1 << 2) | (1 << 5);
            let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        }
    }
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
                    show_on_active_monitor(&handle);
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

/// Validate an incoming `cinch://auth/callback` deep-link against the relay URL
/// that was recorded when the user actually initiated a login.
///
/// Returns `Ok(())` only when:
/// - `pending_relay_url` is `Some` (a login was actively in progress), AND
/// - it matches `callback_relay_url` exactly (prevents relay-substitution attacks).
///
/// This is a pure function so it can be unit-tested without a running Tauri app.
pub(crate) fn validate_auth_callback(
    pending_relay_url: Option<&str>,
    callback_relay_url: &str,
) -> Result<(), &'static str> {
    match pending_relay_url {
        None => Err("no pending auth — deep-link rejected (no login was initiated)"),
        Some(pending) => {
            let pending_norm = pending.trim_end_matches('/');
            let callback_norm = callback_relay_url.trim_end_matches('/');
            if pending_norm != callback_norm {
                Err("relay_url mismatch — deep-link rejected (possible relay-substitution attack)")
            } else {
                Ok(())
            }
        }
    }
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

async fn tombstone_sync(
    db: &Arc<store::db::Database>,
    http: &Arc<client_core::http::RestClient>,
) -> Result<usize, String> {
    // Read watermark from settings. Key: "last_tombstone_at" (RFC3339 string).
    let since = db
        .get_setting("last_tombstone_at")
        .ok()
        .flatten()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let tombstones = http
        .list_tombstones(since)
        .await
        .map_err(|e| format!("tombstone_sync: {}", e))?;

    let count = tombstones.len();
    for t in &tombstones {
        if let Err(e) = db.delete_clip(&t.clip_id) {
            log::warn!("tombstone_sync: delete_clip {} failed: {}", t.clip_id, e);
        }
    }

    // Advance watermark to the latest tombstone's deleted_at.
    if let Some(last) = tombstones.last() {
        if let Err(e) = db.set_setting("last_tombstone_at", &last.deleted_at) {
            log::warn!("tombstone_sync: update watermark failed: {}", e);
        }
    }

    log::info!("tombstone_sync: applied {} deletions", count);
    Ok(count)
}

const DELTA_PAGE_SIZE: u32 = 100;
const DELTA_MAX_PAGES: usize = 50; // safety cap: 5000 clips max per sync

async fn delta_sync(
    db: &Arc<store::db::Database>,
    http: &Arc<client_core::http::RestClient>,
) -> Result<usize, String> {
    let mut since = db.max_created_at()?.and_then(|ts| {
        if ts == 0 {
            None
        } else {
            chrono::DateTime::from_timestamp(ts, 0)
        }
    });
    let mut total = 0usize;

    for page in 0..DELTA_MAX_PAGES {
        let clips = http
            .list_clips_since(since, DELTA_PAGE_SIZE)
            .await
            .map_err(|e| format!("delta_sync: {}", e))?;

        let page_len = clips.len();
        if page_len == 0 {
            break;
        }

        let received_at = chrono::Utc::now().timestamp();
        for clip in &clips {
            let local = store::models::LocalClip::from_proto(clip, received_at);
            if let Err(e) = db.insert_clip(&local) {
                log::error!("delta_sync insert failed: {}", e);
            }
        }
        total += page_len;

        if (page_len as u32) < DELTA_PAGE_SIZE {
            break; // last page — no more to fetch
        }

        // Advance watermark for next page.
        let new_since = clips
            .last()
            .and_then(|c| chrono::DateTime::parse_from_rfc3339(&c.created_at).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        // No-progress guard: if watermark didn't change, all clips in this page
        // share the same timestamp and the relay's `created_at > since` filter
        // will return 0 results next page. Break to avoid silent data loss.
        if new_since == since {
            log::warn!(
                "delta_sync: watermark stalled at {:?} after {} clips — \
                 {} clips may share the same timestamp, stopping to avoid data loss",
                since,
                total,
                page_len
            );
            break;
        }

        if page == DELTA_MAX_PAGES - 1 {
            log::warn!(
                "delta_sync: hit max-page cap ({} pages, {} clips)",
                DELTA_MAX_PAGES,
                total
            );
        }

        since = new_since;
    }

    log::info!("delta_sync: fetched {} clips total", total);
    Ok(total)
}
