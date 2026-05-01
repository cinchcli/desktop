use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::auth::AuthState;
use crate::store::models::LocalClip;

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
