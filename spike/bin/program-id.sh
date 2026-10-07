#!/bin/sh
# Prints the ID the throwaway program declares (program/src/lib.rs).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sed -n 's/^declare_id!("\(.*\)");$/\1/p' "$ROOT/program/src/lib.rs"
