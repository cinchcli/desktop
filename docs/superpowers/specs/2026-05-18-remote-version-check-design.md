# Remote device version check & update prompt

**Date**: 2026-05-18
**Status**: Approved (brainstorming)
**Scope**: cinch-core, relay, cinch (CLI), desktop

## Problem

Paired devices (CLI on remote SSH machines, desktop on other Macs) currently expose no version information. A user holding desktop v0.1.7 cannot tell whether their remote CLI on a Linux VM is at v0.1.8 or v0.1.2. There is also no in-app prompt to update an outdated client.

## Goals

1. Every paired device's current cinch client version is visible in the desktop `DevicesPanel` and in `cinch auth status`.
2. Outdated devices are flagged (amber badge in UI, stderr nudge in CLI).
3. The user can update *their own* desktop with one click via the existing `tauri-plugin-updater` infrastructure.
4. Other devices receive instructions ("run `brew upgrade cinch`") rather than remote execution, to avoid sudo / keychain / locking complexity.

## Non-goals

- Remote execution of update commands on other machines.
- Forced or blocking updates. Outdated devices keep working; only nudges are shown.
- Tracking arbitrary client metadata beyond `version` + `type`.
- Supporting client types other than `cli` and `desktop` for now. The string field is open for future extension.

## Architecture

Three responsibilities, three places:

```
┌──────────────────┐                 ┌──────────────────┐
│  Each client     │  client_hello   │   Relay          │
│  (CLI/desktop)   │  ─────────────▶│  - persists      │
│  knows its own   │   (WS first    │    version/type  │
│  version+type    │   message)     │  - serves via    │
│                  │  + X-Cinch-…   │    ListDevices   │
│                  │   HTTP header  │                  │
└──────────────────┘                 └──────────────────┘
                                              │
                                              ▼
                                     ┌──────────────────┐
                                     │  Desktop UI      │
                                     │  - fetches GH    │
                                     │    latest (6h)   │
                                     │  - compares,     │
                                     │    badges, btn   │
                                     └──────────────────┘
```

- **Client** announces its own `client_version` + `client_type`. It does no comparison.
- **Relay** persists the announcement and surfaces it via `ListDevices`. It does not judge "outdated".
- **Viewer** (desktop UI / CLI) fetches GitHub latest releases for each `client_type` and compares per-device. "Outdated" is a viewer-side concept so the GitHub API hit happens in exactly one place.

## Wire schema

### `cinch-core/.../proto/cinch/v1/devices.proto`

```proto
message Device {
  // ... existing fields 1–11 ...

  // Semver string of the client binary as reported via WS hello or
  // X-Cinch-Client-Version. Empty if the device has not reported yet.
  optional string client_version = 12;

  // "cli" or "desktop". Determines which GitHub repo's latest release
  // to compare against. Empty if not reported.
  optional string client_type = 13;

  // RFC3339 timestamp of the last version report.
  optional string client_version_at = 14;
}
```

`client_type` is a string (not enum) to keep wire-version policy simple. Validation lives in the relay.

### Relay `WSMessage` envelope (`relay/internal/protocol/ws.go`)

Hand-written envelope; not part of cinch-core proto. New optional sibling:

```go
ClientHello *ClientHelloPayload `json:"client_hello,omitempty"`

type ClientHelloPayload struct {
    Version string `json:"version"`           // CARGO_PKG_VERSION
    Type    string `json:"type"`              // "cli" | "desktop"
    OS      string `json:"os,omitempty"`      // future hint, unused
}
```

Mirror in Rust at `cinch-core/.../src/protocol.rs::WSMessage`.

### Relay DB migration

```sql
ALTER TABLE devices
  ADD COLUMN client_version TEXT,
  ADD COLUMN client_type TEXT,
  ADD COLUMN client_version_at TIMESTAMPTZ;

CREATE INDEX idx_devices_client_type ON devices(client_type)
  WHERE client_type IS NOT NULL;
```

All three columns are nullable. Pre-existing device rows surface as `unknown` in the UI until the client reconnects and reports.

### HTTP transport (push-only CLI path)

`cinch-core`'s `http.rs` request builder always attaches two headers on authenticated requests:

```
X-Cinch-Client-Version: 0.1.8
X-Cinch-Client-Type: cli
```

A relay HTTP middleware updates the same three columns on any authenticated request that carries both headers and a valid `client_type`. This covers one-shot CLI invocations that never open a WebSocket.

### Cascade order

1. **cinch-core** PR: edit `.proto`, `make generate`, update wire-vectors, bump to 0.1.6, publish to crates.io + tag.
2. **relay** PR: `make update-cinch-core REV=v0.1.6`, add `ClientHello` to `WSMessage`, run DB migration, add HTTP middleware, include the three new fields in `ListDevices` mapping.
3. **cinch (CLI)** PR: `cargo update -p cinchcli-core`, send `client_hello` after WS auth, attach HTTP headers, render versions in `auth status`, add `update_check.rs` for self nudge.
4. **desktop** PR: same as CLI plus UI components.

All new fields are optional — old client ↔ new relay and new client ↔ old relay both degrade gracefully (the absent side just sees empty fields).

## Components

### `cinch-core/crates/client-core/src/version.rs` (new)

```rust
pub enum ClientType { Cli, Desktop }
impl ClientType { pub fn as_str(self) -> &'static str { /* ... */ } }

pub fn client_hello(t: ClientType, version: &str) -> WSMessage { /* ... */ }
pub fn http_headers(t: ClientType, version: &str) -> [(HeaderName, HeaderValue); 2] { /* ... */ }
```

The CLI/desktop main crates pass `env!("CARGO_PKG_VERSION")` in — `cinch-core` must never use its own `CARGO_PKG_VERSION` for this, because that would return the cinch-core crate version (0.1.5), not the consumer binary version.

### `relay`

- `internal/relay/store.go` — new `UpdateDeviceVersion(deviceID, version, clientType)`. UPSERT into three columns. Validates `clientType ∈ {"cli", "desktop"}`; invalid input is a no-op.
- `internal/relay/hub.go` — WS message handler dispatches `action == "client_hello"` to `store.UpdateDeviceVersion`. Fire-and-forget (no response).
- `internal/relay/middleware.go` — authenticated request middleware reads `X-Cinch-Client-Version`/`X-Cinch-Client-Type`. Updates run on a bounded goroutine queue so the request itself never blocks on DB writes.
- `internal/relay/connect_devices.go` — `ListDevices` maps the three new columns into `cinchv1.Device`.

### `cinch` (CLI)

- `crates/cli/src/main.rs` — on every command, build HTTP requests via cinch-core's `http.rs` (auto-attaches headers). When the command opens a WS (subscribe mode), send `client_hello` as the first message after auth.
- `crates/cli/src/commands/auth.rs` — `cinch auth status` adds a `version` column to the device listing with an `(outdated)` marker derived from the local update_check cache.
- `crates/cli/src/update_check.rs` (new):
  - Cache file at `~/.cache/cinch/version-cache.json` (or platform equivalent via `dirs::cache_dir()`), TTL 6h.
  - `fn check_self_outdated() -> Option<UpdateNudge>` — synchronous cache read, async refresh if stale (detached tokio task, never blocks).
  - Just before process exit, main calls this. If outdated and stderr is a TTY and `CINCH_NO_UPDATE_NUDGE` is unset, print one line to stderr.

### `desktop`

**Rust (`src-tauri/src/`)**:
- `ws.rs` — send `client_hello { type: "desktop", version }` immediately after WS auth completes.
- `update_check.rs` (new):
  - `async fn fetch_latest_versions() -> Result<LatestVersions>` — fetch `cinchcli/cinch` and `cinchcli/desktop` GitHub latest in parallel. Cache to `AppLocalDataDir/version-cache.json`, TTL 6h.
  - `commands::get_latest_versions()` — Tauri command exposed via tauri-specta. Reads cache; spawns refresh if stale.
  - `commands::get_device_version_status(device_id) -> VersionStatus` — does the semver comparison in Rust using the `semver` crate. Returns `UpToDate | Outdated | Unknown`.
  - Background task: poll every 6h, emit `latest_versions_updated` event on success.
- `commands/updater.rs` (new) — `commands::run_self_update()` wraps `tauri-plugin-updater`'s check + download + install. Progress events via `self_update_progress`.

**TypeScript (`src/`)**:
- `components/DeviceVersionBadge.tsx` (new) — props: `device: Device`, `status: VersionStatus`. Renders the version string + colored dot (green/amber) or `—` for unknown.
- `components/DeviceUpdateAction.tsx` (new) — props: `device`, `status`, `isOwnDesktop: boolean`. Renders "Update" button (own desktop + outdated) or "How to update" link (other devices + outdated) or nothing.
- `components/DevicesPanel.tsx` — embed the two new components into the existing row layout. No structural redesign.
- `state/versions.ts` (new) — subscribes to `latest_versions_updated` and exposes `useLatestVersions()` + `useDeviceStatus(device)` hooks.

**Own-machine detection**: a device is "this desktop" iff its `id` matches the desktop's locally-stored own device ID *and* `client_type == "desktop"`.

## Data flow

### Desktop boot

1. WS connect → auth → desktop sends `WSMessage { action: "client_hello", client_hello: {version, type: "desktop"} }`.
2. Relay hub calls `store.UpdateDeviceVersion`.
3. Desktop spawns background `fetch_latest_versions`. Result cached + emitted as `latest_versions_updated`.
4. React `DevicesPanel` calls `commands.listDevices()` and subscribes to the event. Each row renders `DeviceVersionBadge` + `DeviceUpdateAction`.

### Periodic refresh (desktop)

6h timer fires `fetch_latest_versions(force=false)`. Cache-stale path fetches GitHub and emits the event; cache-fresh path is a no-op. UI re-evaluates statuses on event.

### CLI command (`cinch push`)

1. Request builder attaches `X-Cinch-Client-Version` / `X-Cinch-Client-Type`.
2. Relay middleware queues `UpdateDeviceVersion`.
3. Command runs normally.
4. Just before exit, `check_self_outdated` consults the local cache. If outdated and stderr is a TTY, print:
   `cinch v0.1.8 — v0.1.9 available, run \`brew upgrade cinch\``

### Self-update click

1. UI calls `commands.runSelfUpdate()`.
2. Rust runs `tauri-plugin-updater::check()` → `download_and_install` with progress callback.
3. On success the plugin restarts the app. On failure, emit `self_update_failed` with a typed reason and show a toast.

### Remote "How to update" click

Opens the system browser to `https://cinchcli.com/docs/update#<client_type>`. No remote execution.

### Outdated judgment (Rust side)

```rust
match (Version::parse(&device.client_version?), Version::parse(latest)) {
    (Ok(a), Ok(b)) if a < b => VersionStatus::Outdated,
    (Ok(_), Ok(_))          => VersionStatus::UpToDate,
    _                       => VersionStatus::Unknown,
}
```

Dirty/dev builds intentionally parse as Unknown — keeps amber badges silent during development.

## Error handling

| Failure | Behavior |
|---|---|
| GitHub fetch network/403/404/malformed | Keep last cached value; do not invalidate. Retry on next 6h tick. No user-visible error. |
| `client_version` not semver | `VersionStatus::Unknown`. No badge. |
| `client_type` not in allowlist | Middleware/hub silently drops the update. Existing column value preserved. |
| `client_hello` + HTTP header race | Both call the same idempotent UPSERT. Last write wins on `client_version_at`. |
| `tauri-plugin-updater check()` fails | Toast "Couldn't check for updates"; retry on next 6h tick. Button re-enables. |
| `tauri-plugin-updater install()` fails (disk full, signature mismatch, permission) | `self_update_failed` event with typed reason. App does not restart. Signature mismatch shows a specific "verify package manually" toast. |
| CLI nudge in non-TTY / `CINCH_NO_UPDATE_NUDGE=1` | Suppressed entirely. |
| Relay rollback (old relay + new client) | Old relay ignores hello/header. UI shows `unknown` for all devices. Degradation only. |
| Client rollback (new relay + old client) | Old client never reports. `client_version_at` goes stale. UI shows "last seen N days ago" — accuracy is sacrificed for honesty. |
| Intentional downgrade (user `brew install cinch@old`) | Reports the downgraded version honestly. Will be flagged outdated. User can suppress via env var. |

## Testing

### `cinch-core` wire round-trip

- Add Device variant with the three new fields to `testdata/wire-vectors.json` (both cinch-core and relay copies). Verify Rust `tests/wire_vectors.rs` and Go `internal/wire_test/...` produce byte-equal output.
- Add `TestWSMessage_ClientHello_RoundTrip` in `relay/internal/protocol/ws_test.go` and mirror in Rust.

### `relay`

- `store_test.go`: `TestUpdateDeviceVersion_Upsert`, `TestUpdateDeviceVersion_InvalidType_Rejected`.
- `hub_test.go`: `TestWS_ClientHello_PersistsVersion`, `TestWS_ClientHello_Idempotent`.
- `middleware_test.go`: `TestHTTPHeader_PersistsVersion`, `TestHTTPHeader_Missing_NoCall`, `TestHTTPHeader_InvalidType_Rejected`.
- `connect_devices_test.go`: `TestListDevices_IncludesVersion`, `TestListDevices_NullVersion_OmittedAsEmpty`.

### `cinch` (CLI)

- `update_check.rs` unit tests using `mockito` for GitHub stubs:
  - cache miss → fetch → cache write
  - cache hit + fresh → fetch skipped
  - cache hit + stale → background fetch spawned
  - malformed response → `Unknown` returned
  - `CINCH_NO_UPDATE_NUDGE=1` → nudge suppressed
- `auth status` snapshot test verifying the version column renders correctly with mixed up-to-date / outdated / unknown devices.

### `desktop` Rust

- `update_check.rs` unit tests:
  - parallel fetch success
  - one-side fetch failure does not break the other
  - `compare_version` covers up/outdated/unknown including dirty builds, missing fields, malformed semver.
- `commands::run_self_update` is a thin wrapper around `tauri-plugin-updater`; not unit-tested — covered by manual E2E.

### `desktop` TypeScript

- `DeviceVersionBadge.test.tsx`: up/outdated/unknown, missing latest → unknown.
- `DeviceUpdateAction.test.tsx`: own desktop + outdated → button; other devices → link; own + up-to-date → nothing; button click invokes `commands.runSelfUpdate` once.
- `DevicesPanel.test.tsx`: existing test extended to assert the badge and action render inside each row.

### Manual / E2E

1. Real GitHub fetch in staging — verify cache file is created and contents match latest tags.
2. `tauri-plugin-updater` end-to-end: install old desktop build, publish a release, click Update, confirm download/install/restart.
3. Pair a CLI on a Linux VM, run a `cinch push`, confirm relay logs show the version header and desktop UI shows the version.

## Open questions

None at this stage. Implementation plan will resolve order and concrete file changes per repo.
