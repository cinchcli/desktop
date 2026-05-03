//! Relay connection management.
//! Exactly one relay is active at a time; pair_with_token replaces the existing one.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use crate::auth::{add_relay_profile, load_multi_config, transition, AuthState, AuthStateHandle};
use crate::protocol::MultiConfigHandle;
use crate::ws::{WsAbortHandle, WsStatus};

// ─── PendingAuthRelay ────────────────────────────────────────────────────────

/// Transient marker set by `sign_in` when the desktop opens the browser for a
/// standard auth flow.  The deep-link `else` branch requires this to be present
/// *and* to match the `relay_url` carried in the callback URL — rejects crafted
/// deep-links that arrive without a prior login being initiated.
pub struct PendingAuthRelay(pub std::sync::Mutex<Option<String>>);

impl PendingAuthRelay {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap().take()
    }
    pub fn set(&self, relay_url: String) {
        *self.0.lock().unwrap() = Some(relay_url);
    }
}

// ─── PendingRelayAdd ─────────────────────────────────────────────────────────

/// Transient marker set by the browser-OAuth flow so `handle_deeplink` knows to
/// replace the relay profile instead of just refreshing the active one.
pub struct PendingRelayAdd(pub std::sync::Mutex<Option<PendingRelayInfo>>);

pub struct PendingRelayInfo {
    #[allow(dead_code)]
    pub relay_url: String,
    pub label: Option<String>,
}

impl PendingRelayAdd {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
    pub fn take(&self) -> Option<PendingRelayInfo> {
        self.0.lock().unwrap().take()
    }
    #[allow(dead_code)]
    pub fn set(&self, info: PendingRelayInfo) {
        *self.0.lock().unwrap() = Some(info);
    }
}

// ─── pair_with_token ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct PairWithTokenRequest {
    pub relay_url: String,
    pub pair_token: String,
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct PairWithTokenResult {
    pub relay_id: String,
    pub user_id: String,
    pub device_id: String,
}

/// Pair with a relay using a master token obtained from `cinch auth login`.
/// Clears any existing relay and replaces it with the new one.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn pair_with_token(
    app: AppHandle,
    mc: State<'_, MultiConfigHandle>,
    ws_abort: State<'_, Arc<WsAbortHandle>>,
    ws_status: State<'_, Arc<WsStatus>>,
    auth_handle: State<'_, AuthStateHandle>,
    relay_connected: State<'_, Arc<std::sync::atomic::AtomicBool>>,
    db: State<'_, Arc<crate::store::db::Database>>,
    clipboard: State<'_, Arc<crate::clipboard::ClipboardService>>,
    req: PairWithTokenRequest,
) -> Result<PairWithTokenResult, String> {
    let relay = req.relay_url.trim().trim_end_matches('/').to_string();
    if relay.is_empty() {
        return Err("relay_url required".into());
    }
    if req.pair_token.trim().is_empty() {
        return Err("pair_token required".into());
    }

    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());

    let (priv_b64, pub_b64) = crate::crypto::generate_ephemeral_keypair();

    let fingerprint = {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let raw = URL_SAFE_NO_PAD
            .decode(&pub_b64)
            .map_err(|e| format!("decode pub key: {}", e))?;
        let digest = Sha256::digest(&raw);
        digest[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let body = serde_json::json!({
        "pair_token": req.pair_token.trim(),
        "hostname": hostname,
        "device_public_key": pub_b64,
        "device_key_fingerprint": fingerprint,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/auth/pair", relay))
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED
        || resp.status() == reqwest::StatusCode::BAD_REQUEST
    {
        return Err(
            "Pair token invalid or expired. Ask for a new one: cinch auth regenerate-pair-token"
                .into(),
        );
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("pairing failed ({}): {}", status, body_text));
    }

    #[derive(Deserialize)]
    struct PairResp {
        token: String,
        user_id: String,
        device_id: String,
    }
    let pair_resp: PairResp = resp
        .json()
        .await
        .map_err(|e| format!("parse response: {}", e))?;

    // Clear existing relay profiles — single-relay invariant.
    {
        let mut guard = mc.lock().unwrap();
        guard.relays.clear();
        guard.active_relay_id = None;
        guard.save().map_err(|e| format!("clear relays: {}", e))?;
    }

    let relay_id = add_relay_profile(
        &pair_resp.user_id,
        &pair_resp.device_id,
        &pair_resp.token,
        &relay,
        &hostname,
        req.label.as_deref(),
        &priv_b64,
    )
    .map_err(|e| format!("store credentials: {}", e))?;

    // Reload in-memory MultiConfig
    let new_mc = load_multi_config().map_err(|e| format!("load: {}", e))?;
    {
        let mut guard = mc.lock().unwrap();
        *guard = new_mc;
    }

    // Transition auth state and spawn WebSocket
    let (ws_url, next_state) = {
        let guard = mc.lock().unwrap();
        let profile = guard
            .active_profile()
            .ok_or("no active relay after pairing")?;
        let token = if profile.token.is_empty() {
            crate::auth::read_credentials(&profile.to_config()).unwrap_or_default()
        } else {
            profile.token.clone()
        };
        let base = profile
            .relay_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!("{}/ws?token={}", base, token);
        let next_state = AuthState::Authenticated {
            user_id: profile.user_id.clone(),
            device_id: profile.device_id.clone(),
            hostname: profile.hostname.clone(),
            relay_url: profile.relay_url.clone(),
            active_relay_id: profile.id.clone(),
        };
        (ws_url, next_state)
    };

    transition(&app, &auth_handle, next_state);

    let handle = crate::ws::spawn_ws_client(
        &app,
        ws_url,
        db.inner().clone(),
        clipboard.inner().clone(),
        ws_status.inner().clone(),
        auth_handle.inner().clone(),
        relay_connected.inner().clone(),
    );
    ws_abort.replace(handle);

    Ok(PairWithTokenResult {
        relay_id,
        user_id: pair_resp.user_id,
        device_id: pair_resp.device_id,
    })
}
