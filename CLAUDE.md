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
