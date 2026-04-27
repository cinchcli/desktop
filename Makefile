.PHONY: dev build test check clean

dev:
	pnpm tauri dev

build:
	pnpm tauri build

test:
	pnpm test

check:
	cargo check --manifest-path src-tauri/Cargo.toml

clean:
	rm -rf dist/ src-tauri/target/
