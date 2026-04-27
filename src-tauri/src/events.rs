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
