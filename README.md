# Cinch Desktop

Copy from any terminal. Paste anywhere — including your Mac.

Cinch Desktop is the macOS companion for Cinch: every `cinch push` from a remote SSH box, Docker container, or CI job lands in your system clipboard before you reach Cmd+V. Comes with persistent, searchable local history and real-time WebSocket delivery.

## Requirements

- macOS (Apple Silicon or Intel)
- Access to a Cinch relay server — use the hosted relay at `api.cinchcli.com` or [self-host your own](https://github.com/cinchcli/relay)
- Node.js 22+ and pnpm
- Rust stable (installed automatically via `rustup`)

## Development setup

```bash
pnpm install
pnpm tauri dev
```

## Build

```bash
# .app + .dmg (macOS universal)
make build

# or directly:
pnpm tauri build --target aarch64-apple-darwin
pnpm tauri build --target x86_64-apple-darwin
```

## Regenerating Rust → TypeScript bindings

All TypeScript types are generated from Rust via tauri-specta. Never edit `src/bindings.ts` by hand.

```bash
cd src-tauri && cargo test export_bindings -- --ignored
```

## Features

- Local clipboard history with FTS5 full-text search
- Real-time sync via WebSocket (push from CLI → appear in dashboard instantly)
- Multi-server support — connect to several relay servers and filter by source
- Privacy-aware — skips password manager apps (1Password, Bitwarden, LastPass, Keychain Access) and `NSPasteboard` concealed/transient types
- Retention sweep — clips older than `local_retention_days` (default 30) are pruned hourly

## Privacy & data storage

Clips are stored locally in `~/Library/Application Support/com.cinch.app/clips.db` (SQLite + FTS5, plaintext). Cinch trusts macOS FileVault for at-rest protection.

## Links

- Website: [cinchcli.com](https://cinchcli.com)
- CLI + relay: [github.com/cinchcli/relay](https://github.com/cinchcli/relay)
- Docs: [cinchcli.com/docs](https://cinchcli.com/docs)

## License

Cinch Desktop is proprietary software. See [LICENSE](LICENSE).

The relay server and CLI are open source under AGPL-3.0:
[github.com/cinchcli/relay](https://github.com/cinchcli/relay) · [github.com/cinchcli/cinch](https://github.com/cinchcli/cinch)

For licensing inquiries: [jingmuio@gmail.com](mailto:jingmuio@gmail.com)
