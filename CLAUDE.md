# Desktop App — Developer Rules

## Type Contract

All TypeScript types for commands and events are **auto-generated** from Rust via tauri-specta.

- **Never** define wire types manually in TypeScript.
- **Never** add types to `src/bindings.ts` by hand — this file is overwritten on every `cargo test export_bindings -- --ignored`.
- To add or change a type, edit the Rust source (`src-tauri/src/`) and regenerate.

### Regenerating bindings

```bash
cd src-tauri && cargo test export_bindings -- --ignored
```

This writes `src/bindings.ts` automatically.

## Commands

All Tauri command calls go through the typed `commands` object from `src/bindings`:

```ts
import { commands } from "./bindings";
const clips = await unwrap(commands.listClips(null, null, 100));
```

Never use `invoke<T>(...)` directly — grep for it; zero occurrences is the invariant.

## Events

All Tauri event subscriptions go through the typed `events` object from `src/bindings`:

```ts
import { events } from "./bindings";
const unsub = events.clipReceived.listen((e) => console.log(e.payload));
```

Never use `listen<T>("event-name", cb)` from `@tauri-apps/api/event` — grep for it; zero occurrences is the invariant.

## Cross-repo dependency changes (cinch-core)

Desktop pulls `cinchcli-core` from crates.io. The parent CLAUDE.md states the
"no sibling-checkout invariant": this repo must build standalone, since CI
and fresh clones only check out `desktop/`. Anything that breaks that
invariant turns `main` red on the next push.

When a desktop feature needs an unpublished cinch-core change, the order is:

1. Land the change in `cinchcli/cinch-core`, bump `crates/client-core/Cargo.toml`, and `cargo publish -p cinchcli-core`.
2. **Then** bump `src-tauri/Cargo.toml`'s `cinchcli-core` version in a separate desktop commit.

Do NOT, on the desktop repo:

- Add a `[patch.crates-io]` block with a path that escapes the repo (`../../cinch-core/...`). The path resolves on the maintainer's multi-repo checkout but not in CI or on any other machine, and Cargo check fails with `No such file or directory`.
- Bump a `version =` to a number that is not yet on crates.io. Cargo cannot resolve it and every contributor's build breaks.
- Push a desktop change that compiles only because a local patch override is masking a missing published version. A green local `cargo check` under a `[patch.crates-io]` override is not a signal that CI will pass — verify against the published state (drop the patch block, then `cargo check`) before pushing.

If you need to run desktop locally against an unpublished cinch-core during
development, keep the override out of `Cargo.toml`. Use an uncommitted
`.cargo/config.toml` or a worktree-local `Cargo.toml` patch you never `git add`.
