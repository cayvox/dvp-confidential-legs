# Verification spike

Evidence for section 7.2 of the proposal in [`../README.md`](../README.md).

Throwaway code. It measures how Token-2022 and the ZK ElGamal Proof program behave when a program's PDA owns a confidential token account. It is not a design for the escrow, it has no checks of its own, and it must not be deployed.

The recorded runs are from 2026-10-06 (mainnet and local validator) and 2026-10-07 (LiteSVM), on one development machine (Apple silicon, macOS 26.6.2).

## What is here

| Path | What it is |
|---|---|
| `program/` | The throwaway Anchor program. One PDA, one instruction `relay` that runs a list of CPIs signed by the PDA. `Cargo.lock` pins what was built. |
| `client/lib.ts` | Transaction helpers, the `relay` instruction, and the proofs of a confidential transfer out of an account whose ElGamal key the client holds. |
| `client/mainnet-simulate.ts` | Question 1. Reads the Token-2022 program on mainnet and simulates account setup. It never signs and never sends. |
| `client/localnet.ts` | Questions 2 and 3. 64 transactions or simulations on a local validator. |
| `client/summarize.ts` | Turns a `localnet.json` into the table in `results/localnet-summary.md`. |
| `litesvm-check/` | Question 4. A LiteSVM test. Its `Cargo.lock` is the one of `solana-foundation/dvp` at commit `df9919e`, after cargo dropped the packages this crate does not use, so LiteSVM and the Agave crates resolve to the versions DvP's tests use. |
| `bin/validator.sh` | The local validator command. |
| `bin/program-id.sh` | Prints the program ID declared in `program/src/lib.rs`. |
| `results/` | The outputs of the recorded runs. |

## Recorded results

| File | Content |
|---|---|
| `results/mainnet.json` | The program account, its hash, the mint that was read, and the two simulations with their full logs. |
| `results/mainnet-attempt-1-missing-fee-extension.json` | The first attempt, which failed because of a mistake in the test: the account lacked an extension the mint requires. Kept for the record. |
| `results/osec-status.json` | The verification record of the program, as returned by `https://verify.osec.io/status/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` on 2026-10-06. |
| `results/localnet.json` | Every step of the local run: result, transaction version, size as version 0 and as version 1, compute units, signature, error and full logs. |
| `results/localnet-summary.md` | The same as one table. |
| `results/localnet-run.txt` | The console output of the local run. |
| `results/litesvm-run.txt` | The output of the LiteSVM test with its logs, from the end of the build on. |

The files are as the runs wrote them, with one change: three absolute paths of the machine in the two `.txt` files were made relative to this folder.

## Tool versions

| Tool | Version |
|---|---|
| Agave CLI and `solana-test-validator` | 4.2.2 |
| `cargo-build-sbf` | 4.1.0, platform tools v1.54, rustc 1.89.0 |
| Host Rust | rustc 1.98.1, cargo 1.98.1 |
| `anchor-lang` | 1.2.0. The Anchor CLI is not used: the program is built with `cargo-build-sbf` and called with a hand encoded instruction. |
| Node | 24.21.0 (runs the `.ts` files directly) |
| pnpm | 12.6.0 |
| `@solana/kit` | 8.3.0 |
| `@solana-program/token-2022` | 0.19.0 |
| `@solana-program/zk-elgamal-proof` | 0.4.0 |
| `@solana/zk-sdk` | 0.5.3 |
| `@noble/curves` | 2.4.0 |
| `litesvm` | 0.7.0, with `solana-builtins` 2.3.10 and `solana-zk-elgamal-proof-program` 2.3.10 |
| `spl-token-2022` (Rust, in the LiteSVM test) | 9.0.0 |
| Token-2022 on the local validator | cloned from mainnet at validator start: `program@v11.0.0`, SHA-256 `7ea94a027005b39196fa08e6d0ddcd55ec32eb43266179921a834a1ba2eb1947` |

## Run it again

From this folder. New outputs go to `out/`, which git ignores, so the recorded results stay as they are. The local validator needs network access once, to clone Token-2022 from mainnet.

```sh
# Question 1: mainnet, read and simulate only
cd client
pnpm install --ignore-workspace --frozen-lockfile
mkdir -p ../out
node mainnet-simulate.ts ../out/mainnet.json

# Questions 2 and 3: build the program, start the validator, run
cd ../program
cargo-build-sbf --arch v3
cd ..
mkdir -p out
bin/validator.sh > out/validator.log 2>&1 &
# wait until `solana --url http://127.0.0.1:18899 cluster-version` answers
cd client
node localnet.ts http://127.0.0.1:18899 "$(../bin/program-id.sh)" ../out/localnet.json
node summarize.ts ../out/localnet.json "$(../bin/program-id.sh)" > ../out/localnet-summary.md
kill %1    # stop the validator

# Question 4: LiteSVM as DvP's tests build it
cd ..
solana program dump TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb out/token-2022-mainnet.so --url https://api.mainnet-beta.solana.com
cd litesvm-check
TOKEN_2022_SO=../out/token-2022-mainnet.so cargo test -- --nocapture --test-threads 1
```

Notes:

- The program is loaded into the validator at the ID it declares, so no keypair is needed. The keypair of the recorded run was generated for that run and not kept.
- `mainnet-simulate.ts` picks a funded system account as the fee payer of the simulation. Nothing is signed for it and nothing is sent.
- Every run creates new keys, a new mint and new accounts, so addresses and signatures differ from the recorded ones.

## Reading the numbers

- Compute units are those of the landed transaction (`getTransaction`), or of the simulation for steps that were only simulated. For version 0 transactions they include 150 units for the compute unit limit instruction.
- The same step can differ by a few thousand units between runs: creating the associated token account and checking the PDA search for a bump, about 1,500 units per try.
- Sizes are measured with `getTransactionSize` of `@solana/kit` for the transaction compiled as version 0 and as version 1, with a compute unit limit set and without address lookup tables. Limits: 1,232 and 4,096 bytes.
- The program is a generic pass through. Its overhead is in every total. `results/localnet-summary.md` shows next to it what Token-2022 reports for its own CPIs.
