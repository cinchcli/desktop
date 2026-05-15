#!/usr/bin/env bash
# Verify that the sibling checkout of `relay` is at the exact commit
# this desktop revision was built and tested against.
#
# Why: relay still owns proto/cinch/v1/ at this stage of the cinch-core
# extraction. The `.relay-ref` pin file makes the proto-source revision
# explicit; this script turns drift from "silent surprise" into "loud
# CI failure".
#
# `cinch` was previously pinned the same way (path-dep on
# ../../cinch/crates/client-core), but client-core now ships from
# crates.io as `cinchcli-core` — Cargo.lock pins the version, so the
# `.cinch-ref` mechanism is obsolete. The relay pin will retire too once
# Phase 4 lands (relay starts importing Go bindings from cinch-core).
#
# Run locally before pushing: `bash scripts/check-sibling-pins.sh`
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
desktop_dir=$(cd "$script_dir/.." && pwd)
parent_dir=$(cd "$desktop_dir/.." && pwd)

fail=0

check_pin() {
  local name="$1"
  local pin_file="$desktop_dir/.${name}-ref"
  local sibling_dir="$parent_dir/$name"

  if [ ! -f "$pin_file" ]; then
    echo "::error::missing pin file: $pin_file" >&2
    return 1
  fi

  local expected
  expected=$(tr -d '[:space:]' < "$pin_file")
  if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::$pin_file must contain a 40-char git sha, got: '$expected'" >&2
    return 1
  fi

  if [ ! -d "$sibling_dir/.git" ]; then
    echo "::error::missing sibling checkout: $sibling_dir (clone $name next to desktop/)" >&2
    return 1
  fi

  local actual
  actual=$(git -C "$sibling_dir" rev-parse HEAD)
  if [ "$expected" != "$actual" ]; then
    echo "::error::$name sibling drift" >&2
    echo "  pinned (.${name}-ref): $expected" >&2
    echo "  actual ($sibling_dir HEAD): $actual" >&2
    echo "  fix: either" >&2
    echo "    a) git -C $sibling_dir checkout $expected   # use the pinned commit" >&2
    echo "    b) update .${name}-ref to $actual           # adopt sibling HEAD as the new pin" >&2
    return 1
  fi
  echo "✓ $name pin matches: $expected"
}

check_pin relay || fail=1
exit $fail
