//! Tauri commands for auth state — called from React via invoke().
//! All commands return Result<T, String> to match the existing convention.

use tauri::{AppHandle, Manager, State};

use crate::auth::{
    classify_next_state, transition, wipe_credentials, AuthEvent, AuthState, AuthStateHandle,
};

/// Returns the current AuthState. Used by AuthProvider's initial fetch in React.
#[tauri::command]
#[specta::specta]
pub fn get_auth_state(handle: State<'_, AuthStateHandle>) -> AuthState {
    handle.lock().unwrap().clone()
}

/// sign_in — opens the relay's browser auth page in the system browser.
///
/// Phase 4 flow:
///   1. Transitions to Authenticating{SigningIn}
///   2. Opens {relay_url}/auth/browser in the system browser via tauri_plugin_opener
///   3. Returns immediately — the deep-link callback (cinch://auth/callback) handles
///      credential write + state transition when the browser redirects back.
#[tauri::command]
#[specta::specta]
pub async fn sign_in(
    app: AppHandle,
    handle: State<'_, AuthStateHandle>,
    relay_url: String,
) -> Result<(), String> {
    transition(
        &app,
        &handle,
        classify_next_state(&handle.lock().unwrap().clone(), &AuthEvent::ClickSignIn),
    );

    let relay = relay_url.trim().trim_end_matches('/').to_string();
    if relay.is_empty() {
        transition(&app, &handle, AuthState::LocalOnly);
        return Err("relay_url required".into());
    }

    let browser_url = format!("{}/auth/browser", relay);
    tauri_plugin_opener::open_url(&browser_url, None::<&str>)
        .map_err(|e| format!("failed to open browser: {}", e))?;

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

    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    crate::auth::write_credentials(&user_id, &device_id, &token, &relay_url, &hostname)
        .map_err(|e| format!("persist creds: {}", e))?;

    transition(
        &app,
        &handle,
        AuthState::Authenticated {
            user_id: user_id.clone(),
            device_id: device_id.clone(),
            hostname: hostname.clone(),
            relay_url: relay_url.clone(),
        },
    );

    // PRV-02: sync local retention preference to relay on sign-in
    {
        let relay = relay_url.clone();
        let tok = token.clone();
        let db_clone: std::sync::Arc<crate::store::db::Database> = app
            .state::<std::sync::Arc<crate::store::db::Database>>()
            .inner()
            .clone();
        tauri::async_runtime::spawn(async move {
            // Read the locally configured remote retention days
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

    // Spawn WS client (Pitfall 6: must spawn after deep-link auth)
    let ws_url = format!(
        "wss://{}/ws",
        relay_url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
    );
    let db: tauri::State<'_, std::sync::Arc<crate::store::db::Database>> = app.state();
    let clipboard: tauri::State<'_, std::sync::Arc<crate::clipboard::ClipboardService>> =
        app.state();
    let ws_status: tauri::State<'_, std::sync::Arc<crate::ws::WsStatus>> = app.state();
    let relay_connected: tauri::State<'_, std::sync::Arc<std::sync::atomic::AtomicBool>> =
        app.state();
    crate::ws::spawn_ws_client(
        &app,
        ws_url,
        db.inner().clone(),
        clipboard.inner().clone(),
        ws_status.inner().clone(),
        handle.inner().clone(),
        relay_connected.inner().clone(),
    );

    log::info!(
        "handle_deeplink auth complete: user={}, device={}",
        user_id,
        device_id
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
