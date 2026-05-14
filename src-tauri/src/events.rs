use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::auth::AuthState;
use crate::commands::clips::LocalClip;

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct AuthStateChanged(pub AuthState);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct WsStatus(pub String);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ClipReceived(pub LocalClip);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ClipDeleted(pub String);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct NewSourceDetected(pub String);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ImageDownloadFailed(pub String);

#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ImageDownloadComplete(pub String);

/// Fired when the desktop notices that credentials on disk came from the CLI
/// (the FS watcher observed a credential_version bump while the desktop was
/// in LocalOnly). The frontend uses this to surface a one-shot toast so the
/// user knows their CLI sign-in carried over.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct AuthAdoptedFromCli {
    pub user_short: String,
}

/// Fired when the desktop receives a `cinch://login?relay=…&from=cli` deep
/// link from the CLI's handoff. The React layer responds by opening the
/// AddRelayDialog with the relay URL pre-filled.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct CliHandoffRequested {
    pub relay_url: String,
}

/// Fired by `pair_via_ssh` when the remote machine's `cinch auth login
/// --headless` emits the device-code marker. The frontend opens `url`
/// in a browser so the user can complete OAuth; the command keeps running
/// until the SSH process exits.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct SshPairMarkerFound {
    pub url: String,
}

/// Fired when queued offline clips are dropped because the encryption key
/// is missing. The frontend shows a toast prompting the user to sign in again.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct OfflineQueueDropped {
    pub count: u32,
}

/// Fired when a received clip cannot be decrypted (wrong or missing AES key).
/// The desktop fires retry_key_bundle automatically; this event lets the UI
/// show a hint so the user knows recovery is in progress.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ClipDecryptFailed {
    pub clip_id: String,
    /// "missing_key" or "tag_failed: <detail>"
    pub reason: String,
}

/// Fired when a clip's pin state changes (from relay WS broadcast or local pin/unpin).
/// React listens to refresh the pinned-clips list on any device.
#[derive(Clone, Serialize, Deserialize, Type, Event)]
pub struct ClipPinned {
    pub clip_id: String,
    pub is_pinned: bool,
    pub pin_note: Option<String>,
}

/// Fired when the relay pushes a `device_code_pending` WebSocket message, indicating
/// that a CLI `cinch auth login --user EMAIL` has started and is awaiting desktop
/// approval. The React layer uses this event to surface the approval UI.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct DeviceCodePending(pub crate::auth::state::PendingDeviceCode);
