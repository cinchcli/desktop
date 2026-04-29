#![allow(dead_code)]
//! Credential storage — keyring primary, plaintext fallback.
//! Service name + account format locked by CONTEXT.md D-06:
//!   service = "com.cinch.app"
//!   account = "<user_id>:<device_id>"

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use keyring::error::Error as KeyringError;
use keyring::Entry;
use log::{info, warn};

use crate::protocol::{Config, MultiConfig, RelayProfile};

pub const SERVICE_NAME: &str = "com.cinch.app";

#[derive(Debug)]
pub enum CredentialError {
    KeyringUnavailable(String), // engages plaintext fallback
    NoEntry,                    // no credential stored
    Io(String),                 // file I/O failed
    BadConfig(String),
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredentialError::KeyringUnavailable(s) => write!(f, "keyring unavailable: {}", s),
            CredentialError::NoEntry => write!(f, "no credential stored"),
            CredentialError::Io(s) => write!(f, "io: {}", s),
            CredentialError::BadConfig(s) => write!(f, "bad config: {}", s),
        }
    }
}

static WARNED_PLAINTEXT: AtomicBool = AtomicBool::new(false);

fn account_key(user_id: &str, device_id: &str) -> String {
    format!("{}:{}", user_id, device_id)
}

fn config_path() -> Result<PathBuf, CredentialError> {
    let home = dirs::home_dir()
        .ok_or_else(|| CredentialError::Io("cannot determine home directory".into()))?;
    Ok(home.join(".cinch").join("config.json"))
}

pub fn load_multi_config() -> Result<MultiConfig, CredentialError> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(MultiConfig::default());
    }
    let data =
        fs::read_to_string(&p).map_err(|e| CredentialError::Io(format!("read config: {}", e)))?;
    let v: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| CredentialError::BadConfig(format!("parse config: {}", e)))?;
    if v.get("relays").is_some() {
        serde_json::from_value(v)
            .map_err(|e| CredentialError::BadConfig(format!("parse multi_config: {}", e)))
    } else {
        let old: Config = serde_json::from_value(v)
            .map_err(|e| CredentialError::BadConfig(format!("parse legacy config: {}", e)))?;
        Ok(MultiConfig::from_legacy_pub(old))
    }
}

pub fn save_multi_config(mc: &MultiConfig) -> Result<(), CredentialError> {
    let p = config_path()?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| CredentialError::Io(format!("mkdir: {}", e)))?;
    }
    let data = serde_json::to_string_pretty(mc)
        .map_err(|e| CredentialError::BadConfig(format!("marshal: {}", e)))?;
    fs::write(&p, data).map_err(|e| CredentialError::Io(format!("write config: {}", e)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&p)
            .map_err(|e| CredentialError::Io(format!("stat: {}", e)))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&p, perms)
            .map_err(|e| CredentialError::Io(format!("chmod 0600: {}", e)))?;
    }
    Ok(())
}

pub(crate) fn load_config() -> Result<Config, CredentialError> {
    Ok(load_multi_config()?.to_active_config())
}

pub(crate) fn save_config_to_disk(cfg: &Config) -> Result<(), CredentialError> {
    let mut mc = load_multi_config()?;
    if let Some(profile) = mc.active_profile_mut() {
        profile.token = cfg.token.clone();
        profile.user_id = cfg.user_id.clone();
        profile.relay_url = cfg.relay_url.clone();
        profile.hostname = cfg.hostname.clone();
        profile.device_id = cfg.active_device_id.clone();
        profile.credential_version = cfg.credential_version;
        profile.encryption_key = cfg.encryption_key.clone();
        profile.device_private_key = cfg.device_private_key.clone();
    } else {
        let profile = RelayProfile::from_config(cfg, None);
        let id = profile.id.clone();
        mc.relays.push(profile);
        mc.active_relay_id = Some(id);
    }
    save_multi_config(&mc)
}

/// Add a new RelayProfile to MultiConfig for a freshly-authenticated relay.
/// Used by the deep-link callback when PendingRelayAdd is set.
/// Returns (relay_id, backend_name).
pub fn add_relay_profile(
    user_id: &str,
    device_id: &str,
    token: &str,
    relay_url: &str,
    hostname: &str,
    label: Option<&str>,
    device_private_key: &str,
) -> Result<(String, &'static str), CredentialError> {
    let mut mc = load_multi_config()?;

    let use_plaintext = std::env::var("CINCH_KEYRING").ok().as_deref() == Some("none");
    let account = account_key(user_id, device_id);
    let mut backend: &'static str = "keyring";
    let mut stored_token = String::new();

    if !use_plaintext {
        match Entry::new(SERVICE_NAME, &account) {
            Ok(entry) => match entry.set_password(token) {
                Ok(()) => {}
                Err(e) => {
                    warn_plaintext_once(&format!("keyring set failed: {}", e));
                    stored_token = token.to_string();
                    backend = "plaintext";
                }
            },
            Err(e) => {
                warn_plaintext_once(&format!("keyring entry creation failed: {}", e));
                stored_token = token.to_string();
                backend = "plaintext";
            }
        }
    } else {
        stored_token = token.to_string();
        backend = "plaintext";
    }

    use ulid::Ulid;
    let relay_id = Ulid::new().to_string();
    let label_str = label
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            url::Url::parse(relay_url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| relay_url.to_string())
        });

    let next_version = mc
        .relays
        .iter()
        .map(|r| r.credential_version)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| CredentialError::BadConfig("credential_version overflow".into()))?;

    let profile = RelayProfile {
        id: relay_id.clone(),
        label: label_str,
        relay_url: relay_url.to_string(),
        user_id: user_id.to_string(),
        device_id: device_id.to_string(),
        hostname: hostname.to_string(),
        encryption_key: String::new(),
        device_private_key: device_private_key.to_string(),
        credential_version: next_version,
        token: stored_token,
    };
    mc.relays.push(profile);
    // First relay or explicit request: make it the active one
    if mc.active_relay_id.is_none() {
        mc.active_relay_id = Some(relay_id.clone());
    }
    save_multi_config(&mc)?;
    info!(
        "add_relay_profile ({}): user={}, device={}, relay={}",
        backend,
        &user_id[..8.min(user_id.len())],
        device_id,
        relay_url
    );
    Ok((relay_id, backend))
}

/// Remove credentials for a specific (user_id, device_id) pair from keyring + MultiConfig.
pub fn wipe_relay_credentials(relay_id: &str) -> Result<(), CredentialError> {
    let mut mc = load_multi_config()?;
    let profile = mc.relays.iter().find(|r| r.id == relay_id).cloned();
    if let Some(p) = profile {
        if !p.user_id.is_empty() && !p.device_id.is_empty() {
            let account = account_key(&p.user_id, &p.device_id);
            if let Ok(entry) = Entry::new(SERVICE_NAME, &account) {
                if let Err(e) = entry.delete_credential() {
                    match e {
                        keyring::error::Error::NoEntry => {}
                        other => warn!("keyring delete_credential: {}", other),
                    }
                }
            }
            // Also wipe encryption key keyring slot
            let enc_account = format!("encryption:{}:{}", p.user_id, p.device_id);
            if let Ok(entry) = Entry::new(SERVICE_NAME, &enc_account) {
                let _ = entry.delete_credential();
            }
        }
    }
    mc.relays.retain(|r| r.id != relay_id);
    if mc.active_relay_id.as_deref() == Some(relay_id) {
        mc.active_relay_id = mc.relays.first().map(|r| r.id.clone());
    }
    let new_version = mc
        .relays
        .iter()
        .map(|r| r.credential_version)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| CredentialError::BadConfig("credential_version overflow".into()))?;
    if let Some(p) = mc.active_profile_mut() {
        p.credential_version = new_version;
    }
    save_multi_config(&mc)
}

fn warn_plaintext_once(reason: &str) {
    if !WARNED_PLAINTEXT.swap(true, Ordering::SeqCst) {
        eprintln!(
            "Warning: OS keyring not available ({}). Token stored in ~/.cinch/config.json — readable by processes running as your user.",
            reason
        );
    }
}

/// write_credentials stores `token` for (user_id, device_id). Keyring-first, plaintext on failure.
/// Bumps `credential_version` on the in-memory config and persists via save_config.
/// Returns the BackendName used ("keyring" | "plaintext").
pub fn write_credentials(
    user_id: &str,
    device_id: &str,
    token: &str,
    relay_url: &str,
    hostname: &str,
) -> Result<&'static str, CredentialError> {
    let mut cfg = load_config()?;

    // Try keyring first unless CINCH_KEYRING=none.
    let use_plaintext = std::env::var("CINCH_KEYRING").ok().as_deref() == Some("none");
    let account = account_key(user_id, device_id);
    let mut backend: &'static str = "keyring";

    if !use_plaintext {
        match Entry::new(SERVICE_NAME, &account) {
            Ok(entry) => match entry.set_password(token) {
                Ok(()) => {
                    cfg.token = String::new(); // keyring path clears plaintext slot
                }
                Err(e) => {
                    warn_plaintext_once(&format!("keyring set failed: {}", e));
                    cfg.token = token.to_string();
                    backend = "plaintext";
                }
            },
            Err(e) => {
                warn_plaintext_once(&format!("keyring entry creation failed: {}", e));
                cfg.token = token.to_string();
                backend = "plaintext";
            }
        }
    } else {
        cfg.token = token.to_string();
        backend = "plaintext";
    }

    cfg.user_id = user_id.to_string();
    cfg.active_device_id = device_id.to_string();
    cfg.relay_url = relay_url.to_string();
    cfg.hostname = hostname.to_string();
    cfg.credential_version = cfg
        .credential_version
        .checked_add(1)
        .ok_or_else(|| CredentialError::BadConfig("credential_version overflow".into()))?;
    save_config_to_disk(&cfg)?;
    info!(
        "credentials written ({}): user={}, device={}, version={}",
        backend,
        &user_id[..8.min(user_id.len())],
        device_id,
        cfg.credential_version
    );
    Ok(backend)
}

/// read_credentials returns the token for the currently-configured (user_id, device_id).
pub fn read_credentials(cfg: &Config) -> Result<String, CredentialError> {
    if cfg.user_id.is_empty() || cfg.active_device_id.is_empty() {
        return Err(CredentialError::NoEntry);
    }
    // If plaintext path populated, prefer it (post-fallback state).
    if !cfg.token.is_empty() {
        return Ok(cfg.token.clone());
    }
    let account = account_key(&cfg.user_id, &cfg.active_device_id);
    match Entry::new(SERVICE_NAME, &account) {
        Ok(entry) => match entry.get_password() {
            Ok(t) => Ok(t),
            Err(KeyringError::NoEntry) => Err(CredentialError::NoEntry),
            Err(KeyringError::PlatformFailure(e)) | Err(KeyringError::NoStorageAccess(e)) => {
                Err(CredentialError::KeyringUnavailable(format!("{}", e)))
            }
            Err(other) => Err(CredentialError::KeyringUnavailable(format!("{}", other))),
        },
        Err(e) => Err(CredentialError::KeyringUnavailable(format!("{}", e))),
    }
}

/// wipe_credentials deletes the keyring entry + clears config.token + bumps credential_version.
/// Called from WS `revoked` handler (Plan 03 Task 3) and `sign_out` command (Plan 03 Task 2).
pub fn wipe_credentials() -> Result<(), CredentialError> {
    let mut cfg = load_config()?;
    if !cfg.user_id.is_empty() && !cfg.active_device_id.is_empty() {
        let account = account_key(&cfg.user_id, &cfg.active_device_id);
        if let Ok(entry) = Entry::new(SERVICE_NAME, &account) {
            if let Err(e) = entry.delete_credential() {
                match e {
                    KeyringError::NoEntry => { /* already gone */ }
                    other => warn!("keyring delete_credential: {}", other),
                }
            }
        }
    }
    cfg.token = String::new();
    cfg.active_device_id = String::new();
    cfg.user_id = String::new();
    cfg.credential_version = cfg
        .credential_version
        .checked_add(1)
        .ok_or_else(|| CredentialError::BadConfig("credential_version overflow".into()))?;
    save_config_to_disk(&cfg)?;
    Ok(())
}

/// Read the encryption key for a user from keychain.
/// Account format: "encryption:<user_id>" (per CONTEXT.md).
pub fn read_encryption_key(user_id: &str) -> Result<Vec<u8>, CredentialError> {
    if user_id.is_empty() {
        return Err(CredentialError::NoEntry);
    }
    let enc_account = format!("encryption:{}", user_id);

    // Try keychain first
    if std::env::var("CINCH_KEYRING").ok().as_deref() != Some("none") {
        if let Ok(entry) = Entry::new(SERVICE_NAME, &enc_account) {
            if let Ok(key_b64) = entry.get_password() {
                use base64::engine::general_purpose::URL_SAFE_NO_PAD;
                use base64::Engine;
                if let Ok(key_bytes) = URL_SAFE_NO_PAD.decode(&key_b64) {
                    if key_bytes.len() == 32 {
                        return Ok(key_bytes);
                    }
                }
            }
        }
    }

    // Fallback: check config.encryption_key
    let cfg = load_config()?;
    if !cfg.encryption_key.is_empty() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        if let Ok(key_bytes) = URL_SAFE_NO_PAD.decode(&cfg.encryption_key) {
            if key_bytes.len() == 32 {
                return Ok(key_bytes);
            }
        }
    }

    Err(CredentialError::NoEntry)
}

/// Write the encryption key for a user to keychain.
pub fn write_encryption_key(user_id: &str, key_bytes: &[u8]) -> Result<(), CredentialError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let enc_account = format!("encryption:{}", user_id);
    let key_b64 = URL_SAFE_NO_PAD.encode(key_bytes);

    if std::env::var("CINCH_KEYRING").ok().as_deref() != Some("none") {
        if let Ok(entry) = Entry::new(SERVICE_NAME, &enc_account) {
            if entry.set_password(&key_b64).is_ok() {
                return Ok(());
            }
        }
    }

    // Fallback: store in config
    let mut cfg = load_config()?;
    cfg.encryption_key = key_b64;
    save_config_to_disk(&cfg)?;
    warn_plaintext_once("encryption key stored in config (keychain failed)");
    Ok(())
}

/// rotate_credentials persists a new token after a WS `token_rotated` event (Plan 03 Task 3).
/// Similar to write_credentials but preserves relay_url + hostname.
pub fn rotate_credentials(
    user_id: &str,
    device_id: &str,
    token: &str,
    hostname: &str,
) -> Result<&'static str, CredentialError> {
    let cfg = load_config()?;
    write_credentials(user_id, device_id, token, &cfg.relay_url, hostname)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_key_format() {
        assert_eq!(account_key("u1", "d1"), "u1:d1");
    }

    #[test]
    fn keyring_roundtrip() {
        // Use a unique account per test run to avoid collision on dev workstations.
        let unique = format!(
            "test-user-{}:test-device-{}",
            std::process::id(),
            rand_suffix()
        );
        let entry = match Entry::new(SERVICE_NAME, &unique) {
            Ok(e) => e,
            Err(_) => return, // skip on CI without keyring
        };
        if entry.set_password("hunter2").is_err() {
            return;
        }
        assert_eq!(entry.get_password().ok(), Some("hunter2".to_string()));
        let _ = entry.delete_credential();
    }

    fn rand_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }
}
