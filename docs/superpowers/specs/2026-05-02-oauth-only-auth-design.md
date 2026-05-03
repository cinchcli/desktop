# OAuth-Only Auth — Design

**Status:** Draft, awaiting review
**Date:** 2026-05-02
**Scope:** cross-repo (`relay/`, `cinch/`, `desktop/`) — single coordinated release
**Drives changes on:** `relay/main`, `cinch/main`, `desktop/main` (new feature branches per repo)

## Goal

Remove the **pair-token** authentication path entirely so cinch has **one and only one** way to authenticate a new device: device-code OAuth (Google or GitHub). Simplify the schema, handlers, CLI surface, and desktop UI accordingly. Repurpose `cinch pair <ssh-target>` from a pair-token shortcut into an **OAuth bootstrap helper** so the one-command remote-pairing UX survives — and is actually nicer because the user no longer types or pastes a token.

Out of scope:
- OAuth provider changes (Google/GitHub setup is unchanged).
- Encryption key escrow (sealed bundle / passphrase). The encryption key continues to live only on user devices.
- Backward compatibility / migration for existing users — there are none yet.

## Why

Today there are two parallel auth mechanisms:

1. `cinch auth login` — device-code OAuth.
2. `cinch auth pair <PAIR_TOKEN>` — short token minted by an authed device, consumed by a new device. Used by `cinch pair <ssh-target>` to bootstrap remote machines.

Mechanism (2) duplicates (1) without any gain that OAuth can't provide. It costs:

- DB columns: `users.token`, `users.pair_token`, `users.token_migrated_at`.
- Two HTTP endpoints + Connect-RPC RPCs (`POST /auth/pair`, `POST /auth/pair-token/new`).
- Background `grace_sweeper.go` for legacy master-token cleanup.
- Two CLI subcommands (`cinch auth pair`, `cinch auth regenerate-pair-token`).
- ~100 lines of pair-token plumbing inside `cinch pair <ssh-target>`.
- A "Pair a machine" empty-state in desktop that points users to a CLI command.

Killing it makes the mental model "every device does OAuth, period" and lets us delete code instead of explaining it.

## Architecture

### Auth surface — before vs. after

```
BEFORE (two mechanisms)               AFTER (one mechanism)

cinch auth login   → device-code      cinch auth login           → device-code OAuth
cinch auth pair    → pair token       cinch auth login --headless → device-code, marker stdout
cinch pair <ssh>   → SSH + pair       cinch pair <ssh>           → SSH + OAuth bootstrap +
                                                                   SSH-channel encryption-key push
```

### What gets deleted

**relay (`/Users/jinmu/Programming/cinchcli/relay`)**
- Schema columns: `users.pair_token`, `users.token`, `users.token_migrated_at`.
- Handlers: `POST /auth/pair`, `POST /auth/pair-token/new` (in `internal/relay/handler.go`).
- Store methods: `Store.UserByPairToken`, `Store.ConsumePairTokenMintDevice`, `Store.SweepMigratedMasterTokens`, `Store.MarkTokenMigrated` (and any helpers that are now unreachable).
- File: `internal/relay/grace_sweeper.go` (and the `go RunGraceSweeper(...)` call in `cmd/relay/main.go`).
- Auth middleware path that accepts `users.token` — `RequireAuth` only honors `devices.token` after this change.
- Proto: `cinch.v1.PairRequest`, `cinch.v1.RotatePairTokenResponse`, and the `AuthService.Pair` RPC, in `proto/cinch/v1/auth.proto`. Regenerate with `make generate`.

**cinch (`/Users/jinmu/Programming/cinchcli/cinch`)**
- Subcommands: `cinch auth pair`, `cinch auth regenerate-pair-token` (in `crates/cli/src/commands/auth.rs`).
- HTTP method: `client_core::http::RestClient::regenerate_pair_token` (no remaining callers).
- The pair-token half of `crates/cli/src/commands/pair.rs` — `regenerate_pair_token().await`, the `PAIR_TOKEN` script variable, the `cinch auth pair "$PAIR_TOKEN"` line.

**desktop (`/Users/jinmu/Programming/cinchcli/desktop`)**
- Tauri command: `commands/relays.rs::pair_with_token` (replaced by `pair_via_ssh`).
- UI: the "Pair a machine" empty-state copy in `src/components/MachinesPanel.tsx` (replaced by an "Add SSH Machine" wizard entry point).

### What gets kept (and why)

- **Encryption-key SSH push** in `pair.rs` — independent of pair tokens. It was bundled into the same script for convenience; it stays. Local CLI (or desktop) reads its own encryption key from Keychain / Tauri secure store and writes it directly into the remote's `~/.cinch/config.json` over the SSH-encrypted channel.
- **WS `key_exchange_requested` dance** — fallback for the case where the user runs `cinch auth login` directly on a remote box without going through `cinch pair`. Kept and hardened (see "Key-exchange UX" below).

### `cinch pair <target>` — new sequence

Trigger: user runs `cinch pair jgopi` on their local Mac (or clicks "Add SSH Machine" in the desktop wizard). The local side has an active session — i.e., a device token + encryption key in Keychain / secure store.

```
Local Mac                            Remote (jgopi)                  Relay              Browser
─────────                            ──────────────                  ─────              ───────
$ cinch pair jgopi
  ├─ Read enc_key from Keychain
  └─ ssh jgopi sh < <bootstrap.sh> ─► sh: install cinch (curl)
                                      sh: write relay_url + enc_key
                                          to ~/.cinch/config.json
                                      sh: cinch auth login --headless
                                                                ┐
                                          ┌─────────────────────┘
                                          ▼
                                      POST /auth/device-code ─────► mint user_code
                                                              ◄──── { verification_url, user_code }
                                      stdout:
                                        <<CINCH-DEVICE-CODE>>
                                        { "url": "...", "user_code": "AB12" }
                                        <<END>>
                                      (poll loop runs)

  ◄──────── stream stdout (SSH pipe)
  ├─ Parse <<CINCH-DEVICE-CODE>> marker
  ├─ open(url) ──────────────────────────────────────────────────────► user clicks
  │                                                                    "Continue as
  │                                                                    <email>"
  │                                                                    (1-click,
  │                                                                    already signed in)
  │                                  ◄─────────────────────────────── OAuth callback
  │                                                                    POSTs to relay
  │                                  poll: GET /auth/device-code/poll
  │                                                              ◄──── { token, user_id, device_id }
  │                                  store device token via
  │                                  client_core::auth::write_credentials
  │                                  stdout: "✓ Paired"
  ◄──────── stream stdout (SSH pipe)
  └─ Print "✓ jgopi is ready"
```

Notes:
- The local side never sees or types a "pair token" — there isn't one anymore.
- The encryption key reaches the remote over the SSH-encrypted channel during the script preamble (same mechanism as today, just no longer co-located with a pair-token handoff).
- If OAuth completes 1-click (browser already signed in to Google), the whole pair takes ~5–10 seconds.

### New `cinch auth login --headless` flag

Introduced for the SSH-piped use case but also useful directly on a headless box.

- Skips the `open` crate call (no browser auto-open).
- Emits exactly one stdout line wrapping the device-code payload as a marker:

  ```
  <<CINCH-DEVICE-CODE>>{"url":"https://api.cinchcli.com/device?code=AB12","user_code":"AB12"}<<END>>
  ```

- All other progress, errors, and status output goes to **stderr only**. This is a hard invariant — the SSH-pipe parser on the local side relies on stdout containing only the marker line plus the post-auth `✓ Paired` line.
- Polling, success/failure handling, and credential storage are otherwise identical to the existing `cinch auth login`.

### Local-environment matrix

| Local has | Trigger | Encryption key source |
|---|---|---|
| Desktop only | "Add SSH Machine" wizard | Tauri secure store |
| CLI only | `cinch pair jgopi` | macOS Keychain (`com.cinchcli`) |
| Both | Either | Whichever triggered |
| Neither (yet) | Not supported | User must run `cinch auth login` somewhere first to create a key-bearing device |

### Desktop "Add SSH Machine" wizard

A new Tauri command `pair_via_ssh(target: String)` defined in `src-tauri/src/commands/relays.rs`, replacing `pair_with_token`. Same SSH-bootstrap flow as the CLI, just initiated by the GUI:

1. Modal: input "SSH target" (e.g. `user@host` or alias).
2. Backend spawns SSH + bootstrap script with the desktop's encryption key.
3. Backend opens the device-code URL via `tauri-plugin-opener` once it parses the marker from SSH stdout.
4. Modal streams progress lines from SSH stderr ("Installing cinch...", "Waiting for sign-in...").
5. On success: `✓ <target> is paired`. The new device appears in MachinesPanel through the existing relay event subscription.

Bindings regenerate via `cd src-tauri && cargo test export_bindings -- --ignored` per the desktop type-contract rules.

### Key-exchange UX (fallback path)

This path matters only when a user adds a device **without** using `cinch pair` — e.g. they SSH into a remote box themselves and run `cinch auth login --headless`. The encryption key has to arrive over the WS `key_exchange_requested` dance.

The infrastructure exists today (`relay/internal/relay/hub.go` broadcasts; `desktop/src-tauri/src/ws.rs` and `connect_events.go` handle it). It's silent on failure, which is the problem.

**Hardening:**

- **CLI** — `cinch auth login` learns a second polling phase: after the device token arrives, poll `GET /auth/key-bundle` for up to 30 s. The polling helper (`poll_key_bundle`) lives today at `cinch/crates/cli/src/commands/auth.rs:500` and is called only from the now-removed `cinch auth pair`. Lift it into `client-core::auth` (so desktop can reuse if needed) and call it from the main login path. Spinner reads `Authenticated. Waiting for another device to share encryption key...`. On timeout: print a non-fatal warning with three remediation options (open desktop / run `cinch pull` elsewhere / run `cinch pair` from a Mac) and exit 0.
- **CLI as key-bearer** — `cinch pull --watch` (and the `cinch pair` flow itself) keep a WS connection alive. While connected, the CLI handles `key_exchange_requested` events: ECDH + AES-GCM over the user's master key, POST to `/auth/key-bundle`. Lift the responder into `client-core` so desktop and CLI share one implementation (`client_core::key_exchange::Responder` trait).
- **Relay** — extend `GET /auth/key-bundle` response with a `pending_since` timestamp (when the requesting device first registered its public_key). Add `POST /auth/key-bundle/retry` (auth required, no body) — re-broadcasts `key_exchange_requested` for the calling device. CLI command `cinch auth retry-key` invokes it.
- **Desktop** — verify that the existing handler processes the pending list relay sends on WS reconnect (`connect_events.go:88-94`). On successful key delivery, surface a Tauri tray notification: `New device <name> joined. Encryption key shared.`
- **`cinch auth status`** — surfaces the new state: `Authenticated as <email> | Encryption key: ⚠ awaiting (no paired device responded)`.

### Migration

There are no existing users. Single PR per repo, deploy together. No deprecation window, no rollback safety net needed. Schema migration in `relay/internal/relay/store.go::Migrate()` runs three idempotent `ALTER TABLE users DROP COLUMN ...` statements (modernc/sqlite supports native column drop on SQLite ≥ 3.35).

## Components

### relay
- `internal/relay/store.go` — drop columns; remove pair-related methods; add new migration step.
- `internal/relay/handler.go` — remove pair handlers; trim `RequireAuth` to device-token-only; add `POST /auth/key-bundle/retry`; add `pending_since` to `KeyBundleResponse`.
- `internal/relay/grace_sweeper.go` — delete file.
- `cmd/relay/main.go` — remove `RunGraceSweeper` goroutine.
- `proto/cinch/v1/auth.proto` — remove `Pair` RPC and `PairRequest`/`RotatePairTokenResponse` messages; `make generate` regenerates Go + Rust stubs.

### cinch (CLI + client-core)
- `crates/cli/src/commands/auth.rs` — remove `Pair` and `RegeneratePairToken` enum variants and their handlers; add `--headless` flag to `Login` with marker-only stdout; add `RetryKey` subcommand.
- `crates/cli/src/commands/pair.rs` — remove `regenerate_pair_token()` call and `PAIR_TOKEN` script variable; replace `cinch auth pair "$PAIR_TOKEN"` line with `cinch auth login --headless`; add stdout-streaming task that parses the marker and calls `open::that(url)`; keep encryption-key push intact.
- `crates/client-core/src/http.rs` — remove `regenerate_pair_token`; add `retry_key_bundle`.
- `crates/client-core/src/auth.rs` — relocate `poll_key_bundle` call to the main login flow.
- `crates/client-core/src/key_exchange.rs` (new) — `Responder` trait with `respond(target_device_id, target_pub_key)` + ECDH/AES-GCM impl; consumed by both `pull --watch` (CLI) and the desktop WS handler.

### desktop
- `src-tauri/src/commands/relays.rs` — delete `pair_with_token`; add `pair_via_ssh(target)` that mirrors CLI's pair flow but reads key from Tauri secure store and uses `tauri-plugin-opener` for the OAuth URL.
- `src-tauri/src/ws.rs` — switch the `key_exchange_requested` handler to use the new `client_core::key_exchange::Responder` so logic is shared with CLI.
- `src/components/MachinesPanel.tsx` — replace pair-card empty-state with an "Add SSH Machine" entry point that opens the wizard modal.
- `src/components/AddSshMachineDialog.tsx` (new) — wizard modal: target input, progress streaming, success/failure states.
- `src/bindings.ts` — regenerated via `cargo test export_bindings -- --ignored`.

## Data flow

### Authentication request
```
device → request with "Authorization: Bearer <device-token>"
relay  → look up device by token (devices.token)
       → if found, attach user_id to request context
       → if not, return 401
```
(Master token / pair token paths are gone.)

### Encryption key delivery via `cinch pair`
```
local CLI/desktop → read enc_key from local store
                  → SSH script writes to remote ~/.cinch/config.json
                  → remote uses key for all subsequent push/pull
```

### Encryption key delivery via direct OAuth on remote
```
remote → POST device-code → OAuth → device token
       → poll GET /auth/key-bundle (new in CLI: up to 30 s)
relay  → broadcast key_exchange_requested to all key-bearing devices
key-bearer → ECDH(remote.public_key) + AES-GCM(user_master_key)
           → POST /auth/key-bundle { target_device_id, encrypted_bundle }
remote → next poll receives bundle → decrypt → store → done
```

## Error handling

| Trigger | Situation | Message | Exit code |
|---|---|---|---|
| `cinch pair <t>` | Local CLI not authed | `✗ Not authenticated.\n  Run: cinch auth login` | `AUTH_FAILURE` (2) |
| `cinch pair <t>` | SSH connection failed | `✗ SSH to '<t>' failed: <err>\n  Try: ssh <t>` | `GENERIC_ERROR` (1) |
| `cinch pair <t>` | Remote install failed | `✗ Could not install cinch on '<t>'.\n  Install manually then retry with --skip-install` | `GENERIC_ERROR` |
| `cinch pair <t>` | Marker not parsed within 30 s | `✗ Could not parse OAuth URL from remote.\n  SSH into '<t>' and run 'cinch auth login --headless' manually` | `GENERIC_ERROR` |
| `cinch pair <t>` | OAuth not completed within 5 min | `✗ OAuth not completed within 5 minutes.\n  Retry: cinch pair <t>` | `GENERIC_ERROR` |
| `cinch pair <t>` | SSH dropped after device registration | `⚠ Device registered on relay but SSH session lost.\n  <t> may need: cinch pull to verify` | 0 (warning) |
| `cinch auth login` (any) | Device-code expired / poll fails | `✗ Sign-in not completed.\n  Retry: cinch auth login` | `GENERIC_ERROR` |
| `cinch auth login` (any) | Device authed but key-bundle poll times out (30 s) | `⚠ Authenticated, but no paired device responded with the encryption key.\n  Try: open cinch desktop on a paired Mac, or run 'cinch pull' from another paired device, or 'cinch pair <this-host>' from a Mac` | 0 (warning) |
| `cinch auth status` | Device authed, key absent | `Authenticated as <email>\n  Encryption key: ⚠ awaiting` | 0 |
| `cinch push` | Authed, key absent | `⚠ Pushing unencrypted (no key yet).\n  Run: cinch auth retry-key` (push proceeds) | 0 |

Desktop wizard surfaces the same messages inline in the modal; failures show a red banner with a "Try again" button.

The `--headless` stdout-pollution invariant is enforced by an integration test (see Testing).

## Testing

Five invariants locked by tests; everything else relies on the existing test suites for regression.

### Invariant 1 — schema migration is idempotent and safe
`relay/internal/relay/store_test.go`:
- `TestMigrate_DropsLegacyColumns` — seed a DB with the old schema, run `Migrate()`, assert `pair_token` / `token` / `token_migrated_at` columns are gone.
- `TestMigrate_Idempotent` — run `Migrate()` twice in a row; second call is a no-op.
- `TestMigrate_FreshDB` — empty DB → `Migrate()` → schema has no legacy columns.

### Invariant 2 — removed endpoints return 404
`relay/internal/relay/handler_test.go::TestRemovedEndpoints` — `POST /auth/pair` and `POST /auth/pair-token/new` produce 404 (the routes are absent from the mux). Guards against accidental re-introduction.

### Invariant 3 — `--headless` stdout contains marker only
`cinch/crates/cli/tests/headless_marker.rs` (new integration test) — spawn `cinch auth login --headless` against a mock relay, assert stdout matches exactly the marker line (and, on success, the trailing `✓ Paired` line). All progress/error output must arrive on stderr.

Plus unit tests for the marker parser in `crates/cli/src/commands/pair.rs::parse_device_code_marker_tests`:
- valid marker → URL + user_code extracted;
- missing END marker → error;
- malformed JSON inside marker → error;
- no marker found within 30 s → timeout error.

### Invariant 4 — wire compat / no leaked legacy proto fields
- `testdata/wire-vectors.json` — drop `pair_request`, `rotate_pair_token_response`, and any related fixtures. Existing `client_core/tests/wire_vectors.rs` and `relay/internal/gen/cinch/v1/wire_vectors_test.go` will fail loudly if a removed field is referenced.
- New guard test (e.g. `relay/internal/gen/cinch/v1/no_legacy_test.go`) greps the generated `auth.pb.go` for `PairToken`, `MasterToken`, `RotatePairToken` — must be zero hits.

### Invariant 5 — WS key-exchange delivers keys end-to-end
`relay/internal/relay/key_exchange_e2e_test.go` (extend if exists, create if not):
- `TestKeyExchange_BasicFlow` — register device A (key-bearer), register device B (no key), assert relay broadcasts and B can poll the bundle.
- `TestRetryKeyBundle` — B calls `POST /auth/key-bundle/retry`, assert A receives a fresh broadcast.
- `TestKeyBundleResponse_PendingSince` — bundle absent → response contains `pending_since` timestamp.

Plus `cinch/crates/client-core/tests/key_bearer.rs` — mock relay + WS, send `key_exchange_requested`, assert CLI computes ECDH + POSTs the bundle correctly.

### Manual E2E checklist (staging, before deploy)
- [ ] Fresh Mac → install new CLI → `cinch auth login` → OAuth → device registered.
- [ ] Same Mac → `cinch pair my-test-vps` → browser opens → 1-click sign-in → `cinch push` from VPS works.
- [ ] Install desktop app → "Add SSH Machine" wizard → same flow, GUI trigger.
- [ ] On VPS directly: `cinch auth login --headless` → URL printed → complete OAuth from phone → with desktop online, key arrives within 5 s → `cinch pull` decrypts.
- [ ] Repeat (4) with desktop closed → 30 s warning message appears → open desktop → tray notification → `cinch auth retry-key` → key arrives.

### Out of scope for testing
- Migration rollback (no users to roll back to).
- Old-CLI ↔ new-server compat (everything ships together).
- Deprecation periods (collapsed into the single release).
- Multi-key-bearer race conditions (current scale doesn't warrant it; first responder wins).

## Open questions

None at design time. Surface during implementation if the SSH stdout/stderr separation or the `pending_since` timestamp ergonomics turn out to need adjustment.
