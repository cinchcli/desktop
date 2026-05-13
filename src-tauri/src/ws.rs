use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde_json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::Mutex;
use tokio::time::{self, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::auth::AuthStateHandle;
use crate::clipboard::backend::PollContent;
use crate::clipboard::ClipboardService;
use crate::auth::state::PendingCodesHandle;
use crate::protocol::{
    WSMessage, ACTION_CLIP_DELETED, ACTION_CLIP_PINNED, ACTION_DEVICE_CODE_PENDING,
    ACTION_KEY_EXCHANGE_REQUESTED, ACTION_NEW_CLIP, ACTION_PING, ACTION_REVOKED,
    ACTION_SEND_CLIPBOARD, ACTION_TOKEN_ROTATED,
};
use crate::store::{db::Database, models::LocalClip};
use crate::tray::{self, TrayState};

pub struct WsStatus(pub std::sync::Arc<std::sync::Mutex<String>>);

impl WsStatus {
    pub fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(
            "connecting".to_string(),
        )))
    }
    pub fn set(&self, s: &str) {
        *self.0.lock().unwrap() = s.to_string();
    }
    pub fn get(&self) -> String {
        self.0.lock().unwrap().clone()
    }
}

/// Holds the abort handle for the active WebSocket task so `set_active_relay`
/// can tear it down before spawning a replacement.
pub struct WsAbortHandle(pub std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

impl WsAbortHandle {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    pub fn replace(&self, handle: tauri::async_runtime::JoinHandle<()>) {
        let mut guard = self.0.lock().unwrap();
        if let Some(old) = guard.take() {
            old.abort();
        }
        *guard = Some(handle);
    }

    #[allow(dead_code)]
    pub fn abort(&self) {
        let mut guard = self.0.lock().unwrap();
        if let Some(h) = guard.take() {
            h.abort();
        }
    }
}

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(300);

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

/// Fetch a short-lived single-use WebSocket ticket from POST /ws/ticket.
/// Returns the hex ticket string on success, or falls back gracefully.
async fn fetch_ws_ticket(relay_url: &str, token: &str) -> Result<String, String> {
    let url = format!("{}/ws/ticket", relay_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build http client: {}", e))?;
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("ticket request: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("ticket endpoint returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
    body["ticket"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "no ticket in response".to_string())
}

pub fn spawn_ws_client(
    app: &AppHandle,
    relay_url: String,
    token: String,
    db: Arc<Database>,
    clipboard: Arc<ClipboardService>,
    ws_status: Arc<WsStatus>,
    auth_handle: AuthStateHandle,
    relay_connected: Arc<AtomicBool>,
    pending_handle: PendingCodesHandle,
) -> tauri::async_runtime::JoinHandle<()> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut backoff = crate::auth::Backoff::new();
        // Persists across reconnects so a burst of decrypt failures only fires
        // one retry_key_bundle per 60-second window regardless of reconnect count.
        let retry_gate: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));
        loop {
            info!("connecting to relay: {}", relay_url);
            ws_status.set("connecting");
            crate::events::WsStatus("connecting".into())
                .emit(&app_handle)
                .ok();
            tray::update_tray_status(&app_handle, "connecting");

            match connect_and_listen(
                &app_handle,
                &relay_url,
                &token,
                &db,
                &clipboard,
                &ws_status,
                &auth_handle,
                &relay_connected,
                &retry_gate,
                &pending_handle,
            )
            .await
            {
                Ok(()) => {
                    info!("connection closed cleanly");
                    backoff.reset();
                }
                Err(e) => {
                    error!("connection error: {}", e);
                }
            }

            relay_connected.store(false, Ordering::Relaxed);
            ws_status.set("disconnected");
            crate::events::WsStatus("disconnected".into())
                .emit(&app_handle)
                .ok();
            tray::update_tray_status(&app_handle, "disconnected");
            let delay = backoff.next();
            info!("reconnecting in {}ms...", delay.as_millis());
            time::sleep(delay).await;
        }
    })
}

async fn connect_and_listen(
    app: &AppHandle,
    relay_url: &str,
    token: &str,
    db: &Arc<Database>,
    clipboard: &Arc<ClipboardService>,
    ws_status: &Arc<WsStatus>,
    auth_handle: &AuthStateHandle,
    relay_connected: &Arc<AtomicBool>,
    retry_gate: &Arc<Mutex<Option<std::time::Instant>>>,
    pending_handle: &PendingCodesHandle,
) -> Result<(), String> {
    let ws_base = relay_url
        .replace("https://", "wss://")
        .replace("http://", "ws://");
    let ticket = fetch_ws_ticket(relay_url, token)
        .await
        .map_err(|e| format!("ws ticket fetch failed: {}", e))?;
    let ws_url_owned = format!("{}/ws?ticket={}", ws_base.trim_end_matches('/'), ticket);
    let ws_url = ws_url_owned.as_str();
    let connect_result = connect_async(ws_url).await;

    let (ws_stream, _) = match connect_result {
        Ok(result) => result,
        Err(e) => {
            // Check for 401 during WebSocket upgrade handshake
            if let tokio_tungstenite::tungstenite::Error::Http(ref resp) = e {
                if resp.status() == 401 {
                    let body = String::from_utf8_lossy(resp.body().as_deref().unwrap_or(b""));
                    error!("WS 401 body: {:?}", body);
                    let reason = if body.contains("device_revoked") {
                        crate::auth::Ws401Reason::DeviceRevoked
                    } else {
                        crate::auth::Ws401Reason::InvalidToken
                    };
                    // Wipe creds on device_revoked (mirror ACTION_REVOKED path)
                    if matches!(reason, crate::auth::Ws401Reason::DeviceRevoked) {
                        if let Err(wipe_err) = crate::auth::wipe_credentials() {
                            log::warn!("wipe_credentials on 401 device_revoked: {}", wipe_err);
                        }
                    }
                    let current = auth_handle.lock().unwrap().clone();
                    let next = crate::auth::classify_next_state(
                        &current,
                        &crate::auth::AuthEvent::Ws401 { reason },
                    );
                    crate::auth::transition(app, auth_handle, next);
                }
            }
            return Err(format!("ws connect failed: {}", e));
        }
    };

    info!("connected to relay");
    relay_connected.store(true, Ordering::Relaxed);
    ws_status.set("connected");
    crate::events::WsStatus("connected".into()).emit(app).ok();
    tray::update_tray_status(app, "connected");

    // Flush offline queue on reconnect
    flush_offline_queue(app, db).await;

    // Delta-sync: pull any clips we missed while disconnected.
    // Reuse the relay_url and token already passed into this function — no
    // disk read needed and avoids a race with concurrent config writes.
    match client_core::http::RestClient::new(relay_url.to_string(), token.to_string()) {
        Ok(http) => {
            let http = std::sync::Arc::new(http);
            match crate::delta_sync(db, &http).await {
                Ok(n) if n > 0 => info!("reconnect delta_sync: {} new clips", n),
                Ok(_) => {}
                Err(e) => warn!("reconnect delta_sync failed: {}", e),
            }
            match crate::tombstone_sync(db, &http).await {
                Ok(n) if n > 0 => info!("reconnect tombstone_sync: applied {} deletions", n),
                Ok(_) => {}
                Err(e) => warn!("reconnect tombstone_sync failed: {}", e),
            }
        }
        Err(e) => warn!("reconnect delta_sync: cannot build client: {}", e),
    }

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(Mutex::new(write));

    // Spawn heartbeat: send pong every 5 minutes
    let write_hb = write.clone();
    let heartbeat = tauri::async_runtime::spawn(async move {
        let mut interval = time::interval(HEARTBEAT_INTERVAL);
        loop {
            interval.tick().await;
            let pong = WSMessage::pong();
            let json = serde_json::to_string(&pong).unwrap();
            let mut w = write_hb.lock().await;
            if w.send(Message::Text(json.into())).await.is_err() {
                break;
            }
            info!("heartbeat pong sent");
        }
    });

    // Read loop
    while let Some(msg_result) = read.next().await {
        let msg = msg_result.map_err(|e| format!("ws read error: {}", e))?;

        match msg {
            Message::Text(text) => {
                handle_text_message(
                    app,
                    &write,
                    &text,
                    db,
                    clipboard,
                    auth_handle,
                    relay_url,
                    token,
                    retry_gate,
                    pending_handle,
                )
                .await;
            }
            Message::Ping(data) => {
                let mut w = write.lock().await;
                w.send(Message::Pong(data)).await.ok();
            }
            Message::Close(_) => {
                info!("relay closed connection");
                break;
            }
            _ => {}
        }
    }

    heartbeat.abort();
    Ok(())
}

/// Fire `POST /auth/key-bundle/retry` at most once per 60-second window.
/// A burst of decrypt failures (e.g., many clips arriving while keys diverge)
/// must not spam the relay.
pub(crate) async fn fire_retry_debounced(
    _app: &AppHandle,
    relay_url: &str,
    token: &str,
    gate: &Arc<Mutex<Option<std::time::Instant>>>,
) {
    let now = std::time::Instant::now();
    {
        let mut last = gate.lock().await;
        if let Some(t) = *last {
            if now.duration_since(t) < std::time::Duration::from_secs(60) {
                return;
            }
        }
        *last = Some(now);
    }
    match client_core::http::RestClient::new(relay_url.to_string(), token.to_string()) {
        Ok(client) => {
            if let Err(e) = client.retry_key_bundle().await {
                warn!("retry_key_bundle failed: {}", e);
            } else {
                info!("retry_key_bundle: re-share request sent to relay");
            }
        }
        Err(e) => warn!("fire_retry_debounced: cannot build http client: {}", e),
    }
}

async fn handle_text_message(
    app: &AppHandle,
    write: &Arc<Mutex<WsSink>>,
    text: &str,
    db: &Arc<Database>,
    clipboard: &Arc<ClipboardService>,
    auth_handle: &AuthStateHandle,
    relay_url: &str,
    token: &str,
    retry_gate: &Arc<Mutex<Option<std::time::Instant>>>,
    pending_handle: &PendingCodesHandle,
) {
    let msg: WSMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            warn!("failed to parse ws message: {}", e);
            return;
        }
    };

    match msg.action.as_str() {
        ACTION_NEW_CLIP => {
            if let Some(mut clip) = msg.clip {
                // Decrypt encrypted clips BEFORE any processing.
                // On failure: emit ClipDecryptFailed and auto-fire retry_key_bundle (debounced).
                // Never insert ciphertext as if it were plaintext content.
                if clip.encrypted {
                    let key = client_core::credstore::read_encryption_key(&clip.user_id);
                    use client_core::ws::{decrypt_clip_content, DecryptOutcome};
                    match decrypt_clip_content(&mut clip, key) {
                        DecryptOutcome::Plaintext | DecryptOutcome::Decoded => {}
                        DecryptOutcome::MissingKey => {
                            error!(
                                "clip {}: no AES key — firing retry_key_bundle",
                                clip.clip_id
                            );
                            crate::events::ClipDecryptFailed {
                                clip_id: clip.clip_id.clone(),
                                reason: "missing_key".into(),
                            }
                            .emit(app)
                            .ok();
                            fire_retry_debounced(app, relay_url, token, retry_gate).await;
                            return;
                        }
                        DecryptOutcome::TagFailed { error: ref e } => {
                            error!(
                                "clip {}: AES-GCM tag failed ({}) — firing retry_key_bundle",
                                clip.clip_id, e
                            );
                            crate::events::ClipDecryptFailed {
                                clip_id: clip.clip_id.clone(),
                                reason: format!("tag_failed: {e}"),
                            }
                            .emit(app)
                            .ok();
                            fire_retry_debounced(app, relay_url, token, retry_gate).await;
                            return;
                        }
                    }
                }

                // Local-source clips are echoes of clips this device pushed to the
                // relay (via the offline queue on reconnect). The monitor already
                // captured and stored them. Merge the relay-assigned ID into the
                // existing local record so relay-driven deletions resolve, then
                // skip auto-copy, notifications, and a duplicate ClipReceived emit.
                if clip.source == "local" {
                    if !clip.content.is_empty() {
                        match db.merge_local_clip_to_relay_id(&clip.clip_id, &clip.content) {
                            Ok(true) => {
                                let local_clip =
                                    LocalClip::from_proto(&clip, chrono::Utc::now().timestamp());
                                crate::events::ClipReceived(local_clip).emit(app).ok();
                                info!("merged relay echo into local clip: {}", clip.clip_id);
                            }
                            Ok(false) => {
                                info!("no local match for relay echo {}; skipping", clip.clip_id);
                            }
                            Err(e) => {
                                error!("merge_local_clip_to_relay_id failed: {}", e);
                            }
                        }
                    } else {
                        info!("skipping relay echo of local image clip: {}", clip.clip_id);
                    }
                    return;
                }

                info!(
                    "received clip: {} from {} ({} bytes)",
                    clip.clip_id, clip.source, clip.byte_size
                );

                // Check if this is a never-before-seen source
                let is_new_source = db.is_source_new(&clip.source).unwrap_or(false);

                // Decide whether to auto-copy to clipboard
                let should_auto_copy = if is_new_source {
                    // Default to true for new sources; user can disable later
                    db.set_source_auto_copy(&clip.source, true).ok();
                    true
                } else {
                    db.is_source_auto_copy(&clip.source).unwrap_or(false)
                };

                if should_auto_copy {
                    let is_image = clip.media_path.is_some()
                        && clip.media_path.as_ref().is_some_and(|p| !p.is_empty());

                    if is_image {
                        // Image clip: spawn async task to fetch and auto-copy
                        let app_clone = app.clone();
                        let db_clone = db.clone();
                        let clip_clone = clip.clone();
                        let clipboard_clone = clipboard.clone();
                        let pre_token = clipboard.token();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = handle_image_auto_copy(
                                &app_clone,
                                &db_clone,
                                &clip_clone,
                                &clipboard_clone,
                                pre_token,
                            )
                            .await
                            {
                                error!("image auto-copy failed: {}", e);
                                crate::events::ImageDownloadFailed(clip_clone.clip_id.clone())
                                    .emit(&app_clone)
                                    .ok();
                            }
                        });
                    } else {
                        // Text clip: synchronous auto-copy
                        if let Err(e) = clipboard.write_text(&clip.content) {
                            error!("write_text failed: {}", e);
                        }
                    }
                }

                // Persist to local DB
                let local_clip = LocalClip::from_proto(&clip, chrono::Utc::now().timestamp());
                if let Err(e) = db.insert_clip(&local_clip) {
                    error!("db insert failed: {}", e);
                }

                // Update tray state + show notification
                if let Some(state) = app.try_state::<StdMutex<TrayState>>() {
                    let mut state = state.lock().unwrap();
                    tray::update_tray_clip(app, &clip);

                    // The relay broadcasts every clip back to all devices including
                    // the sender. "local" clips originate on this device, so
                    // notifying the user about their own clipboard action is noise.
                    let alert_enabled = clip.source != "local"
                        && db.is_source_alert_enabled(&clip.source).unwrap_or(true);
                    if alert_enabled {
                        if is_new_source {
                            // Always notify for a new source
                            tray::show_notification(app, &clip);
                        } else if !should_auto_copy {
                            // Source has auto-copy OFF — always notify so user can act
                            tray::show_notification(app, &clip);
                        } else if state.should_notify(&clip.source) {
                            // Auto-copy ON — use normal throttle
                            tray::show_notification(app, &clip);
                        }
                    }

                    state.add_clip(clip.clone());
                }

                // Emit new source event so frontend can show prompt
                if is_new_source {
                    crate::events::NewSourceDetected(clip.source.clone())
                        .emit(app)
                        .ok();
                }

                // Emit to frontend (send the local clip with detected type)
                crate::events::ClipReceived(local_clip).emit(app).ok();
            }
        }
        ACTION_SEND_CLIPBOARD => {
            if let Some(pull_id) = msg.pull_id {
                info!("pull request: {}", pull_id);

                let response = match clipboard.poll_snapshot() {
                    Ok(snap) => match snap.content {
                        PollContent::Text(text) => WSMessage::clipboard_content(pull_id, text),
                        PollContent::ImagePng(_) => WSMessage::clipboard_error(
                            pull_id,
                            "clipboard contains image (text pull only)".into(),
                        ),
                        PollContent::Empty | PollContent::Unsupported => {
                            WSMessage::clipboard_content(pull_id, String::new())
                        }
                    },
                    Err(e) => WSMessage::clipboard_error(pull_id, e.to_string()),
                };

                let json = serde_json::to_string(&response).unwrap();
                let mut w = write.lock().await;
                if let Err(e) = w.send(Message::Text(json.into())).await {
                    error!("failed to send clipboard response: {}", e);
                }
            }
        }
        ACTION_PING => {
            let pong = WSMessage::pong();
            let json = serde_json::to_string(&pong).unwrap();
            let mut w = write.lock().await;
            w.send(Message::Text(json.into())).await.ok();
        }
        ACTION_CLIP_DELETED => {
            if let Some(clip) = &msg.clip {
                info!("clip deleted: {}", clip.clip_id);
                if let Err(e) = db.delete_clip(&clip.clip_id) {
                    error!("db delete failed: {}", e);
                }
                crate::events::ClipDeleted(clip.clip_id.clone())
                    .emit(app)
                    .ok();
            }
        }
        ACTION_CLIP_PINNED => {
            if let Some(clip) = &msg.clip {
                info!(
                    "clip pin changed: {} is_pinned={}",
                    clip.clip_id, clip.is_pinned
                );
                if clip.is_pinned {
                    if let Err(e) = db.pin_clip(&clip.clip_id, clip.pin_note.as_deref()) {
                        error!("db pin_clip failed: {}", e);
                    }
                } else if let Err(e) = db.unpin_clip(&clip.clip_id) {
                    error!("db unpin_clip failed: {}", e);
                }
                crate::events::ClipPinned {
                    clip_id: clip.clip_id.clone(),
                    is_pinned: clip.is_pinned,
                    pin_note: clip.pin_note.clone(),
                }
                .emit(app)
                .ok();
            }
        }
        ACTION_REVOKED => {
            info!("WS: device revoked (reason={:?})", msg.reason);
            // Wipe local credentials best-effort.
            if let Err(e) = crate::auth::wipe_credentials() {
                log::warn!("wipe_credentials on revoke: {}", e);
            }
            // Transition via classifier — same as 401 device_revoked.
            let current = auth_handle.lock().unwrap().clone();
            let next = crate::auth::classify_next_state(
                &current,
                &crate::auth::AuthEvent::Ws401 {
                    reason: crate::auth::Ws401Reason::DeviceRevoked,
                },
            );
            crate::auth::transition(app, auth_handle, next);
        }
        ACTION_TOKEN_ROTATED => {
            let (Some(token), Some(device_id)) = (msg.token.as_deref(), msg.device_id.as_deref())
            else {
                log::warn!("WS token_rotated: missing token or device_id in payload");
                return;
            };
            let hostname = msg
                .hostname
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(client_core::machine::hostname_or_unknown);

            // Brief transition through Authenticating{RotatingToken}.
            let current = auth_handle.lock().unwrap().clone();
            let next =
                crate::auth::classify_next_state(&current, &crate::auth::AuthEvent::WsTokenRotated);
            crate::auth::transition(app, auth_handle, next);

            // Persist new token.
            let user_id = extract_user_id(&current);
            match crate::auth::rotate_credentials(&user_id, device_id, token, &hostname) {
                Ok(()) => {
                    log::info!("token_rotated persisted");
                    // Re-read cfg for relay_url and emit Authenticated.
                    let mc = crate::protocol::MultiConfig::load();
                    if let Some(p) = mc.active_profile() {
                        crate::auth::transition(
                            app,
                            auth_handle,
                            crate::auth::AuthState::Authenticated {
                                user_id: p.user_id.clone(),
                                device_id: p.device_id.clone(),
                                hostname: p.hostname.clone(),
                                relay_url: p.relay_url.clone(),
                                active_relay_id: p.id.clone(),
                                machine_id: p.machine_id.clone(),
                            },
                        );
                    }
                }
                Err(e) => {
                    log::error!("token_rotated rotate_credentials failed: {}", e);
                    crate::auth::transition(
                        app,
                        auth_handle,
                        crate::auth::AuthState::ErrorRecoverable {
                            reason: crate::auth::AuthErrorReason::KeyringUnavailable,
                            retry_after_ms: Some(2_000),
                        },
                    );
                }
            }
        }
        ACTION_KEY_EXCHANGE_REQUESTED => {
            let device_id = match msg.device_id.as_deref() {
                Some(id) => id.to_string(),
                None => {
                    warn!("key_exchange_requested: missing device_id");
                    return;
                }
            };
            info!("key exchange requested for device {}", device_id);

            let cfg = match crate::auth::credential::load_config() {
                Ok(c) => c,
                Err(e) => {
                    error!("cannot load config for key exchange: {}", e);
                    return;
                }
            };
            let user_key = match client_core::credstore::read_encryption_key(&cfg.user_id) {
                Some(k) => k,
                None => {
                    error!("no encryption key for key exchange: no credential stored");
                    return;
                }
            };
            let token = match crate::auth::credential::read_credentials(&cfg) {
                Ok(t) => t,
                Err(e) => {
                    error!("no auth token for key exchange: {}", e);
                    return;
                }
            };
            let ws_fp = msg.device_key_fingerprint.clone().unwrap_or_default();
            let dev_id = device_id.clone();

            tauri::async_runtime::spawn(async move {
                let client = match client_core::http::RestClient::new(cfg.relay_url.clone(), token)
                {
                    Ok(c) => c,
                    Err(e) => {
                        error!("key exchange: cannot build client: {}", e);
                        return;
                    }
                };

                let devices = match client.list_devices().await {
                    Ok(d) => d,
                    Err(e) => {
                        error!("key exchange: list_devices failed: {}", e);
                        return;
                    }
                };
                let device_pub = match devices
                    .iter()
                    .find(|d| d.id == dev_id)
                    .map(|d| d.public_key.clone())
                    .filter(|pk| !pk.is_empty())
                {
                    Some(pk) => pk,
                    None => {
                        error!("device {} has no public key", dev_id);
                        return;
                    }
                };

                // Verify fingerprint from WS message matches the fetched public key.
                // A mismatch means the relay or a MitM substituted a different key.
                if !ws_fp.is_empty() {
                    use base64::Engine;
                    use sha2::Digest;
                    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&device_pub) {
                        Ok(raw_pub) => {
                            let digest = sha2::Sha256::digest(&raw_pub);
                            let fetched_fp = digest[..4]
                                .iter()
                                .map(|b| format!("{:02x}", b))
                                .collect::<String>();
                            if fetched_fp != ws_fp {
                                error!(
                                    "key_exchange_requested: fingerprint mismatch \
                                     (ws={} fetched={}) — aborting",
                                    ws_fp, fetched_fp
                                );
                                return;
                            }
                        }
                        Err(e) => {
                            error!("key_exchange_requested: cannot decode pubkey for fp check: {} — aborting", e);
                            return;
                        }
                    }
                }

                use base64::Engine;
                let user_key_b64 =
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&user_key);

                match client_core::key_exchange::respond(
                    &client,
                    &dev_id,
                    &device_pub,
                    &user_key_b64,
                )
                .await
                {
                    Ok(()) => info!("key bundle posted for device {}", dev_id),
                    Err(e) => error!("key exchange failed: {}", e),
                }
            });
        }
        ACTION_DEVICE_CODE_PENDING => {
            let pending = crate::auth::state::PendingDeviceCode {
                user_code: msg.user_code.unwrap_or_default(),
                hostname: msg.hostname.unwrap_or_else(|| "unknown".into()),
                source_region: msg.source_region.unwrap_or_default(),
                requested_at: msg.requested_at.unwrap_or_else(|| chrono::Utc::now().timestamp()),
            };
            if pending.user_code.is_empty() {
                warn!("device_code_pending: missing user_code");
                return;
            }
            crate::auth::state::add_pending_code(pending_handle, pending.clone());
            crate::events::DeviceCodePending(pending).emit(app).ok();
            // TODO: tray::set_pending_count(app, crate::auth::state::pending_count(pending_handle)) — wired in Task 3.5
        }
        other => {
            warn!("unknown action: {}", other);
        }
    }
}

fn extract_user_id(state: &crate::auth::AuthState) -> String {
    match state {
        crate::auth::AuthState::Authenticated { user_id, .. } => user_id.clone(),
        _ => {
            // Fall back to config.json for the pre-authenticated case (lazy migration on first WS).
            crate::protocol::Config::load()
                .ok()
                .map(|c| c.user_id)
                .unwrap_or_default()
        }
    }
}

async fn handle_image_auto_copy(
    app: &AppHandle,
    _db: &Arc<Database>,
    clip: &crate::protocol::Clip,
    clipboard: &Arc<ClipboardService>,
    pre_token: Option<u64>,
) -> Result<(), String> {
    let media_path = clip
        .media_path
        .as_ref()
        .ok_or_else(|| "no media_path".to_string())?;

    // Fetch image from relay
    let config = match crate::protocol::Config::load() {
        Ok(c) => c,
        Err(e) => return Err(format!("config load failed: {}", e)),
    };

    let url = format!("{}/clips/{}/media", config.relay_url, clip.clip_id);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .send()
        .await
        .map_err(|e| format!("media fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("media fetch returned {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading media body: {}", e))?;

    // Save to local media cache — sanitize media_path to prevent path traversal
    let safe_path = crate::sanitize_media_path(media_path)
        .map_err(|e| format!("rejected unsafe media_path: {}", e))?;
    let media_dir = dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".local/share"))
        .join("com.cinch.app");
    let full_path = media_dir.join(safe_path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&full_path, &bytes).map_err(|e| format!("saving media file: {}", e))?;

    // Pre-write change check: if clipboard changed during download, skip
    if clipboard.has_changed_since(pre_token) {
        info!("clipboard changed during image download, skipping auto-copy");
        crate::events::ImageDownloadComplete(clip.clip_id.clone())
            .emit(app)
            .ok();
        return Ok(());
    }

    // Write image to clipboard
    if let Err(e) = clipboard.write_image_from_png_file(&full_path) {
        return Err(format!("write_image failed: {}", e));
    }

    crate::events::ImageDownloadComplete(clip.clip_id.clone())
        .emit(app)
        .ok();
    info!("image auto-copied to clipboard: {} bytes", bytes.len());
    Ok(())
}

pub(crate) struct EncryptedPayload {
    pub body: String,
    pub encrypted: bool,
}

pub(crate) fn encrypt_or_drop(
    key: Option<&[u8; 32]>,
    plaintext: &[u8],
) -> Option<EncryptedPayload> {
    let key = key?;
    crate::crypto::encrypt(key, plaintext)
        .ok()
        .map(|ct| EncryptedPayload {
            body: ct,
            encrypted: true,
        })
}

/// Build the typed `PushRequest` the relay expects from an offline-queued clip
/// plus its encrypted payload. Pulled out as a pure function so the wire
/// contract can be unit-tested without spinning up a relay or app handle.
pub(crate) fn build_push_request(
    clip: &LocalClip,
    payload: EncryptedPayload,
) -> client_core::rest::PushRequest {
    client_core::rest::PushRequest {
        content: payload.body,
        content_type: clip.content_type.clone(),
        label: clip.label.clone(),
        source: clip.source.clone(),
        media_path: clip.media_path.clone(),
        byte_size: clip.byte_size,
        encrypted: payload.encrypted,
        target_device_id: None,
    }
}

#[cfg(test)]
pub(crate) use encrypt_or_drop as encrypt_or_drop_for_test;

async fn flush_offline_queue(app: &AppHandle, db: &Database) {
    let unsynced = match db.list_unsynced_clips() {
        Ok(clips) => clips,
        Err(e) => {
            warn!("offline flush: failed to list unsynced: {}", e);
            return;
        }
    };

    if unsynced.is_empty() {
        return;
    }

    info!("offline flush: {} clips to sync", unsynced.len());

    let config = match crate::protocol::Config::load() {
        Ok(c) => c,
        Err(e) => {
            warn!("offline flush: config load failed: {}", e);
            return;
        }
    };

    let enc_key: Option<[u8; 32]> = client_core::credstore::read_encryption_key(&config.user_id);

    if enc_key.is_none() {
        let dropped = unsynced.len() as u32;
        error!(
            "offline flush: encryption key missing — dropping {} queued clips",
            dropped
        );
        for clip in &unsynced {
            // Mark synced to prevent a retry storm; the clip is unrecoverable on this device.
            let _ = db.mark_synced(&clip.id);
        }
        crate::events::OfflineQueueDropped { count: dropped }
            .emit(app)
            .ok();
        return;
    }

    let client = match client_core::http::RestClient::new(&config.relay_url, &config.token) {
        Ok(c) => c,
        Err(e) => {
            warn!("offline flush: rest client build failed: {}", e);
            return;
        }
    };

    for clip in &unsynced {
        let payload = match encrypt_or_drop(enc_key.as_ref(), clip.content.as_bytes()) {
            Some(p) => p,
            None => {
                warn!("offline flush: encrypt failed for {}; dropping", clip.id);
                let _ = db.mark_synced(&clip.id);
                continue;
            }
        };

        let req = build_push_request(clip, payload);

        match client.push_clip_json(&req).await {
            Ok(_) => {
                if let Err(e) = db.mark_synced(&clip.id) {
                    warn!("offline flush: mark_synced failed for {}: {}", clip.id, e);
                }
            }
            Err(e) => {
                warn!("offline flush: push failed for {}: {}", clip.id, e);
                break; // stop on first failure, retry on next reconnect
            }
        }
    }
}

/// Testable pure function: classify a WS 401 body string into a Ws401Reason.
/// Used by the connect_and_listen error handler.
#[cfg(test)]
#[allow(dead_code)]
pub fn dispatch_ws_401_for_test(body: &str) -> crate::auth::Ws401Reason {
    if body.contains("device_revoked") {
        crate::auth::Ws401Reason::DeviceRevoked
    } else {
        crate::auth::Ws401Reason::InvalidToken
    }
}

/// Pure helper: map a `WSMessage` to a `PendingDeviceCode` if the required
/// `user_code` field is present and non-empty. Returns `None` otherwise.
/// Extracted so it can be unit-tested without a running Tauri app handle.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn pending_from_ws_message(
    msg: &crate::protocol::WSMessage,
) -> Option<crate::auth::state::PendingDeviceCode> {
    let user_code = msg.user_code.clone().unwrap_or_default();
    if user_code.is_empty() {
        return None;
    }
    Some(crate::auth::state::PendingDeviceCode {
        user_code,
        hostname: msg
            .hostname
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        source_region: msg.source_region.clone().unwrap_or_default(),
        requested_at: msg
            .requested_at
            .unwrap_or_else(|| chrono::Utc::now().timestamp()),
    })
}

#[cfg(test)]
mod pending_tests {
    use super::*;
    use crate::protocol::WSMessage;

    #[test]
    fn pending_from_ws_message_parses_valid_frame() {
        let msg: WSMessage = serde_json::from_str(
            r#"{"action":"device_code_pending","hostname":"dev-box-3","user_code":"ABCD-1234","requested_at":1747171200,"source_region":"us-west"}"#,
        )
        .unwrap();
        let p = pending_from_ws_message(&msg).unwrap();
        assert_eq!(p.user_code, "ABCD-1234");
        assert_eq!(p.hostname, "dev-box-3");
        assert_eq!(p.source_region, "us-west");
        assert_eq!(p.requested_at, 1747171200);
    }

    #[test]
    fn pending_from_ws_message_rejects_missing_user_code() {
        let msg: WSMessage = serde_json::from_str(
            r#"{"action":"device_code_pending","hostname":"dev-box-3"}"#,
        )
        .unwrap();
        assert!(pending_from_ws_message(&msg).is_none());
    }

    #[test]
    fn pending_from_ws_message_rejects_empty_user_code() {
        let msg: WSMessage = serde_json::from_str(
            r#"{"action":"device_code_pending","hostname":"dev-box-3","user_code":""}"#,
        )
        .unwrap();
        assert!(pending_from_ws_message(&msg).is_none());
    }

    #[test]
    fn pending_from_ws_message_defaults_hostname_to_unknown() {
        let msg: WSMessage = serde_json::from_str(
            r#"{"action":"device_code_pending","user_code":"WXYZ-5678"}"#,
        )
        .unwrap();
        let p = pending_from_ws_message(&msg).unwrap();
        assert_eq!(p.hostname, "unknown");
        assert_eq!(p.user_code, "WXYZ-5678");
    }
}
