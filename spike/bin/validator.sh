#!/bin/sh
# Local validator of the spike: Agave test validator with every feature
# active (so the ZK ElGamal Proof program is enabled), Token-2022 cloned from
# mainnet (the build mainnet runs), and the throwaway program loaded at the ID
# it declares. Ledger and ports of its own, so it does not touch another local
# validator. Build the program first: cargo-build-sbf --arch v3 in program/.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec solana-test-validator --reset --quiet \
  --ledger "$ROOT/out/ledger" \
  --bind-address 127.0.0.1 \
  --rpc-port 18899 \
  --faucet-port 19900 \
  --gossip-port 18001 \
  --dynamic-port-range 18002-18030 \
  --limit-ledger-size 200000 \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --upgradeable-program "$("$ROOT/bin/program-id.sh")" "$ROOT/program/target/deploy/dvp_spike.so" none
