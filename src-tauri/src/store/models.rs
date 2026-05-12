use serde::{Deserialize, Serialize};
use specta::Type;

use crate::protocol::Clip as ProtoClip;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LocalClip {
    pub id: String,
    pub user_id: String,
    pub content: String,
    pub content_type: String,
    pub source: String,
    pub label: String,
    pub byte_size: i64,
    pub media_path: Option<String>,
    pub created_at: i64, // unix timestamp
    pub synced: bool,
    pub is_pinned: bool,
    pub pin_note: Option<String>,
    pub received_at: i64, // unix timestamp: when this desktop received the clip
}

impl LocalClip {
    pub fn from_proto(clip: &ProtoClip, received_at: i64) -> Self {
        let content_type = detect_content_type(&clip.content, &clip.content_type);
        let created_at = parse_timestamp(&clip.created_at);

        Self {
            id: clip.clip_id.clone(),
            user_id: clip.user_id.clone(),
            content: clip.content.clone(),
            content_type,
            source: clip.source.clone(),
            label: clip.label.clone(),
            byte_size: clip.byte_size,
            media_path: clip.media_path.clone(),
            created_at,
            synced: true,
            is_pinned: clip.is_pinned,
            pin_note: clip.pin_note.clone(),
            received_at,
        }
    }
}

/// Client-side content type detection.
/// The relay only sends "text", "code", "url".
/// We additionally detect "json" and "error" locally.
pub fn detect_content_type(content: &str, relay_type: &str) -> String {
    // If relay already classified as code or url, trust it
    if relay_type == "code" || relay_type == "url" {
        return relay_type.to_string();
    }

    let trimmed = content.trim();

    // JSON detection
    if ((trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']')))
        && serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
    {
        return "json".to_string();
    }

    // Error detection
    if is_error_content(trimmed) {
        return "error".to_string();
    }

    relay_type.to_string()
}

fn is_error_content(s: &str) -> bool {
    let lower = s.to_lowercase();
    let patterns = [
        "error:",
        "err:",
        "fatal:",
        "panic:",
        "exception:",
        "traceback",
        "stack trace",
        "segmentation fault",
        "cannot ",
        "failed to ",
        "unable to ",
    ];
    patterns.iter().any(|p| lower.contains(p))
}

fn parse_timestamp(s: &str) -> i64 {
    // Try RFC3339 parsing
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.timestamp();
    }
    // Fallback to current time
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_json() {
        assert_eq!(detect_content_type(r#"{"key": "value"}"#, "text"), "json");
        assert_eq!(detect_content_type(r#"[1, 2, 3]"#, "text"), "json");
        assert_eq!(detect_content_type("not json", "text"), "text");
        assert_eq!(detect_content_type("{invalid", "text"), "text");
    }

    #[test]
    fn test_detect_error() {
        assert_eq!(
            detect_content_type("ERROR: connection refused", "text"),
            "error"
        );
        assert_eq!(detect_content_type("panic: runtime error", "text"), "error");
        assert_eq!(
            detect_content_type("Traceback (most recent call last):", "text"),
            "error"
        );
        assert_eq!(detect_content_type("hello world", "text"), "text");
    }

    #[test]
    fn test_relay_type_preserved() {
        assert_eq!(detect_content_type("anything", "code"), "code");
        assert_eq!(detect_content_type("https://example.com", "url"), "url");
    }

    #[test]
    fn test_from_proto() {
        let proto = ProtoClip {
            clip_id: "test123".into(),
            user_id: "user1".into(),
            content: r#"{"error": "timeout"}"#.into(),
            content_type: "text".into(),
            source: "remote:prod".into(),
            label: "".into(),
            byte_size: 20,
            media_path: None,
            created_at: "2026-04-14T12:00:00Z".into(),
            encrypted: false,
            is_pinned: false,
            pin_note: None,
        };
        let local = LocalClip::from_proto(&proto, chrono::Utc::now().timestamp());
        assert_eq!(local.content_type, "json"); // detected client-side
        assert!(local.created_at > 0); // parsed some timestamp
    }
}
