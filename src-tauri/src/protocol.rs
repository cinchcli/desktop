//! Re-exports of shared wire types from `client-core` plus desktop-only DTOs.
//!
//! Wire protocol (WS frames, Config, MultiConfig, RelayProfile) lives in
//! `client_core::{protocol, config}` so the CLI and desktop share one source
//! of truth. The structs declared here (ConfigInfo, RelayProfileSummary)
//! are UI-only Tauri command return shapes that the CLI does not need.

pub use client_core::config::{
    default_relay_url, Config, MultiConfig, MultiConfigHandle, RelayProfile,
};
pub use client_core::protocol::{
    Clip, DeviceInfo, WSMessage, ACTION_CLIPBOARD_CONTENT, ACTION_CLIP_DELETED, ACTION_CLIP_PINNED,
    ACTION_KEY_EXCHANGE_REQUESTED, ACTION_NEW_CLIP, ACTION_PING, ACTION_PONG, ACTION_REVOKED,
    ACTION_SEND_CLIPBOARD, ACTION_TOKEN_ROTATED,
};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConfigInfo {
    pub relay_url: String,
    pub user_id: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RelayProfileSummary {
    pub id: String,
    pub label: String,
    pub relay_url: String,
    pub user_id: String,
    pub hostname: String,
    pub is_active: bool,
    pub device_count: Option<u32>,
}
