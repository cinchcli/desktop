//! Tauri commands for auth state — called from React via invoke().
//! All commands return Result<T, String> to match the existing convention.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::auth::{
    add_relay_profile, load_multi_config, transition, wipe_credentials, AuthState, AuthStateHandle,
};
use crate::commands::relays::PendingRelayAdd;
use crate::protocol::MultiConfigHandle;
use crate::ws::{WsAbortHandle, WsStatus};

/// Returns the current AuthState. Used by AuthProvider's initial fetch in React.
#[tauri::command]
#[specta::specta]
pub fn get_auth_state(handle: State<'_, AuthStateHandle>) -> AuthState {
    handle.lock().unwrap().clone()
}

/// sign_in — browser-based sign-in using device-code polling.
///
/// Flow (deep-link-independent):
///   1. Transitions to Authenticating{SigningIn}
///   2. POSTs to {relay_url}/auth/device-code to get a device_code + verification_uri
///   3. Opens verification_uri in the system browser (includes device_code so OAuth
///      providers show the right page and the relay can complete the flow)
///   4. Returns immediately — a background tokio task polls
///      GET {relay_url}/auth/device-code/poll?code={device_code} every 3 seconds
///   5. When status == "complete", writes credentials and transitions to Authenticated
///
/// The existing cinch://auth/callback deep-link handler in lib.rs still fires as a
/// secondary path (legacy self-host servers that skip the device-code completion step).
#[tauri::command]
#[specta::specta]
pub fn sign_in(
    app: AppHandle,
    handle: State<'_, AuthStateHandle>,
    relay_url: String,
    provider: Option<String>,
) -> Result<(), String> {
    let auth_handle = handle.inner().clone();
    let relay = relay_url.trim().trim_end_matches('/').to_string();
    if relay.is_empty() {
        return Err("relay_url required".into());
    }

    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let app2 = app.clone();
    let handle2 = auth_handle.clone();
    let relay2 = relay;
    let provider2 = provider;
    let hostname2 = hostname.clone();
    let mc: MultiConfigHandle = app.state::<MultiConfigHandle>().inner().clone();
    let db = app
        .state::<Arc<crate::store::db::Database>>()
        .inner()
        .clone();
    let clipboard = app
        .state::<Arc<crate::clipboard::ClipboardService>>()
        .inner()
        .clone();
    let ws_status = app.state::<Arc<WsStatus>>().inner().clone();
    let relay_connected = app
        .state::<Arc<std::sync::atomic::AtomicBool>>()
        .inner()
        .clone();
    let ws_abort = app.state::<Arc<WsAbortHandle>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        // Step 1: Issue a device code so the browser auth page can complete the flow.
        let client = reqwest::Client::new();
        let machine_id = client_core::machine::stable_machine_id();
        let mut dc_body = serde_json::json!({"hostname": hostname2});
        if !machine_id.is_empty() {
            dc_body["machine_id"] = serde_json::Value::String(machine_id.clone());
        }
        let dc_resp = match client
            .post(format!("{}/auth/device-code", relay2))
            .json(&dc_body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                log::error!("sign_in: device-code request failed: {}", e);
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }
        };

        if !dc_resp.status().is_success() {
            log::error!(
                "sign_in: device-code request failed with HTTP {}",
                dc_resp.status()
            );
            transition(&app2, &handle2, AuthState::LocalOnly);
            return;
        }

        let dc: serde_json::Value = match dc_resp.json().await {
            Ok(dc) => dc,
            Err(e) => {
                log::error!("sign_in: device-code parse failed: {}", e);
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }
        };

        let device_code = match dc["device_code"].as_str() {
            Some(code) if !code.is_empty() => code.to_string(),
            _ => {
                log::error!("sign_in: missing device_code in response");
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }
        };
        let user_code = dc["user_code"].as_str().unwrap_or("").to_string();
        let verification_uri = match dc["verification_uri"].as_str() {
            Some(uri) if !uri.is_empty() => uri.to_string(),
            _ => {
                log::error!("sign_in: missing verification_uri in response");
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }
        };

        // Step 2: Open the browser — directly at the provider's OAuth start URL if
        // a provider was specified, otherwise at the relay's provider-selection page.
        let browser_url = if let Some(p) = &provider2 {
            format!(
                "{}/auth/oauth/{}/start?device_code={}",
                relay2, p, user_code
            )
        } else {
            verification_uri
        };
        if let Err(e) = tauri_plugin_opener::open_url(&browser_url, None::<&str>) {
            log::error!("sign_in: failed to open browser: {}", e);
            transition(&app2, &handle2, AuthState::LocalOnly);
            return;
        }

        // Step 3: Poll until the user completes OAuth. Tight cadence early
        // (1s) so OAuth completion is caught quickly; back off to 3s after
        // 20s if the user is taking their time in the browser.
        let poll_url = format!("{}/auth/device-code/poll?code={}", relay2, device_code);
        let started = tokio::time::Instant::now();
        let deadline = started + std::time::Duration::from_secs(5 * 60);
        let fast_window = std::time::Duration::from_secs(20);

        loop {
            let interval = if started.elapsed() < fast_window {
                std::time::Duration::from_secs(1)
            } else {
                std::time::Duration::from_secs(3)
            };
            tokio::time::sleep(interval).await;

            if tokio::time::Instant::now() > deadline {
                log::warn!("sign_in: device-code poll timed out");
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }

            let resp = match client
                .get(&poll_url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("sign_in: poll error: {}", e);
                    continue;
                }
            };

            // 410 Gone means the code expired server-side.
            if resp.status() == reqwest::StatusCode::GONE {
                log::warn!("sign_in: device code expired");
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }

            let data: serde_json::Value = match resp.json().await {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("sign_in: poll parse error: {}", e);
                    continue;
                }
            };

            if data["status"].as_str() != Some("complete") {
                continue;
            }

            let token = data["token"].as_str().unwrap_or("").to_string();
            let user_id = data["user_id"].as_str().unwrap_or("").to_string();
            let device_id = data["device_id"].as_str().unwrap_or("").to_string();

            if token.is_empty() || user_id.is_empty() || device_id.is_empty() {
                log::warn!("sign_in: poll returned incomplete credentials");
                continue;
            }

            log::info!(
                "sign_in: poll complete — token_prefix={}, token_len={}, user_id={}, device_id={}",
                &token.chars().take(8).collect::<String>(),
                token.len(),
                user_id,
                device_id,
            );

            // Write credentials atomically: token + AES key + X25519 device
            // key + config in one transaction with a single credential_version
            // bump. The CLI watcher (and our own propagate.rs) only see a
            // fully-formed credential set on the bump.
            if let Err(e) = client_core::auth_session::install_credentials(
                client_core::auth_session::InstallParams {
                    user_id: &user_id,
                    device_id: &device_id,
                    token: &token,
                    relay_url: &relay2,
                    hostname: &hostname2,
                    device_private_key: None,
                },
            ) {
                log::error!("sign_in: install_credentials failed: {}", e);
                transition(&app2, &handle2, AuthState::LocalOnly);
                return;
            }

            // Reload MultiConfig to get the active relay_id.
            let active_relay_id = match crate::auth::load_multi_config() {
                Ok(new_mc) => {
                    let id = new_mc.active_relay_id.clone().unwrap_or_default();
                    *mc.lock().unwrap() = new_mc;
                    id
                }
                Err(e) => {
                    log::error!("sign_in: load_multi_config failed: {}", e);
                    String::new()
                }
            };

            transition(
                &app2,
                &handle2,
                AuthState::Authenticated {
                    user_id: user_id.clone(),
                    device_id: device_id.clone(),
                    hostname: hostname2.clone(),
                    relay_url: relay2.clone(),
                    active_relay_id: active_relay_id.clone(),
                },
            );

            let ws_url = crate::protocol::ws_url_from_relay(&relay2, &token);
            let jh = crate::ws::spawn_ws_client(
                &app2,
                ws_url,
                db,
                clipboard,
                ws_status,
                handle2,
                relay_connected,
            );
            ws_abort.replace(jh);

            log::info!(
                "sign_in: complete via polling: user={}, device={}, relay_id={}",
                user_id,
                device_id,
                active_relay_id,
            );
            return;
        }
    });

    Ok(())
}

/// handle_deeplink — Tauri command for React to invoke when it receives a deep-link URL
/// via getCurrent() (cold-start case) or onOpenUrl (fallback for JS-side handling).
///
/// Parses the URL, extracts auth params, writes credentials, transitions state,
/// and spawns WS client.
#[tauri::command]
#[specta::specta]
pub async fn handle_deeplink(
    url: String,
    app: AppHandle,
    handle: State<'_, AuthStateHandle>,
    pending: State<'_, Arc<PendingRelayAdd>>,
    mc: State<'_, MultiConfigHandle>,
    ws_abort: State<'_, Arc<WsAbortHandle>>,
) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid URL: {}", e))?;

    // T-04-10: Validate this is an auth callback URL
    let is_auth = parsed.host_str() == Some("auth") || parsed.path() == "/auth/callback";
    if !is_auth {
        return Err("not an auth callback URL".into());
    }

    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.to_string())
        .ok_or("missing token param")?;
    let device_id = parsed
        .query_pairs()
        .find(|(k, _)| k == "device_id")
        .map(|(_, v)| v.to_string())
        .ok_or("missing device_id param")?;
    let user_id = parsed
        .query_pairs()
        .find(|(k, _)| k == "user_id")
        .map(|(_, v)| v.to_string())
        .ok_or("missing user_id param")?;
    let relay_url = parsed
        .query_pairs()
        .find(|(k, _)| k == "relay_url")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| "https://api.cinchcli.com".to_string());

    // T-04-09: validate token format (hex, 64 chars)
    if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid token format".into());
    }

    // Validate relay_url scheme and host (prevents deep-link relay hijack)
    crate::validate_relay_url(&relay_url).map_err(|e| format!("invalid relay_url: {}", e))?;

    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    // Check if this is an "add new relay" flow or "update active relay" flow
    let pending_info = pending.take();
    let active_relay_id = if let Some(info) = pending_info {
        // Add new relay profile
        let relay_id = add_relay_profile(
            &user_id,
            &device_id,
            &token,
            &relay_url,
            &hostname,
            info.label.as_deref(),
            "",
        )
        .map_err(|e| format!("persist creds: {}", e))?;

        // Reload in-memory MultiConfig
        let new_mc = load_multi_config().map_err(|e| format!("load multi_config: {}", e))?;
        {
            let mut guard = mc.lock().unwrap();
            *guard = new_mc;
        }
        relay_id
    } else {
        // Update active relay credentials atomically (original sign-in flow).
        client_core::auth_session::install_credentials(
            client_core::auth_session::InstallParams {
                user_id: &user_id,
                device_id: &device_id,
                token: &token,
                relay_url: &relay_url,
                hostname: &hostname,
                device_private_key: None,
            },
        )
        .map_err(|e| format!("persist creds: {}", e))?;

        // Reload and get the active relay_id
        let new_mc = load_multi_config().map_err(|e| format!("load multi_config: {}", e))?;
        let relay_id = new_mc.active_relay_id.clone().unwrap_or_default();
        {
            let mut guard = mc.lock().unwrap();
            *guard = new_mc;
        }
        relay_id
    };

    transition(
        &app,
        &handle,
        AuthState::Authenticated {
            user_id: user_id.clone(),
            device_id: device_id.clone(),
            hostname: hostname.clone(),
            relay_url: relay_url.clone(),
            active_relay_id: active_relay_id.clone(),
        },
    );

    // PRV-02: sync local retention preference to relay on sign-in
    {
        let relay = relay_url.clone();
        let tok = token.clone();
        let db_clone: Arc<crate::store::db::Database> = app
            .state::<Arc<crate::store::db::Database>>()
            .inner()
            .clone();
        tauri::async_runtime::spawn(async move {
            let remote_days = db_clone
                .get_setting("remote_retention_days")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(30);
            let url = format!("{}/devices/self/retention", relay.trim_end_matches('/'));
            let body = serde_json::json!({ "remote_retention_days": remote_days });
            let client = reqwest::Client::new();
            let _ = client
                .put(&url)
                .header("Authorization", format!("Bearer {}", tok))
                .json(&body)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
        });
    }

    // Spawn WS client
    let ws_url = crate::protocol::ws_url_from_relay(&relay_url, &token);
    let db: State<'_, Arc<crate::store::db::Database>> = app.state();
    let clipboard: State<'_, Arc<crate::clipboard::ClipboardService>> = app.state();
    let ws_status: State<'_, Arc<WsStatus>> = app.state();
    let relay_connected: State<'_, Arc<std::sync::atomic::AtomicBool>> = app.state();
    let join_handle = crate::ws::spawn_ws_client(
        &app,
        ws_url,
        db.inner().clone(),
        clipboard.inner().clone(),
        ws_status.inner().clone(),
        handle.inner().clone(),
        relay_connected.inner().clone(),
    );
    ws_abort.replace(join_handle);

    log::info!(
        "handle_deeplink auth complete: user={}, device={}, relay_id={}",
        user_id,
        device_id,
        active_relay_id,
    );
    Ok(())
}

/// sign_out — calls POST /auth/device/revoke (best-effort), wipes credentials, transitions to LocalOnly.
/// Mirrors the CLI `auth logout` D-10 behavior.
#[tauri::command]
#[specta::specta]
pub async fn sign_out(app: AppHandle, handle: State<'_, AuthStateHandle>) -> Result<(), String> {
    let cfg = crate::protocol::Config::load().unwrap_or_default();
    if !cfg.token.is_empty() || !cfg.active_device_id.is_empty() {
        // Best-effort revoke — do not fail sign_out on network errors (D-10).
        let client = reqwest::Client::new();
        let revoke_body = serde_json::json!({ "device_id": cfg.active_device_id });
        let res = client
            .post(format!(
                "{}/auth/device/revoke",
                cfg.relay_url.trim_end_matches('/')
            ))
            .bearer_auth(&cfg.token)
            .json(&revoke_body)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        if let Err(e) = res {
            log::warn!("sign_out: relay revoke failed (ignoring): {}", e);
        }
    }

    wipe_credentials().map_err(|e| format!("wipe: {}", e))?;
    transition(&app, &handle, AuthState::LocalOnly);
    Ok(())
}

/// retry_auth — bypasses ErrorRecoverable.retry_after_ms and re-attempts the last failing operation.
/// For Phase 2 plumbing: resets to LocalOnly and lets the user re-invoke sign_in.
/// Phase 3+ will store the last-attempted operation and retry it in place.
#[tauri::command]
#[specta::specta]
pub async fn retry_auth(app: AppHandle, handle: State<'_, AuthStateHandle>) -> Result<(), String> {
    // Conservative v1: just transition to LocalOnly; React re-renders SetupScreen.
    transition(&app, &handle, AuthState::LocalOnly);
    Ok(())
}
