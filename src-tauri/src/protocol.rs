use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;

// WebSocket action constants (must match Go relay exactly)
pub const ACTION_NEW_CLIP: &str = "new_clip";
pub const ACTION_CLIP_DELETED: &str = "clip_deleted";
pub const ACTION_SEND_CLIPBOARD: &str = "send_clipboard";
pub const ACTION_CLIPBOARD_CONTENT: &str = "clipboard_content";
pub const ACTION_PING: &str = "ping";
pub const ACTION_PONG: &str = "pong";
#[allow(dead_code)]
pub const ACTION_REVOKED: &str = "revoked";
#[allow(dead_code)]
pub const ACTION_TOKEN_ROTATED: &str = "token_rotated";
#[allow(dead_code)]
pub const ACTION_KEY_EXCHANGE_REQUESTED: &str = "key_exchange_requested";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WSMessage {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<Clip>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>, // NEW — token_rotated payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>, // NEW — token_rotated + revoked payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>, // NEW — token_rotated payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>, // NEW — revoked payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_key_fingerprint: Option<String>, // NEW — key_exchange_requested: SHA-256[0:8] hex of device public key
}

impl WSMessage {
    pub fn pong() -> Self {
        Self {
            action: ACTION_PONG.to_string(),
            clip: None,
            pull_id: None,
            content: None,
            error: None,
            token: None,
            device_id: None,
            hostname: None,
            reason: None,
            device_key_fingerprint: None,
        }
    }

    pub fn clipboard_content(pull_id: String, content: String) -> Self {
        Self {
            action: ACTION_CLIPBOARD_CONTENT.to_string(),
            clip: None,
            pull_id: Some(pull_id),
            content: Some(content),
            error: None,
            token: None,
            device_id: None,
            hostname: None,
            reason: None,
            device_key_fingerprint: None,
        }
    }

    pub fn clipboard_error(pull_id: String, err: String) -> Self {
        Self {
            action: ACTION_CLIPBOARD_CONTENT.to_string(),
            clip: None,
            pull_id: Some(pull_id),
            content: None,
            error: Some(err),
            token: None,
            device_id: None,
            hostname: None,
            reason: None,
            device_key_fingerprint: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    #[serde(rename = "clip_id")]
    pub id: String,
    pub user_id: String,
    pub content: String,
    pub content_type: String,
    pub source: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub byte_size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_path: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub ttl: i64,
    #[serde(default)]
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DeviceInfo {
    pub id: String,
    pub hostname: String,
    pub source_key: String,
    pub clip_count: i64,
    pub paired_at: String,
    pub last_push_at: Option<String>,
    pub online: bool,
    #[serde(default)]
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConfigInfo {
    pub relay_url: String,
    pub user_id: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default = "default_relay_url")]
    pub relay_url: String,
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub active_device_id: String, // NEW — D-06 device identity for this install
    #[serde(default)]
    pub credential_version: u64, // NEW — D-08 monotonic counter bumped on every credential write
    #[serde(default)]
    pub encryption_key: String, // E2EE: base64url(user_key[32]); primary path is keychain, this is plaintext fallback
    #[serde(default)]
    pub device_private_key: String, // E2EE: base64url(X25519 private key) for ECDH; stored in 0600 config.json
}

fn default_relay_url() -> String {
    "http://localhost:8080".to_string()
}

// ─── Multi-relay types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayProfile {
    pub id: String,
    pub label: String,
    pub relay_url: String,
    pub user_id: String,
    pub device_id: String,
    pub hostname: String,
    #[serde(default)]
    pub encryption_key: String,
    #[serde(default)]
    pub device_private_key: String,
    #[serde(default)]
    pub credential_version: u64,
    #[serde(default)]
    pub token: String,
}

impl RelayProfile {
    pub fn from_config(cfg: &Config, label: Option<String>) -> Self {
        use ulid::Ulid;
        let id = Ulid::new().to_string();
        let label = label.unwrap_or_else(|| {
            url::Url::parse(&cfg.relay_url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| cfg.relay_url.clone())
        });
        Self {
            id,
            label,
            relay_url: cfg.relay_url.clone(),
            user_id: cfg.user_id.clone(),
            device_id: cfg.active_device_id.clone(),
            hostname: cfg.hostname.clone(),
            encryption_key: cfg.encryption_key.clone(),
            device_private_key: cfg.device_private_key.clone(),
            credential_version: cfg.credential_version,
            token: cfg.token.clone(),
        }
    }

    pub fn to_config(&self) -> Config {
        Config {
            token: self.token.clone(),
            user_id: self.user_id.clone(),
            relay_url: self.relay_url.clone(),
            hostname: self.hostname.clone(),
            active_device_id: self.device_id.clone(),
            credential_version: self.credential_version,
            encryption_key: self.encryption_key.clone(),
            device_private_key: self.device_private_key.clone(),
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MultiConfig {
    #[serde(default)]
    pub active_relay_id: Option<String>,
    #[serde(default)]
    pub relays: Vec<RelayProfile>,
}

pub type MultiConfigHandle = Arc<Mutex<MultiConfig>>;

impl MultiConfig {
    pub fn load() -> Self {
        let Some(home) = dirs::home_dir() else {
            return Self::default();
        };
        let path = home.join(".cinch").join("config.json");
        if !path.exists() {
            return Self::default();
        }
        let Ok(data) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            return Self::default();
        };
        if v.get("relays").is_some() {
            serde_json::from_value(v).unwrap_or_default()
        } else {
            let old: Config = match serde_json::from_value(v) {
                Ok(c) => c,
                Err(_) => return Self::default(),
            };
            Self::from_legacy(old)
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let home = dirs::home_dir().ok_or("cannot determine home directory")?;
        let dir = home.join(".cinch");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
        let path = dir.join("config.json");
        let data = serde_json::to_string_pretty(self).map_err(|e| format!("marshal: {}", e))?;
        std::fs::write(&path, &data).map_err(|e| format!("write: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(&path, perms);
            }
        }
        Ok(())
    }

    pub fn active_profile(&self) -> Option<&RelayProfile> {
        let id = self.active_relay_id.as_deref()?;
        self.relays.iter().find(|r| r.id == id)
    }

    pub fn active_profile_mut(&mut self) -> Option<&mut RelayProfile> {
        let id = self.active_relay_id.clone()?;
        self.relays.iter_mut().find(|r| r.id == id)
    }

    pub fn to_active_config(&self) -> Config {
        self.active_profile()
            .map(|p| p.to_config())
            .unwrap_or_default()
    }

    pub fn from_legacy_pub(old: Config) -> Self {
        Self::from_legacy(old)
    }

    fn from_legacy(old: Config) -> Self {
        if old.user_id.is_empty() && old.token.is_empty() {
            return Self::default();
        }
        let profile = RelayProfile::from_config(&old, None);
        let id = profile.id.clone();
        Self {
            active_relay_id: Some(id),
            relays: vec![profile],
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            token: String::new(),
            user_id: String::new(),
            relay_url: default_relay_url(),
            hostname: String::new(),
            active_device_id: String::new(),
            credential_version: 0,
            encryption_key: String::new(),
            device_private_key: String::new(),
        }
    }
}

impl Config {
    pub fn is_configured(&self) -> bool {
        !self.token.is_empty()
    }

    pub fn load() -> Result<Self, String> {
        let mc = MultiConfig::load();
        let cfg = mc.to_active_config();
        if cfg.user_id.is_empty() && cfg.token.is_empty() {
            return Err("no active relay configured — run: cinch auth login".to_string());
        }
        Ok(cfg)
    }

    pub fn ws_url(&self) -> String {
        let base = self
            .relay_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        format!("{}/ws?token={}", base, self.token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_new_clip_message() {
        let json = r#"{
            "action": "new_clip",
            "clip": {
                "clip_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "user_id": "user123",
                "content": "hello world",
                "content_type": "text",
                "source": "remote:prod-api",
                "label": "",
                "byte_size": 11,
                "created_at": "2026-04-14T12:00:00Z",
                "ttl": 0
            }
        }"#;
        let msg: WSMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.action, ACTION_NEW_CLIP);
        let clip = msg.clip.unwrap();
        assert_eq!(clip.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(clip.content, "hello world");
        assert_eq!(clip.source, "remote:prod-api");
    }

    #[test]
    fn test_parse_send_clipboard_message() {
        let json = r#"{"action":"send_clipboard","pull_id":"pull123"}"#;
        let msg: WSMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.action, ACTION_SEND_CLIPBOARD);
        assert_eq!(msg.pull_id.unwrap(), "pull123");
    }

    #[test]
    fn test_parse_ping_message() {
        let json = r#"{"action":"ping"}"#;
        let msg: WSMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.action, ACTION_PING);
    }

    #[test]
    fn test_parse_clip_deleted_message() {
        let json = r#"{"action":"clip_deleted","clip":{"clip_id":"del123","user_id":"u1","content":"","content_type":"text","source":"local","created_at":"2026-04-14T12:00:00Z"}}"#;
        let msg: WSMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.action, ACTION_CLIP_DELETED);
        assert_eq!(msg.clip.unwrap().id, "del123");
    }

    #[test]
    fn test_serialize_pong() {
        let msg = WSMessage::pong();
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""action":"pong""#));
        assert!(!json.contains("clip"));
    }

    #[test]
    fn test_serialize_clipboard_content() {
        let msg = WSMessage::clipboard_content("pull123".into(), "clipboard data".into());
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""action":"clipboard_content""#));
        assert!(json.contains(r#""pull_id":"pull123""#));
        assert!(json.contains(r#""content":"clipboard data""#));
    }

    #[test]
    fn test_ws_url_http() {
        let config = Config {
            token: "abc123".into(),
            relay_url: "http://localhost:8080".into(),
            user_id: String::new(),
            hostname: String::new(),
            active_device_id: String::new(),
            credential_version: 0,
            encryption_key: String::new(),
            device_private_key: String::new(),
        };
        assert_eq!(config.ws_url(), "ws://localhost:8080/ws?token=abc123");
    }

    #[test]
    fn test_ws_url_https() {
        let config = Config {
            token: "abc123".into(),
            relay_url: "https://relay.example.com".into(),
            user_id: String::new(),
            hostname: String::new(),
            active_device_id: String::new(),
            credential_version: 0,
            encryption_key: String::new(),
            device_private_key: String::new(),
        };
        assert_eq!(config.ws_url(), "wss://relay.example.com/ws?token=abc123");
    }
}
