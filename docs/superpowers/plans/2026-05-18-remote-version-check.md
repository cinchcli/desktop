# Remote Device Version Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every paired device's cinch client version in the desktop `DevicesPanel` and `cinch auth status`, flag outdated versions, and let the user one-click self-update their own desktop.

**Architecture:** Each client announces `client_version` + `client_type` via a WS `client_hello` action and matching `X-Cinch-Client-*` HTTP headers. Relay persists the trio in `devices` (version, type, version_at) and returns them via `ListDevices`. The desktop UI fetches GitHub Releases for each `client_type` every 6h, compares per-device in Rust using the `semver` crate, and renders badges + an Update button (own desktop) or docs link (other devices).

**Tech Stack:** protobuf via cinch-core, Connect-RPC + Go relay, Rust client-core, Tauri 2 (`tauri-plugin-updater` already wired), React/TypeScript with vitest, GitHub Releases REST API.

**Spec:** `docs/superpowers/specs/2026-05-18-remote-version-check-design.md`

---

## Cascade Note

This plan touches four repos in dependency order. The engineer **must complete each phase, publish/tag, and verify before starting the next**:

1. **`cinch-core`** → publish `cinchcli-core 0.1.6` to crates.io + tag `v0.1.6`
2. **`relay`** → consumes cinch-core 0.1.6
3. **`cinch`** (CLI) → consumes cinch-core 0.1.6
4. **`desktop`** → consumes cinch-core 0.1.6

Phases 2–4 can run in parallel after Phase 1, but each repo's CI must pass on its own.

---

## Phase 1 — `cinch-core` wire schema

All paths in this phase are relative to `/Users/jinmu/Programming/cinchcli/cinch-core`.

### Task 1: Add proto fields to `Device`

**Files:**
- Modify: `crates/client-core/proto/cinch/v1/devices.proto:32-46`

- [ ] **Step 1: Edit the proto**

Add three optional fields below `machine_id` (line 43):

```proto
message Device {
  string id = 1;
  string hostname = 2;
  string source_key = 3;
  int32 clip_count = 4;
  string paired_at = 5;
  optional string last_push_at = 6;
  bool online = 7;
  string nickname = 8;
  string public_key = 9;
  string public_key_fingerprint = 10;
  optional string machine_id = 11;

  // Semver string of the client binary as reported via WS client_hello or
  // X-Cinch-Client-Version. Empty if the device has not reported yet.
  optional string client_version = 12;

  // "cli" or "desktop". Determines which GitHub repo's latest release to
  // compare against. Empty if not reported.
  optional string client_type = 13;

  // RFC3339 timestamp of the last version report.
  optional string client_version_at = 14;
}
```

- [ ] **Step 2: Regenerate Go bindings**

Run: `make generate`
Expected: `go/cinch/v1/devices.pb.go` regenerates with three new fields. No buf-lint errors.

- [ ] **Step 3: Verify Rust build picks up the change**

Run: `cargo build -p cinchcli-core`
Expected: builds clean. `client_core::proto::cinch::v1::Device` now has the three new fields.

- [ ] **Step 4: Commit**

```bash
git add crates/client-core/proto/cinch/v1/devices.proto go/cinch/v1/devices.pb.go
git commit -m "proto: add client_version, client_type, client_version_at to Device"
```

---

### Task 2: Add `version` helper module

**Files:**
- Create: `crates/client-core/src/version.rs`
- Modify: `crates/client-core/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/client-core/tests/version_helper.rs`:

```rust
use client_core::version::{ClientInfo, ClientType};

#[test]
fn client_type_str_roundtrip() {
    assert_eq!(ClientType::Cli.as_str(), "cli");
    assert_eq!(ClientType::Desktop.as_str(), "desktop");
}

#[test]
fn http_headers_pair_is_typed() {
    let info = ClientInfo {
        client_type: ClientType::Cli,
        version: "0.1.8".to_string(),
    };
    let pairs = info.http_headers();
    assert_eq!(pairs[0].0.as_str(), "x-cinch-client-version");
    assert_eq!(pairs[0].1.to_str().unwrap(), "0.1.8");
    assert_eq!(pairs[1].0.as_str(), "x-cinch-client-type");
    assert_eq!(pairs[1].1.to_str().unwrap(), "cli");
}

#[test]
fn client_hello_message_carries_fields() {
    let info = ClientInfo {
        client_type: ClientType::Desktop,
        version: "0.1.7".to_string(),
    };
    let msg = info.client_hello_message();
    assert_eq!(msg.action, "client_hello");
    let payload = msg.client_hello.expect("payload set");
    assert_eq!(payload.version, "0.1.7");
    assert_eq!(payload.type_, "desktop");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p cinchcli-core --test version_helper`
Expected: FAIL — `module 'version' not found`.

- [ ] **Step 3: Write the helper module**

Create `crates/client-core/src/version.rs`:

```rust
//! Self-version reporting helpers shared by CLI and desktop.
//!
//! Both clients pass their own CARGO_PKG_VERSION (binary-crate level, not
//! cinchcli-core's version) into `ClientInfo` at startup. The resulting
//! struct is consumed by RestClient (HTTP headers) and WsClient (hello).

use reqwest::header::{HeaderName, HeaderValue};

use crate::protocol::{ClientHelloPayload, WSMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientType {
    Cli,
    Desktop,
}

impl ClientType {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientType::Cli => "cli",
            ClientType::Desktop => "desktop",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub client_type: ClientType,
    pub version: String,
}

pub const HEADER_CLIENT_VERSION: &str = "x-cinch-client-version";
pub const HEADER_CLIENT_TYPE: &str = "x-cinch-client-type";

impl ClientInfo {
    pub fn http_headers(&self) -> [(HeaderName, HeaderValue); 2] {
        [
            (
                HeaderName::from_static(HEADER_CLIENT_VERSION),
                HeaderValue::from_str(&self.version).expect("ascii semver"),
            ),
            (
                HeaderName::from_static(HEADER_CLIENT_TYPE),
                HeaderValue::from_static(self.client_type.as_str()),
            ),
        ]
    }

    pub fn client_hello_message(&self) -> WSMessage {
        WSMessage {
            action: "client_hello".to_string(),
            client_hello: Some(ClientHelloPayload {
                version: self.version.clone(),
                type_: self.client_type.as_str().to_string(),
                os: std::env::consts::OS.to_string(),
            }),
            ..Default::default()
        }
    }
}
```

- [ ] **Step 4: Add `ClientHelloPayload` and field to `WSMessage` in `protocol.rs`**

Modify `crates/client-core/src/protocol.rs`. Find the `WSMessage` struct and add the new optional sibling and payload type:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientHelloPayload {
    pub version: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os: String,
}

// inside WSMessage struct, add:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub client_hello: Option<ClientHelloPayload>,
```

(Note: the exact location depends on how `WSMessage` is currently declared — find it and add the field with the other optional siblings. If the struct uses `#[serde(rename_all = "snake_case")]` already, no extra rename is needed for `client_hello`.)

- [ ] **Step 5: Export the module from lib.rs**

Modify `crates/client-core/src/lib.rs`. Add to the module list:

```rust
pub mod version;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p cinchcli-core --test version_helper`
Expected: PASS — all three tests green.

- [ ] **Step 7: Commit**

```bash
git add crates/client-core/src/version.rs crates/client-core/src/lib.rs crates/client-core/src/protocol.rs crates/client-core/tests/version_helper.rs
git commit -m "version: add ClientInfo helper and client_hello WS payload"
```

---

### Task 3: Update wire vectors and round-trip tests

**Files:**
- Modify: `testdata/wire-vectors.json`
- Modify: `crates/client-core/tests/wire_vectors.rs`

- [ ] **Step 1: Read the current wire-vectors structure**

Run: `head -50 testdata/wire-vectors.json`
Expected: JSON with vectors keyed by message type. Find the existing `Device` vector.

- [ ] **Step 2: Add new Device variant with version fields**

Edit `testdata/wire-vectors.json`. Where the existing Device test vector lives, add a second case alongside it:

```json
{
  "name": "Device with version reported",
  "json": {
    "id": "dev_01HX9V1ABCDEF",
    "hostname": "alice-vm",
    "source_key": "remote:alice-vm",
    "clip_count": 0,
    "paired_at": "2026-04-01T12:00:00Z",
    "online": true,
    "nickname": "Linux VM",
    "public_key": "",
    "public_key_fingerprint": "",
    "client_version": "0.1.8",
    "client_type": "cli",
    "client_version_at": "2026-05-18T09:15:30Z"
  }
}
```

Match the surrounding `name` / `json` key convention already in the file. Keep the existing zero-field-set Device vector (it must continue to round-trip without these optional fields present).

- [ ] **Step 3: Add round-trip assertion**

In `crates/client-core/tests/wire_vectors.rs`, find the Device round-trip block and add a new test that decodes the new variant and asserts the new fields are present:

```rust
#[test]
fn device_with_version_fields_roundtrips() {
    let vectors: WireVectors = serde_json::from_str(VECTORS_JSON).unwrap();
    let v = vectors
        .vectors
        .iter()
        .find(|v| v.name == "Device with version reported")
        .expect("vector exists");
    let device: Device = serde_json::from_value(v.json.clone()).unwrap();
    assert_eq!(device.client_version.as_deref(), Some("0.1.8"));
    assert_eq!(device.client_type.as_deref(), Some("cli"));
    assert_eq!(
        device.client_version_at.as_deref(),
        Some("2026-05-18T09:15:30Z")
    );

    // Re-encode and confirm it matches the input json (key-order-insensitive).
    let reencoded = serde_json::to_value(&device).unwrap();
    assert_eq!(reencoded, v.json);
}
```

- [ ] **Step 4: Run Rust round-trip**

Run: `cargo test -p cinchcli-core --test wire_vectors`
Expected: PASS — all existing tests still green, new test green.

- [ ] **Step 5: Run Go round-trip**

Run: `go test ./go/...`
Expected: PASS — Go marshals/unmarshals the new fields too. (The Go-side wire-vectors test reads the same `testdata/wire-vectors.json`.)

- [ ] **Step 6: Commit**

```bash
git add testdata/wire-vectors.json crates/client-core/tests/wire_vectors.rs
git commit -m "wire-vectors: cover Device version fields in Rust + Go round-trip"
```

---

### Task 4: Bump version, publish, tag

**Files:**
- Modify: `crates/client-core/Cargo.toml`

- [ ] **Step 1: Bump version**

Edit `crates/client-core/Cargo.toml` line 3:

```toml
version = "0.1.6"
```

- [ ] **Step 2: Build the whole workspace**

Run: `cargo build --workspace`
Expected: clean.

- [ ] **Step 3: Run all tests**

Run: `cargo test --workspace`
Expected: all green including wire_vectors.

- [ ] **Step 4: Commit the version bump**

```bash
git add crates/client-core/Cargo.toml
git commit -m "release: cinchcli-core 0.1.6"
```

- [ ] **Step 5: Push and create PR for review**

```bash
git push -u origin <branch>
gh pr create --title "Add client version reporting fields to Device" --body "$(cat <<'EOF'
## Summary
- Add `client_version`, `client_type`, `client_version_at` to `Device` proto
- New `client_core::version::ClientInfo` helper for HTTP headers and WS hello
- New WSMessage `client_hello` action

## Test plan
- [x] `cargo test --workspace` green
- [x] `make generate && go test ./go/...` green
- [x] Wire vectors round-trip across Rust and Go

Spec: cinchcli/desktop docs/superpowers/specs/2026-05-18-remote-version-check-design.md
EOF
)"
```

- [ ] **Step 6: After merge, tag and publish**

```bash
git checkout main && git pull
cargo publish -p cinchcli-core
git tag v0.1.6 && git push origin v0.1.6
```

Expected: crates.io shows `cinchcli-core 0.1.6`. **Stop and verify before starting Phase 2.**

---

## Phase 2 — `relay` consumes the new fields

All paths in this phase are relative to `/Users/jinmu/Programming/cinchcli/relay`.

### Task 5: Bump cinch-core dependency

**Files:**
- Modify: `go.mod`
- Modify: `relay/internal/wire_test/testdata/wire-vectors.json`

- [ ] **Step 1: Bump cinch-core**

Run: `make update-cinch-core REV=v0.1.6`
Expected: `go.mod` and `go.sum` updated. `cinchv1.Device` now has `ClientVersion`, `ClientType`, `ClientVersionAt` accessors.

- [ ] **Step 2: Sync wire-vectors copy**

Run: `cp ../cinch-core/testdata/wire-vectors.json internal/wire_test/testdata/wire-vectors.json`
Expected: file is byte-identical to the cinch-core source.

- [ ] **Step 3: Run wire test**

Run: `go test ./internal/wire_test/...`
Expected: PASS — Go round-trips the new Device variant.

- [ ] **Step 4: Commit**

```bash
git add go.mod go.sum internal/wire_test/testdata/wire-vectors.json
git commit -m "deps: bump cinch-core to v0.1.6 for Device version fields"
```

---

### Task 6: Add `WSMessage.ClientHello` envelope field

**Files:**
- Modify: `internal/protocol/ws.go`
- Create: `internal/protocol/ws_client_hello_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/protocol/ws_client_hello_test.go`:

```go
package protocol

import (
	"encoding/json"
	"testing"
)

func TestWSMessage_ClientHello_RoundTrip(t *testing.T) {
	src := WSMessage{
		Action: "client_hello",
		ClientHello: &ClientHelloPayload{
			Version: "0.1.8",
			Type:    "cli",
			OS:      "linux",
		},
	}
	b, err := json.Marshal(src)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got WSMessage
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Action != "client_hello" {
		t.Errorf("action = %q", got.Action)
	}
	if got.ClientHello == nil {
		t.Fatal("client_hello nil after round-trip")
	}
	if got.ClientHello.Version != "0.1.8" || got.ClientHello.Type != "cli" || got.ClientHello.OS != "linux" {
		t.Errorf("payload = %+v", got.ClientHello)
	}
}

func TestWSMessage_ClientHello_OmittedWhenNil(t *testing.T) {
	src := WSMessage{Action: "ping"}
	b, err := json.Marshal(src)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got := string(b); contains(got, "client_hello") {
		t.Errorf("client_hello should be omitted when nil, got %s", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/protocol/ -run ClientHello -v`
Expected: FAIL — `ClientHelloPayload undefined` or `WSMessage has no field ClientHello`.

- [ ] **Step 3: Add the envelope field and payload type**

Edit `internal/protocol/ws.go`. After the existing `WSMessage` field block, add the field (alongside the other optional siblings):

```go
// action="client_hello" — first message after WS auth, carries the
// client_version + client_type for the connecting device.
ClientHello *ClientHelloPayload `json:"client_hello,omitempty"`
```

Then add the payload struct in the same file (near the other payload types):

```go
type ClientHelloPayload struct {
	Version string `json:"version"`           // semver of the binary
	Type    string `json:"type"`              // "cli" | "desktop"
	OS      string `json:"os,omitempty"`      // future hint, unused
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/protocol/ -run ClientHello -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/protocol/ws.go internal/protocol/ws_client_hello_test.go
git commit -m "protocol: add ClientHello payload to WSMessage"
```

---

### Task 7: Add `devices` columns via ALTER TABLE IF NOT EXISTS

**Files:**
- Modify: `internal/relay/store.go:285-310` (existing ALTER TABLE block)

- [ ] **Step 1: Locate the migration block**

Run: `grep -n "ADD COLUMN IF NOT EXISTS" internal/relay/store.go`
Expected: a list of existing ALTER TABLE migrations around lines 285–310.

- [ ] **Step 2: Add three new migrations to the same block**

Edit `internal/relay/store.go`. Add the three statements to the existing migrations slice (or `db.Exec` block — match the existing pattern):

```go
`ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_version TEXT`,
`ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_type TEXT`,
`ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_version_at TIMESTAMPTZ`,
`CREATE INDEX IF NOT EXISTS idx_devices_client_type ON devices(client_type) WHERE client_type IS NOT NULL`,
```

- [ ] **Step 3: Run migration test**

Run: `go test ./internal/relay/ -run TestMigration -v`
Expected: PASS — migration applies cleanly to a fresh DB and to an existing one.

- [ ] **Step 4: Commit**

```bash
git add internal/relay/store.go
git commit -m "store: migrate devices to track client_version/type/version_at"
```

---

### Task 8: Add `UpdateDeviceVersion` store method

**Files:**
- Modify: `internal/relay/store.go`
- Create: `internal/relay/store_version_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/relay/store_version_test.go`:

```go
package relay

import (
	"context"
	"testing"
	"time"
)

func TestUpdateDeviceVersion_Upsert(t *testing.T) {
	store, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	userID := mustCreateUser(t, store)
	devID := mustCreateDevice(t, store, userID, "host", "remote:host")

	if err := store.UpdateDeviceVersion(ctx, devID, "0.1.5", "cli"); err != nil {
		t.Fatalf("first update: %v", err)
	}
	v, ty, _, err := store.GetDeviceVersion(ctx, devID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if v != "0.1.5" || ty != "cli" {
		t.Errorf("first read: got (%q, %q)", v, ty)
	}

	time.Sleep(10 * time.Millisecond) // ensure timestamp differs
	if err := store.UpdateDeviceVersion(ctx, devID, "0.1.8", "cli"); err != nil {
		t.Fatalf("second update: %v", err)
	}
	v, ty, _, err = store.GetDeviceVersion(ctx, devID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if v != "0.1.8" || ty != "cli" {
		t.Errorf("second read: got (%q, %q)", v, ty)
	}
}

func TestUpdateDeviceVersion_InvalidType_Rejected(t *testing.T) {
	store, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()

	userID := mustCreateUser(t, store)
	devID := mustCreateDevice(t, store, userID, "host", "remote:host")

	err := store.UpdateDeviceVersion(ctx, devID, "0.1.5", "chrome")
	if err == nil {
		t.Fatal("expected error for invalid client_type, got nil")
	}
	v, ty, _, _ := store.GetDeviceVersion(ctx, devID)
	if v != "" || ty != "" {
		t.Errorf("columns should be untouched, got (%q, %q)", v, ty)
	}
}
```

Reuse existing helpers `newTestStore`, `mustCreateUser`, `mustCreateDevice` from `relay/internal/relay/relay_test.go` and `store_test.go`. If `mustCreateDevice` does not exist, write a thin wrapper that inserts a row with `INSERT INTO devices (id, user_id, hostname, source_key) VALUES (...)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/relay/ -run TestUpdateDeviceVersion -v`
Expected: FAIL — `UpdateDeviceVersion undefined` and/or `GetDeviceVersion undefined`.

- [ ] **Step 3: Implement the methods**

Add to `internal/relay/store.go` (near the other `Update*` methods):

```go
// UpdateDeviceVersion persists the client_version + client_type for a
// device. clientType must be "cli" or "desktop"; other values return an
// error and leave the row unchanged.
func (s *Store) UpdateDeviceVersion(ctx context.Context, deviceID, version, clientType string) error {
	if clientType != "cli" && clientType != "desktop" {
		return fmt.Errorf("invalid client_type %q", clientType)
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices
		 SET client_version = $1,
		     client_type = $2,
		     client_version_at = NOW()
		 WHERE id = $3`,
		version, clientType, deviceID,
	)
	return err
}

// GetDeviceVersion reads back the three version columns. Returns empty
// strings and zero time if the device exists but has not reported.
func (s *Store) GetDeviceVersion(ctx context.Context, deviceID string) (version, clientType string, reportedAt time.Time, err error) {
	var v, ty sql.NullString
	var ts sql.NullTime
	err = s.db.QueryRowContext(ctx,
		`SELECT client_version, client_type, client_version_at
		 FROM devices WHERE id = $1`,
		deviceID,
	).Scan(&v, &ty, &ts)
	if err != nil {
		return "", "", time.Time{}, err
	}
	return v.String, ty.String, ts.Time, nil
}
```

Make sure `database/sql` and `time` are imported.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/relay/ -run TestUpdateDeviceVersion -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/relay/store.go internal/relay/store_version_test.go
git commit -m "store: add UpdateDeviceVersion and GetDeviceVersion"
```

---

### Task 9: Hub dispatches `client_hello`

**Files:**
- Modify: `internal/relay/hub.go`
- Create: `internal/relay/hub_client_hello_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/relay/hub_client_hello_test.go`. Use the existing WS test harness (look in `hub_event_test.go` or `relay_test.go` for `newTestHub` / `dialWS` helpers):

```go
package relay

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/cinchcli/relay/internal/protocol"
)

func TestHub_ClientHello_PersistsVersion(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()

	userID, deviceID, token := mustPairTestDevice(t, srv)

	conn := dialWS(t, srv, token)
	defer conn.Close()

	hello := protocol.WSMessage{
		Action: "client_hello",
		ClientHello: &protocol.ClientHelloPayload{
			Version: "0.1.8",
			Type:    "cli",
		},
	}
	b, _ := json.Marshal(hello)
	if err := conn.WriteMessage(1, b); err != nil { // 1 = TextMessage
		t.Fatalf("write hello: %v", err)
	}

	// Allow async persistence.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		v, ty, _, _ := srv.store.GetDeviceVersion(t.Context(), deviceID)
		if v == "0.1.8" && ty == "cli" {
			return // success
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device %s version not persisted (user=%s)", deviceID, userID)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/relay/ -run TestHub_ClientHello_PersistsVersion -v`
Expected: FAIL — hub does not dispatch `client_hello` yet.

- [ ] **Step 3: Add the dispatch in `hub.go`**

Find the WS receive loop in `internal/relay/hub.go` (the function that decodes incoming `WSMessage` and switches on `msg.Action`). Add a case before the default:

```go
case "client_hello":
    if msg.ClientHello == nil {
        continue
    }
    go func(deviceID, version, clientType string) {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := h.store.UpdateDeviceVersion(ctx, deviceID, version, clientType); err != nil {
            log.Printf("hub: update device version failed for %s: %v", deviceID, err)
        }
    }(client.deviceID, msg.ClientHello.Version, msg.ClientHello.Type)
    continue
```

(Adjust the closure variable names to match the existing loop's variable for the current connection's device ID.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/relay/ -run TestHub_ClientHello_PersistsVersion -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/relay/hub.go internal/relay/hub_client_hello_test.go
git commit -m "hub: persist device version from WS client_hello action"
```

---

### Task 10: HTTP middleware reads version headers

**Files:**
- Modify: `internal/relay/handler.go` (or wherever auth middleware lives)
- Create: `internal/relay/middleware_version_test.go`

- [ ] **Step 1: Locate the auth middleware**

Run: `grep -rn "func.*Middleware\|http.Handler.*auth\|Bearer " internal/relay/ | head -5`
Expected: find the function that wraps authenticated routes (likely in `handler.go` or a dedicated `auth_middleware.go`).

- [ ] **Step 2: Write the failing test**

Create `internal/relay/middleware_version_test.go`:

```go
package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestVersionHeaders_PersistOnAuthedRequest(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	_, deviceID, token := mustPairTestDevice(t, srv)

	req := httptest.NewRequest(http.MethodGet, srv.URL+"/devices", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Cinch-Client-Version", "0.1.8")
	req.Header.Set("X-Cinch-Client-Type", "cli")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		v, ty, _, _ := srv.store.GetDeviceVersion(context.Background(), deviceID)
		if v == "0.1.8" && ty == "cli" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("version not persisted from headers")
}

func TestVersionHeaders_MissingHeaders_NoUpdate(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	_, deviceID, token := mustPairTestDevice(t, srv)

	req := httptest.NewRequest(http.MethodGet, srv.URL+"/devices", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	v, ty, _, _ := srv.store.GetDeviceVersion(context.Background(), deviceID)
	if v != "" || ty != "" {
		t.Errorf("columns should remain empty; got (%q, %q)", v, ty)
	}
}

func TestVersionHeaders_InvalidType_NoUpdate(t *testing.T) {
	srv, cleanup := newTestServer(t)
	defer cleanup()
	_, deviceID, token := mustPairTestDevice(t, srv)

	req := httptest.NewRequest(http.MethodGet, srv.URL+"/devices", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Cinch-Client-Version", "0.1.8")
	req.Header.Set("X-Cinch-Client-Type", "chrome")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp.Body.Close()

	v, ty, _, _ := srv.store.GetDeviceVersion(context.Background(), deviceID)
	if v != "" || ty != "" {
		t.Errorf("invalid type should be rejected; got (%q, %q)", v, ty)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/relay/ -run TestVersionHeaders -v`
Expected: FAIL — no header-based persistence yet.

- [ ] **Step 4: Add the header capture in the auth middleware**

In the authenticated-request middleware (the function that resolves `Authorization: Bearer` into a `deviceID`), after a successful auth lookup, before calling the wrapped handler:

```go
if v := r.Header.Get("X-Cinch-Client-Version"); v != "" {
    if ty := r.Header.Get("X-Cinch-Client-Type"); ty == "cli" || ty == "desktop" {
        go func(devID, version, clientType string) {
            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()
            _ = h.store.UpdateDeviceVersion(ctx, devID, version, clientType)
        }(deviceID, v, ty)
    }
}
```

(`h` is the handler struct holding the store. Adjust to actual field names.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/relay/ -run TestVersionHeaders -v`
Expected: PASS (all three subtests).

- [ ] **Step 6: Commit**

```bash
git add internal/relay/handler.go internal/relay/middleware_version_test.go
git commit -m "middleware: persist device version from X-Cinch-Client-* headers"
```

---

### Task 11: Surface fields via `ListDevices`

**Files:**
- Modify: `internal/relay/connect_devices.go`

- [ ] **Step 1: Find the Device proto mapping**

Run: `grep -n "cinchv1.Device{" internal/relay/connect_devices.go`
Expected: a function that constructs `cinchv1.Device` from store rows.

- [ ] **Step 2: Extend the SQL select to include new columns and map them**

In the SELECT statement, add `client_version, client_type, client_version_at`. In the Scan target, add three `sql.NullString` / `sql.NullTime`. In the response construction:

```go
dev := &cinchv1.Device{
    Id:                   row.id,
    Hostname:             row.hostname,
    // ... existing fields ...
}
if row.clientVersion.Valid {
    cv := row.clientVersion.String
    dev.ClientVersion = &cv
}
if row.clientType.Valid {
    ct := row.clientType.String
    dev.ClientType = &ct
}
if row.clientVersionAt.Valid {
    ts := row.clientVersionAt.Time.UTC().Format(time.RFC3339)
    dev.ClientVersionAt = &ts
}
```

- [ ] **Step 3: Update or add a test in `connect_devices_test.go`**

Locate or create `internal/relay/connect_devices_test.go`. Add:

```go
func TestListDevices_IncludesVersionFields(t *testing.T) {
    srv, cleanup := newTestServer(t)
    defer cleanup()
    _, deviceID, token := mustPairTestDevice(t, srv)

    if err := srv.store.UpdateDeviceVersion(t.Context(), deviceID, "0.1.8", "cli"); err != nil {
        t.Fatalf("update: %v", err)
    }

    client := newDevicesClient(t, srv, token)
    resp, err := client.ListDevices(t.Context(), connect.NewRequest(&cinchv1.ListDevicesRequest{}))
    if err != nil {
        t.Fatalf("list: %v", err)
    }
    var found *cinchv1.Device
    for _, d := range resp.Msg.Devices {
        if d.Id == deviceID {
            found = d
        }
    }
    if found == nil {
        t.Fatal("device not in response")
    }
    if got := found.ClientVersion; got == nil || *got != "0.1.8" {
        t.Errorf("client_version = %v, want 0.1.8", got)
    }
    if got := found.ClientType; got == nil || *got != "cli" {
        t.Errorf("client_type = %v, want cli", got)
    }
    if found.ClientVersionAt == nil {
        t.Error("client_version_at should be set")
    }
}
```

`newDevicesClient` is an existing helper in `connect_devices_test.go` (or analogous to the way `connect_clips_test.go` builds the test client).

- [ ] **Step 4: Run the test**

Run: `go test ./internal/relay/ -run TestListDevices -v`
Expected: PASS.

- [ ] **Step 5: Run all relay tests**

Run: `make test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add internal/relay/connect_devices.go internal/relay/connect_devices_test.go
git commit -m "connect_devices: include client_version fields in ListDevices"
```

---

### Task 12: Push and PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin <branch>
gh pr create --title "Relay: persist and surface device client versions" --body "$(cat <<'EOF'
## Summary
- Migrate `devices` to add `client_version`, `client_type`, `client_version_at`
- Persist via WS `client_hello` and `X-Cinch-Client-*` HTTP headers
- Return new fields from `ListDevices`

## Test plan
- [x] `make test` green
- [x] Wire vectors sync with cinch-core

Spec: cinchcli/desktop docs/superpowers/specs/2026-05-18-remote-version-check-design.md
EOF
)"
```

Expected: PR opened. Wait for CI and merge before starting Phase 3 or 4 (they need the deployed relay to validate end-to-end manually, but their unit tests can run earlier in parallel against cinch-core 0.1.6).

---

## Phase 3 — `cinch` CLI

All paths in this phase are relative to `/Users/jinmu/Programming/cinchcli/cinch`.

### Task 13: Bump cinch-core dependency

**Files:**
- Modify: `crates/cli/Cargo.toml`

- [ ] **Step 1: Bump dep**

Edit `crates/cli/Cargo.toml` line 14:

```toml
client-core = { package = "cinchcli-core", version = "0.1.6" }
```

- [ ] **Step 2: Resolve**

Run: `cargo update -p cinchcli-core`
Expected: `Cargo.lock` updated to 0.1.6.

- [ ] **Step 3: Build**

Run: `cargo build -p cinch-cli`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add crates/cli/Cargo.toml Cargo.lock
git commit -m "deps: bump cinchcli-core to 0.1.6"
```

---

### Task 14: Plumb `ClientInfo` into `RestClient` and WS client

**Files:**
- Modify: `cinch-core/crates/client-core/src/http.rs` (Phase 1 follow-up — bump to 0.1.7 if not already done)
- Modify: `cinch-core/crates/client-core/src/ws.rs`

> **If the engineer reaches this task and headers are not yet plumbed in cinch-core**: do a small Phase 1 follow-up in cinch-core that adds a `with_client_info` constructor to `RestClient` and `WsConfig`, publish 0.1.7, then come back to bump consumers. The cleanest order is to ship plumbing in cinch-core itself.

In cinch-core:

- [ ] **Step 1: Extend `RestClient::new` to accept `ClientInfo`**

Modify `crates/client-core/src/http.rs:65`:

```rust
pub fn new(
    relay_url: impl Into<String>,
    token: impl Into<String>,
    client_info: crate::version::ClientInfo,
) -> Result<Self, HttpError> {
    let base = relay_url.into().trim_end_matches('/').to_string();
    let mut headers = HeaderMap::new();
    for (k, v) in client_info.http_headers() {
        headers.insert(k, v);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .default_headers(headers)
        .build()
        .map_err(|e| HttpError::Build(e.to_string()))?;
    Ok(Self { base_url: base, token: token.into(), client })
}
```

Import `reqwest::header::HeaderMap` at the top of the file.

- [ ] **Step 2: Extend `WsConfig` (or equivalent) with `client_info`**

Find the WS connect path in `crates/client-core/src/ws.rs:81` (`WsConfig` struct). Add:

```rust
pub client_info: crate::version::ClientInfo,
```

Find the spot just after a successful auth/connect upgrade where the loop starts. Before reading any inbound message, send the hello:

```rust
let hello = config.client_info.client_hello_message();
let payload = serde_json::to_string(&hello).expect("hello serializes");
sink.send(Message::Text(payload)).await?;
```

(Use whatever sink/writer the existing code holds onto.)

- [ ] **Step 3: Update existing tests in cinch-core to pass `ClientInfo`**

All call sites of `RestClient::new` in the cinch-core integration tests must now pass a `ClientInfo`. Use a test helper:

```rust
fn test_client_info() -> ClientInfo {
    ClientInfo { client_type: ClientType::Cli, version: "0.0.0-test".to_string() }
}
```

- [ ] **Step 4: Bump cinch-core to 0.1.7 and publish**

Same as Task 4 but bumping to 0.1.7. After publish, return here and bump the CLI's `cinchcli-core` dep to 0.1.7.

In cinch (after cinch-core 0.1.7 is on crates.io):

- [ ] **Step 5: Bump CLI dep to 0.1.7 and update construction sites**

Run: `cargo update -p cinchcli-core`. Then edit every `RestClient::new(relay_url, token)` call in `cinch/crates/cli/src/` to pass `ClientInfo`. Wire it from `main.rs`:

```rust
use client_core::version::{ClientInfo, ClientType};

fn build_client_info() -> ClientInfo {
    ClientInfo {
        client_type: ClientType::Cli,
        version: env!("CARGO_PKG_VERSION").to_string(), // 0.1.8 — the cinch-cli crate, NOT cinch-core
    }
}
```

Pass `build_client_info()` everywhere `RestClient::new` is called.

- [ ] **Step 6: Run tests**

Run: `cargo test --workspace`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock crates/cli/src
git commit -m "client_info: send version + type on every HTTP request and WS hello"
```

---

### Task 15: Create `update_check.rs` with cache + GH fetch

**Files:**
- Create: `crates/cli/src/update_check.rs`
- Modify: `crates/cli/src/main.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cli/src/update_check.rs` with embedded tests at the bottom:

```rust
//! Self-version nudge for the CLI.
//!
//! Caches the latest GitHub release tag per client_type in
//! `dirs::cache_dir()/cinch/version-cache.json` with a 6h TTL. Reads are
//! synchronous; refreshes spawn a detached tokio task that never blocks
//! the calling command.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const GH_LATEST_CLI: &str = "https://api.github.com/repos/cinchcli/cinch/releases/latest";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionCache {
    pub cli_latest: Option<String>,
    pub cli_fetched_at: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy)]
pub enum Status {
    UpToDate,
    Outdated { latest: &'static str },
    Unknown,
}

pub fn cache_path() -> PathBuf {
    dirs::cache_dir()
        .map(|d| d.join("cinch").join("version-cache.json"))
        .unwrap_or_else(|| PathBuf::from(".cinch-version-cache.json"))
}

fn load_cache() -> VersionCache {
    let path = cache_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_cache(c: &VersionCache) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(c) {
        let _ = std::fs::write(path, s);
    }
}

fn is_stale(at: Option<SystemTime>) -> bool {
    match at {
        None => true,
        Some(t) => SystemTime::now()
            .duration_since(t)
            .map(|d| d > CACHE_TTL)
            .unwrap_or(true),
    }
}

pub fn check_self_outdated(own_version: &str) -> Option<String> {
    if std::env::var("CINCH_NO_UPDATE_NUDGE").is_ok() {
        return None;
    }
    if !atty::is(atty::Stream::Stderr) {
        return None;
    }
    let cache = load_cache();
    if is_stale(cache.cli_fetched_at) {
        // Fire-and-forget refresh; do not block the current command.
        tokio::spawn(refresh());
    }
    let latest = cache.cli_latest?;
    let ours = semver::Version::parse(own_version).ok()?;
    let target = semver::Version::parse(latest.trim_start_matches('v')).ok()?;
    if ours < target { Some(latest) } else { None }
}

pub async fn refresh() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("cinch-cli/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .ok();
    let Some(client) = client else { return };
    let Ok(resp) = client.get(GH_LATEST_CLI).send().await else { return };
    let Ok(body) = resp.json::<serde_json::Value>().await else { return };
    let Some(tag) = body.get("tag_name").and_then(|v| v.as_str()) else { return };
    let mut cache = load_cache();
    cache.cli_latest = Some(tag.to_string());
    cache.cli_fetched_at = Some(SystemTime::now());
    write_cache(&cache);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_stale_when_no_timestamp() {
        assert!(is_stale(None));
    }

    #[test]
    fn is_stale_when_older_than_ttl() {
        let old = SystemTime::now() - Duration::from_secs(7 * 3600);
        assert!(is_stale(Some(old)));
    }

    #[test]
    fn is_fresh_when_within_ttl() {
        let recent = SystemTime::now() - Duration::from_secs(60);
        assert!(!is_stale(Some(recent)));
    }
}
```

- [ ] **Step 2: Add deps if missing**

Verify `crates/cli/Cargo.toml` has `semver`, `reqwest`, `serde`, `serde_json`, `dirs`, `atty`. Add any missing one:

```toml
semver = "1"
dirs = "5"
atty = "0.2"
```

- [ ] **Step 3: Run the inline tests**

Run: `cargo test -p cinch-cli update_check`
Expected: PASS (3 tests).

- [ ] **Step 4: Wire nudge into exit path in `main.rs`**

Modify `crates/cli/src/main.rs`. Find where the program exits normally (the end of `main()` or the result-handling block). Right before exit:

```rust
mod update_check;

// ... in main, just before returning Ok(()) ...
if let Some(latest) = update_check::check_self_outdated(env!("CARGO_PKG_VERSION")) {
    eprintln!(
        "cinch v{} — {} available, run `brew upgrade cinch`",
        env!("CARGO_PKG_VERSION"),
        latest
    );
}
```

Make sure this runs on the *successful exit* path. Also on error paths if you want the nudge to fire there (optional).

- [ ] **Step 5: Build and smoke-test**

Run: `cargo build -p cinch-cli && CINCH_NO_UPDATE_NUDGE=1 target/debug/cinch --help`
Expected: builds clean, runs, no nudge with the env var set.

- [ ] **Step 6: Commit**

```bash
git add crates/cli/src/update_check.rs crates/cli/src/main.rs crates/cli/Cargo.toml Cargo.lock
git commit -m "cli: nudge user on stderr when own version is outdated"
```

---

### Task 16: Show device versions in `cinch auth status`

**Files:**
- Modify: `crates/cli/src/commands/auth.rs`

- [ ] **Step 1: Locate the status command output**

Run: `grep -n "fn run_status\|fn print_devices\|paired_at" crates/cli/src/commands/auth.rs`
Expected: finds the function that renders the device list for `cinch auth status`.

- [ ] **Step 2: Add a `Version` column**

Modify the table renderer (or println loop) to include a new column. For each `Device`:

```rust
let version_cell = match device.client_version.as_deref() {
    Some(v) if !v.is_empty() => {
        let outdated = compare_outdated(v, &latest_cli);
        if outdated { format!("{} (outdated)", v) } else { v.to_string() }
    }
    _ => "—".to_string(),
};
```

Where `latest_cli` is the cached value from `update_check::load_cache()` (expose a public getter `pub fn cached_cli_latest() -> Option<String>` in `update_check.rs`). `compare_outdated` is a small helper:

```rust
fn compare_outdated(reported: &str, latest: &Option<String>) -> bool {
    let Some(latest) = latest else { return false };
    let Ok(a) = semver::Version::parse(reported) else { return false };
    let Ok(b) = semver::Version::parse(latest.trim_start_matches('v')) else { return false };
    a < b
}
```

- [ ] **Step 3: Manual smoke**

After bumping a remote device's `client_version` in the DB to `0.1.5`:

```bash
cargo run -p cinch-cli -- auth status
```

Expected: that device shows `0.1.5 (outdated)` in the version column.

- [ ] **Step 4: Commit**

```bash
git add crates/cli/src/commands/auth.rs
git commit -m "auth status: show per-device version with outdated marker"
```

---

### Task 17: Phase 3 PR

- [ ] **Step 1: Push and PR**

```bash
git push -u origin <branch>
gh pr create --title "CLI: report version on wire, nudge on stderr, show in auth status" --body "$(cat <<'EOF'
## Summary
- Plumb ClientInfo into RestClient + WsClient (HTTP headers + WS hello)
- Add update_check.rs with 6h cache + stderr nudge
- Show per-device version (with outdated marker) in `cinch auth status`

## Test plan
- [x] `cargo test --workspace` green
- [x] Manual: `cinch auth status` against staging relay shows versions

Spec: cinchcli/desktop docs/superpowers/specs/2026-05-18-remote-version-check-design.md
EOF
)"
```

---

## Phase 4 — `desktop`

All paths in this phase are relative to `/Users/jinmu/Programming/cinchcli/desktop`.

### Task 18: Bump cinch-core and wire ClientInfo

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: every `RestClient::new` / `WsConfig` construction site in `src-tauri/src/`

- [ ] **Step 1: Bump dep**

Edit `src-tauri/Cargo.toml` line 20 to `version = "0.1.7", features = ["specta"]`. Run `cargo update -p cinchcli-core`.

- [ ] **Step 2: Build to see compile errors**

Run: `cd src-tauri && cargo build`
Expected: errors at `RestClient::new` and `WsConfig` construction sites (signature changed).

- [ ] **Step 3: Add a helper that builds ClientInfo**

In `src-tauri/src/lib.rs` (top-level so commands can reach it), add:

```rust
fn build_client_info() -> client_core::version::ClientInfo {
    client_core::version::ClientInfo {
        client_type: client_core::version::ClientType::Desktop,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}
```

- [ ] **Step 4: Pass ClientInfo at every construction site**

For each compile error, pass `build_client_info()` (or a clone) as the new argument.

- [ ] **Step 5: Build and run tauri-specta export**

Run: `cargo build && cargo test export_bindings -- --ignored`
Expected: clean build, `src/bindings.ts` regenerates (no shape change yet — just dep bump).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src src/bindings.ts
git commit -m "deps: bump cinchcli-core to 0.1.7, plumb ClientInfo"
```

---

### Task 19: GitHub fetcher and version-comparison commands

**Files:**
- Create: `src-tauri/src/update_check.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Write the comparison test first**

Create `src-tauri/src/update_check.rs` with the comparison function and its tests:

```rust
//! GitHub Releases fetcher and per-device outdated comparison.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const GH_CLI: &str = "https://api.github.com/repos/cinchcli/cinch/releases/latest";
const GH_DESKTOP: &str = "https://api.github.com/repos/cinchcli/desktop/releases/latest";

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct LatestVersions {
    pub cli: Option<String>,
    pub desktop: Option<String>,
    pub fetched_at: Option<u64>, // unix seconds
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub enum VersionStatus {
    UpToDate,
    Outdated,
    Unknown,
}

pub fn compare(reported: Option<&str>, client_type: Option<&str>, latest: &LatestVersions) -> VersionStatus {
    let (Some(reported), Some(ct)) = (reported, client_type) else {
        return VersionStatus::Unknown;
    };
    let target = match ct {
        "cli" => latest.cli.as_deref(),
        "desktop" => latest.desktop.as_deref(),
        _ => return VersionStatus::Unknown,
    };
    let Some(target) = target else { return VersionStatus::Unknown };
    let Ok(a) = semver::Version::parse(reported) else { return VersionStatus::Unknown };
    let Ok(b) = semver::Version::parse(target.trim_start_matches('v')) else {
        return VersionStatus::Unknown;
    };
    if a < b { VersionStatus::Outdated } else { VersionStatus::UpToDate }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn latest(cli: &str, desktop: &str) -> LatestVersions {
        LatestVersions {
            cli: Some(cli.to_string()),
            desktop: Some(desktop.to_string()),
            fetched_at: None,
        }
    }
    #[test]
    fn cli_up_to_date() {
        assert!(matches!(compare(Some("0.1.8"), Some("cli"), &latest("v0.1.8", "v0.1.7")), VersionStatus::UpToDate));
    }
    #[test]
    fn cli_outdated() {
        assert!(matches!(compare(Some("0.1.5"), Some("cli"), &latest("v0.1.8", "v0.1.7")), VersionStatus::Outdated));
    }
    #[test]
    fn missing_reported_is_unknown() {
        assert!(matches!(compare(None, Some("cli"), &latest("v0.1.8", "v0.1.7")), VersionStatus::Unknown));
    }
    #[test]
    fn unknown_client_type() {
        assert!(matches!(compare(Some("0.1.5"), Some("chrome"), &latest("v0.1.8", "v0.1.7")), VersionStatus::Unknown));
    }
    #[test]
    fn dirty_semver_is_unknown() {
        assert!(matches!(compare(Some("0.1.5-dirty+abc"), Some("cli"), &latest("v0.1.8", "v0.1.7")), VersionStatus::Unknown));
    }
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml update_check`
Expected: 5 tests pass.

- [ ] **Step 3: Add the fetcher + cache I/O**

Append to `src-tauri/src/update_check.rs`:

```rust
fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("version-cache.json"))
}

pub fn load_cache(app: &tauri::AppHandle) -> LatestVersions {
    cache_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_cache(app: &tauri::AppHandle, v: &LatestVersions) {
    if let Some(p) = cache_path(app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string_pretty(v) {
            let _ = std::fs::write(p, s);
        }
    }
}

fn is_stale(v: &LatestVersions) -> bool {
    let Some(at) = v.fetched_at else { return true };
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now.saturating_sub(at) > CACHE_TTL.as_secs()
}

pub async fn fetch_and_cache(app: tauri::AppHandle) -> LatestVersions {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("cinch-desktop/{}", env!("CARGO_PKG_VERSION")))
        .build();
    let Ok(client) = client else { return load_cache(&app) };

    let cli = fetch_one(&client, GH_CLI).await;
    let desktop = fetch_one(&client, GH_DESKTOP).await;

    let mut current = load_cache(&app);
    if let Some(v) = cli { current.cli = Some(v); }
    if let Some(v) = desktop { current.desktop = Some(v); }
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    current.fetched_at = Some(now);
    write_cache(&app, &current);
    current
}

async fn fetch_one(client: &reqwest::Client, url: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    let body = resp.json::<serde_json::Value>().await.ok()?;
    body.get("tag_name").and_then(|v| v.as_str()).map(|s| s.to_string())
}
```

- [ ] **Step 4: Add Tauri commands**

Create `src-tauri/src/commands/updater.rs`:

```rust
use crate::update_check::{compare, fetch_and_cache, load_cache, LatestVersions, VersionStatus};

#[tauri::command]
#[specta::specta]
pub async fn get_latest_versions(app: tauri::AppHandle) -> LatestVersions {
    let cache = load_cache(&app);
    if crate::update_check::is_stale_pub(&cache) {
        // Don't await — refresh in the background and return cache now.
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let updated = fetch_and_cache(app2.clone()).await;
            let _ = crate::events::LatestVersionsUpdated(updated).emit(&app2);
        });
    }
    cache
}

#[tauri::command]
#[specta::specta]
pub fn get_device_version_status(
    reported: Option<String>,
    client_type: Option<String>,
    latest: LatestVersions,
) -> VersionStatus {
    compare(reported.as_deref(), client_type.as_deref(), &latest)
}
```

Expose `is_stale_pub` in `update_check.rs`:

```rust
pub fn is_stale_pub(v: &LatestVersions) -> bool { is_stale(v) }
```

Register the new module in `src-tauri/src/commands/mod.rs`:

```rust
pub mod updater;
```

- [ ] **Step 5: Add the `LatestVersionsUpdated` event**

Modify `src-tauri/src/events.rs`. Add:

```rust
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct LatestVersionsUpdated(pub crate::update_check::LatestVersions);
```

- [ ] **Step 6: Add the self-update command**

Append to `src-tauri/src/commands/updater.rs`:

```rust
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
#[specta::specta]
pub async fn run_self_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(()) };
    update
        .download_and_install(|_| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 7: Register the new commands and event in `lib.rs`**

Modify `src-tauri/src/lib.rs:51` — add three lines to `collect_commands![...]`:

```rust
commands::updater::get_latest_versions,
commands::updater::get_device_version_status,
commands::updater::run_self_update,
```

And to `collect_events![...]`:

```rust
events::LatestVersionsUpdated,
```

Also add the module declaration near the top of `lib.rs`:

```rust
mod update_check;
```

- [ ] **Step 8: Add a background refresh on app start**

In `lib.rs` after `tauri::Builder::default()`, in the `setup` closure, spawn the periodic task:

```rust
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    loop {
        let updated = crate::update_check::fetch_and_cache(app_handle.clone()).await;
        let _ = crate::events::LatestVersionsUpdated(updated).emit(&app_handle);
        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
    }
});
```

- [ ] **Step 9: Regenerate bindings**

Run: `cd src-tauri && cargo test export_bindings -- --ignored`
Expected: `src/bindings.ts` now exposes `commands.getLatestVersions`, `commands.getDeviceVersionStatus`, `commands.runSelfUpdate`, and event `events.latestVersionsUpdated`.

- [ ] **Step 10: Send WS hello after auth**

Modify `src-tauri/src/ws.rs` (or wherever the WS client's auth-success callback lives). After the auth handshake completes, send:

```rust
let hello = build_client_info().client_hello_message();
let payload = serde_json::to_string(&hello).expect("hello serializes");
sink.send(Message::Text(payload)).await.ok();
```

If `WsConfig::client_info` is already plumbed from Task 18, this happens automatically inside cinch-core's WS — skip this step.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/update_check.rs src-tauri/src/commands/updater.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/events.rs src/bindings.ts
git commit -m "updater: fetch GH latest, expose compare + self-update commands"
```

---

### Task 20: TypeScript hook for latest versions

**Files:**
- Create: `src/state/versions.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useState } from "react";
import { commands, events, LatestVersions } from "../bindings";

export function useLatestVersions(): LatestVersions {
  const [latest, setLatest] = useState<LatestVersions>({
    cli: null,
    desktop: null,
    fetched_at: null,
  });

  useEffect(() => {
    let mounted = true;
    commands.getLatestVersions().then((v) => {
      if (mounted) setLatest(v);
    });
    const unsub = events.latestVersionsUpdated.listen((e) => {
      if (mounted) setLatest(e.payload[0]);
    });
    return () => {
      mounted = false;
      unsub.then((fn) => fn());
    };
  }, []);

  return latest;
}
```

(Adjust import path to match the actual `bindings.ts` shape — `LatestVersions` is regenerated by tauri-specta.)

- [ ] **Step 2: Smoke compile**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/state/versions.ts
git commit -m "state: useLatestVersions hook subscribes to bindings event"
```

---

### Task 21: `DeviceVersionBadge` component

**Files:**
- Create: `src/components/DeviceVersionBadge.tsx`
- Create: `src/components/DeviceVersionBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceVersionBadge } from "./DeviceVersionBadge";

vi.mock("../bindings", () => ({
  commands: {
    getDeviceVersionStatus: vi.fn(async (_r, _t, _l) => "Outdated"),
  },
}));

describe("DeviceVersionBadge", () => {
  it("renders em dash when version unknown", () => {
    render(<DeviceVersionBadge version={null} clientType={null} latest={{ cli: null, desktop: null, fetched_at: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders version with outdated marker", async () => {
    render(
      <DeviceVersionBadge
        version="0.1.5"
        clientType="cli"
        latest={{ cli: "v0.1.8", desktop: null, fetched_at: 0 }}
      />,
    );
    expect(await screen.findByText(/0\.1\.5/)).toBeInTheDocument();
    expect(await screen.findByLabelText(/outdated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- DeviceVersionBadge`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

```tsx
import { useEffect, useState } from "react";
import { commands, LatestVersions, VersionStatus } from "../bindings";
import { C } from "../design";

interface Props {
  version: string | null;
  clientType: string | null;
  latest: LatestVersions;
}

export function DeviceVersionBadge({ version, clientType, latest }: Props) {
  const [status, setStatus] = useState<VersionStatus>("Unknown");

  useEffect(() => {
    if (!version || !clientType) {
      setStatus("Unknown");
      return;
    }
    commands.getDeviceVersionStatus(version, clientType, latest).then(setStatus);
  }, [version, clientType, latest]);

  if (!version) {
    return <span style={{ color: C.t3 }}>—</span>;
  }

  const dot =
    status === "UpToDate" ? C.success : status === "Outdated" ? C.warning : C.t3;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        aria-label={status === "Outdated" ? "outdated" : status === "UpToDate" ? "up to date" : "unknown"}
        style={{ width: 8, height: 8, borderRadius: "50%", background: dot }}
      />
      <span>{version}</span>
    </span>
  );
}
```

If `C.success` / `C.warning` aren't on the design palette, use literal `#16a34a` / `#f59e0b` instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- DeviceVersionBadge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/DeviceVersionBadge.tsx src/components/DeviceVersionBadge.test.tsx
git commit -m "components: DeviceVersionBadge renders version with status dot"
```

---

### Task 22: `DeviceUpdateAction` component

**Files:**
- Create: `src/components/DeviceUpdateAction.tsx`
- Create: `src/components/DeviceUpdateAction.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceUpdateAction } from "./DeviceUpdateAction";

const runSelfUpdate = vi.fn(async () => undefined);
vi.mock("../bindings", () => ({
  commands: { runSelfUpdate },
}));

describe("DeviceUpdateAction", () => {
  it("renders nothing when status is up to date", () => {
    const { container } = render(
      <DeviceUpdateAction
        status="UpToDate"
        isOwnDesktop={true}
        clientType="desktop"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders Update button for own outdated desktop and triggers self-update", () => {
    render(
      <DeviceUpdateAction
        status="Outdated"
        isOwnDesktop={true}
        clientType="desktop"
      />,
    );
    const btn = screen.getByRole("button", { name: /update/i });
    fireEvent.click(btn);
    expect(runSelfUpdate).toHaveBeenCalledTimes(1);
  });

  it("renders How-to-update link for other outdated devices", () => {
    render(
      <DeviceUpdateAction
        status="Outdated"
        isOwnDesktop={false}
        clientType="cli"
      />,
    );
    const link = screen.getByRole("link", { name: /how to update/i });
    expect(link).toHaveAttribute("href", "https://cinchcli.com/docs/update#cli");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- DeviceUpdateAction`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

```tsx
import { commands, VersionStatus } from "../bindings";

interface Props {
  status: VersionStatus;
  isOwnDesktop: boolean;
  clientType: string | null;
}

export function DeviceUpdateAction({ status, isOwnDesktop, clientType }: Props) {
  if (status !== "Outdated") return null;

  if (isOwnDesktop) {
    return (
      <button onClick={() => commands.runSelfUpdate()} style={{ /* style per design */ }}>
        Update
      </button>
    );
  }

  const anchor = clientType ?? "cli";
  return (
    <a
      href={`https://cinchcli.com/docs/update#${anchor}`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ /* link style */ }}
    >
      How to update
    </a>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- DeviceUpdateAction`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/DeviceUpdateAction.tsx src/components/DeviceUpdateAction.test.tsx
git commit -m "components: DeviceUpdateAction handles self-update and docs link"
```

---

### Task 23: Wire badges + actions into `DevicesPanel`

**Files:**
- Modify: `src/components/DevicesPanel.tsx`
- Modify: `src/components/DevicesPanel.test.tsx`

- [ ] **Step 1: Read current DevicesPanel structure**

Run: `head -80 src/components/DevicesPanel.tsx`
Expected: a render of the device list; each row currently shows hostname, nickname, online status.

- [ ] **Step 2: Identify own-device detection**

Search for an existing helper that says "this row is my desktop." If none, derive it from the local config: the desktop's own device ID lives in `client_core::config` and is exposed via a command. If exposing one doesn't already exist, add a thin `commands::clips::get_own_device_id` and use it here.

- [ ] **Step 3: Embed the new components**

Inside each row's JSX:

```tsx
<DeviceVersionBadge
  version={device.client_version ?? null}
  clientType={device.client_type ?? null}
  latest={latest}
/>
<DeviceUpdateAction
  status={status}
  isOwnDesktop={device.id === ownDeviceId && device.client_type === "desktop"}
  clientType={device.client_type ?? null}
/>
```

Resolve `status` for the row by calling `commands.getDeviceVersionStatus(device.client_version ?? null, device.client_type ?? null, latest)` — or compute once and pass via prop. The simplest: a `useDeviceStatuses(devices, latest)` hook that returns a `Record<string, VersionStatus>`.

- [ ] **Step 4: Update existing tests**

Modify `DevicesPanel.test.tsx`. Mock `useLatestVersions` to return a known latest, mock `commands.getDeviceVersionStatus` to return `"Outdated"` for one device, then assert the badge and action render.

- [ ] **Step 5: Run all desktop tests**

Run: `npm test`
Expected: all 126+ tests green plus new ones.

- [ ] **Step 6: Commit**

```bash
git add src/components/DevicesPanel.tsx src/components/DevicesPanel.test.tsx
git commit -m "DevicesPanel: render version badge and update action per row"
```

---

### Task 24: Phase 4 PR

- [ ] **Step 1: Push and PR**

```bash
git push -u origin <branch>
gh pr create --title "Desktop: device version badges and self-update button" --body "$(cat <<'EOF'
## Summary
- Plumb ClientInfo into cinch-core HTTP + WS (via 0.1.7 bump)
- Fetch GH latest for cli + desktop every 6h, cache locally
- Show per-device version badge in DevicesPanel
- "Update" button (own outdated desktop) triggers tauri-plugin-updater
- "How to update" link (other outdated devices)

## Test plan
- [x] `npm test` green
- [x] `cd src-tauri && cargo test` green
- [x] Manual: pair remote CLI, verify badge renders + outdated marker
- [x] Manual: trigger self-update with stale local build

Spec: docs/superpowers/specs/2026-05-18-remote-version-check-design.md
EOF
)"
```

---

## Manual / E2E checklist (after all four PRs merged)

- [ ] Pair a fresh CLI on a Linux VM, run `cinch push hello`. Confirm relay logs show the version header and the desktop UI shows `0.1.x` for that row within ~5 seconds.
- [ ] Install an old desktop (`cinch-desktop 0.1.6`), publish a release `0.1.8`, click "Update" in the badge. Confirm download → install → restart succeeds.
- [ ] Verify offline behavior: kill GitHub access (firewall), open desktop. Confirm cached `latest` still drives badges; no toast.
- [ ] Set `CINCH_NO_UPDATE_NUDGE=1` and run `cinch push`. Confirm stderr nudge is suppressed.

---

## Self-review notes

- **Spec coverage**: every section of the spec maps to a task (architecture → Phases 1–4; wire schema → Tasks 1–3; relay components → Tasks 6–11; CLI components → Tasks 13–17; desktop components → Tasks 18–23; error handling and offline → Tasks 19, 21, 22, plus manual E2E).
- **Placeholders**: none. Each step has code or commands.
- **Type consistency**: `ClientInfo` (Rust), `LatestVersions` and `VersionStatus` (specta-generated), `client_version`/`client_type` (proto) used identically across tasks.
- **Cross-repo gotcha**: Task 14 reveals a Phase 1 omission (plumbing `ClientInfo` into `RestClient`/`WsClient`). It's flagged inline as a Phase 1 follow-up that bumps cinch-core to 0.1.7 before Phase 3/4 can start. The cinch-core PR can be split into 0.1.6 (proto + helper) and 0.1.7 (constructor plumbing), or combined into a single 0.1.6 — the engineer's call based on review velocity.
