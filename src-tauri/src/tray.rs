use log::info;
use std::collections::HashMap;
use std::time::Instant;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::protocol::Clip;

const MAX_RECENT_CLIPS: usize = 10;
const NOTIFICATION_THROTTLE_SECS: u64 = 300; // 5 minutes per source

pub struct TrayMenuItems {
    pub status: MenuItem<tauri::Wry>,
    pub pending: MenuItem<tauri::Wry>,
    pub tray: tauri::tray::TrayIcon<tauri::Wry>,
}

pub struct TrayState {
    recent_clips: Vec<Clip>,
    last_notify: HashMap<String, Instant>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            recent_clips: Vec::new(),
            last_notify: HashMap::new(),
        }
    }

    pub fn add_clip(&mut self, clip: Clip) {
        self.recent_clips.insert(0, clip);
        self.recent_clips.truncate(MAX_RECENT_CLIPS);
    }

    pub fn should_notify(&mut self, source: &str) -> bool {
        let now = Instant::now();
        if let Some(last) = self.last_notify.get(source) {
            if now.duration_since(*last).as_secs() < NOTIFICATION_THROTTLE_SECS {
                return false;
            }
        }
        self.last_notify.insert(source.to_string(), now);
        true
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cinch", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Connecting...", false, None::<&str>)?;
    // Initially empty and disabled; set_pending_count enables it when codes arrive.
    let pending = MenuItem::with_id(app, "pending", "", false, None::<&str>)?;
    let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let sep3 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let sep4 = tauri::menu::PredefinedMenuItem::separator(app)?;
    let no_clips = MenuItem::with_id(app, "no_clips", "No recent clips", false, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open, &sep1, &pending, &sep2, &status, &sep3, &no_clips, &sep4, &quit,
        ],
    )?;

    let tray_img = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    let tray_icon = TrayIconBuilder::new()
        .icon(tray_img)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Cinch — Clipboard Sync")
        .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
            "open" => crate::show_on_active_monitor(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_on_active_monitor(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenuItems {
        status,
        pending,
        tray: tray_icon,
    });

    info!("tray icon created");
    Ok(())
}

/// Update the tray menu item to reflect pending device-code count.
/// Called from the WS handler when a `device_code_pending` frame arrives,
/// and from the TTL sweeper (Task 3.6) after expiry.
pub fn set_pending_count(app: &AppHandle, count: usize) {
    let label = if count == 0 {
        String::new()
    } else if count == 1 {
        "1 pending login request".to_string()
    } else {
        format!("{} pending login requests", count)
    };
    if let Some(items) = app.try_state::<TrayMenuItems>() {
        let _ = items.pending.set_text(&label);
        let _ = items.pending.set_enabled(count > 0);
    }
    // TODO(future): swap to a badged tray icon when count > 0.
    // Requires `icons/tray-badge.png` asset.
}

pub fn update_tray_status(app: &AppHandle, status: &str) {
    let tooltip = match status {
        "connected" => "Cinch — Connected",
        "disconnected" => "Cinch — Disconnected",
        "connecting" => "Cinch — Connecting...",
        _ => "Cinch",
    };
    let label = match status {
        "connected" => "✓ Connected",
        "disconnected" => "⚠ Offline — reconnecting...",
        "connecting" => "Connecting...",
        _ => status,
    };
    if let Some(items) = app.try_state::<TrayMenuItems>() {
        let _ = items.tray.set_tooltip(Some(tooltip));
        let _ = items.status.set_text(label);
    }
}

pub fn update_tray_clip(app: &AppHandle, clip: &Clip) {
    let preview = clip.content.chars().take(40).collect::<String>();
    let source = clip.source.replace("remote:", "");
    let label = format!("{}: {}", source, preview);
    if let Some(items) = app.try_state::<TrayMenuItems>() {
        let _ = items.status.set_text(&label);
    }
}

pub fn show_notification(app: &AppHandle, clip: &Clip) {
    let source = clip.source.replace("remote:", "");
    let size = clip.byte_size;
    let title = format!("📋 Clip from {}", source);
    let body = if clip.content.len() > 80 {
        format!("{}... ({} bytes)", &clip.content[..80], size)
    } else {
        format!("{} ({} bytes)", clip.content, size)
    };

    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();

    info!("notification: {} — {}", title, body);
}
