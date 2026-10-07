// Shared helpers of the DvP confidential leg spike: transactions, the relay
// instruction of the throwaway program, and the proofs of a confidential
// transfer out of an account whose ElGamal key the client holds.

import { createHash } from "node:crypto";
import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionSize,
  getTransactionSizeLimit,
  isSome,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  AeKey,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  ElGamalPubkey,
  GroupedElGamalCiphertext3Handles,
  PedersenCommitment,
  PedersenOpening,
} from "@solana/zk-sdk/bundler";

export const ZK_ELGAMAL_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111" as Address;
export const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
export const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

export type Rpc = any;
export type Version = 0 | 1;

export const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };

export function buildMessage(
  version: Version,
  payer: TransactionSigner,
  lifetime: Lifetime,
  instructions: readonly Instruction[],
) {
  let message: any = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as any, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  message = setTransactionMessageComputeUnitLimit(MAX_COMPUTE_UNITS, message);
  if (version === 1) {
    message = setTransactionMessagePriorityFeeLamports(0n, message);
    message = setTransactionMessageLoadedAccountsDataSizeLimit(MAX_LOADED_ACCOUNTS_DATA_SIZE, message);
  }
  return message;
}

export type Size = { size: number; limit: number; fits: boolean } | { error: string };

export function measure(
  version: Version,
  payer: TransactionSigner,
  lifetime: Lifetime,
  instructions: readonly Instruction[],
): Size {
  try {
    const compiled = compileTransaction(buildMessage(version, payer, lifetime, instructions));
    const size = getTransactionSize(compiled);
    const limit = getTransactionSizeLimit(compiled);
    return { size, limit, fits: size <= limit };
  } catch (error) {
    return { error: String(error).slice(0, 200) };
  }
}

export type StepResult = {
  name: string;
  ok: boolean;
  expected: "pass" | "fail";
  version: Version;
  sizeV0: Size;
  sizeV1: Size;
  instructions: number;
  unitsConsumed: number | null;
  unitsSource: "transaction" | "simulation" | null;
  signature: string | null;
  err: unknown;
  logs: readonly string[];
};

export const results: StepResult[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function confirm(rpc: Rpc, signature: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`transaction ${signature} was not confirmed in 30 seconds`);
}

/**
 * Simulates the instructions as one transaction and, when the simulation
 * passes and the step is not sim only, sends it and reads the compute units
 * and logs of the landed transaction. Version 0 is used when the transaction
 * fits it, version 1 otherwise. Sizes include the compute unit limit setting.
 */
export async function step(
  rpc: Rpc,
  payer: TransactionSigner,
  name: string,
  instructions: readonly Instruction[],
  options: { expect?: "pass" | "fail"; simulateOnly?: boolean; version?: Version } = {},
): Promise<StepResult> {
  const expected = options.expect ?? "pass";
  const lifetime = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
  const sizeV0 = measure(0, payer, lifetime, instructions);
  const sizeV1 = measure(1, payer, lifetime, instructions);
  const version: Version = options.version ?? ("fits" in sizeV0 && sizeV0.fits ? 0 : 1);
  const result: StepResult = {
    name,
    ok: false,
    expected,
    version,
    sizeV0,
    sizeV1,
    instructions: instructions.length,
    unitsConsumed: null,
    unitsSource: null,
    signature: null,
    err: null,
    logs: [],
  };
  results.push(result);
  try {
    const signed = await signTransactionMessageWithSigners(buildMessage(version, payer, lifetime, instructions));
    const wire = getBase64EncodedWireTransaction(signed);
    const simulation = (
      await rpc
        .simulateTransaction(wire, {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        })
        .send()
    ).value;
    result.logs = simulation.logs ?? [];
    result.err = simulation.err ?? null;
    result.unitsConsumed = simulation.unitsConsumed === undefined ? null : Number(simulation.unitsConsumed);
    result.unitsSource = "simulation";
    if (simulation.err || options.simulateOnly || expected === "fail") {
      result.ok = !simulation.err;
      return report(result);
    }
    const signature = getSignatureFromTransaction(signed);
    result.signature = signature;
    await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send();
    await confirm(rpc, signature);
    const landed = await rpc
      .getTransaction(signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 1 })
      .send()
      .catch(() => null);
    if (landed?.meta) {
      result.err = landed.meta.err ?? null;
      result.logs = landed.meta.logMessages ?? result.logs;
      if (landed.meta.computeUnitsConsumed !== undefined && landed.meta.computeUnitsConsumed !== null) {
        result.unitsConsumed = Number(landed.meta.computeUnitsConsumed);
        result.unitsSource = "transaction";
      }
      result.ok = !landed.meta.err;
    } else {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      result.err = value[0]?.err ?? null;
      result.ok = !value[0]?.err;
    }
  } catch (error) {
    result.err = { thrown: String(error).slice(0, 600) };
    result.ok = false;
  }
  return report(result);
}

function report(result: StepResult): StepResult {
  const outcome = result.ok ? "pass" : "fail";
  const asExpected = outcome === result.expected ? "" : "  <-- NOT AS EXPECTED";
  const size = (s: Size) => ("error" in s ? "n/a" : `${s.size}/${s.limit}`);
  console.log(
    `[${outcome}] ${result.name} · v${result.version} · ${result.unitsConsumed ?? "?"} CU (${result.unitsSource}) · ` +
      `v0 ${size(result.sizeV0)} · v1 ${size(result.sizeV1)}${asExpected}`,
  );
  if (!result.ok) {
    console.log(`       err: ${json(result.err).replace(/\s+/g, " ")}`);
    for (const line of result.logs.slice(-6)) console.log(`       ${line}`);
  }
  return result;
}

/** A step the rest of the run depends on: stops the run when it fails. */
export async function must(promise: Promise<StepResult>): Promise<StepResult> {
  const result = await promise;
  if (!result.ok) throw new Error(`required step failed: ${result.name}`);
  return result;
}

// ---------------------------------------------------------------------------
// The throwaway program
// ---------------------------------------------------------------------------

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export async function escrowAuthority(program: Address, nonce: bigint): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [new TextEncoder().encode("escrow-authority"), u64(nonce)],
  });
  return address;
}

/**
 * The program's `relay` instruction: runs `inner` as CPIs signed by the
 * escrow authority. Inner instructions are built with the authority as a
 * plain address; it is passed here as a non signer and the program marks it
 * as a signer in each CPI. Other signers keep their signer role.
 */
export function relay(program: Address, nonce: bigint, authority: Address, inner: readonly Instruction[]): Instruction {
  const discriminator = createHash("sha256").update("global:relay").digest().subarray(0, 8);
  const accounts: unknown[] = [{ address: authority, role: AccountRole.READONLY }];
  const counts: number[] = [];
  const datas: Uint8Array[] = [];
  for (const instruction of inner) {
    accounts.push({ address: instruction.programAddress, role: AccountRole.READONLY });
    const metas = instruction.accounts ?? [];
    for (const meta of metas) {
      if (meta.address === authority) {
        const writable = meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER;
        accounts.push({ address: authority, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
      } else {
        accounts.push(meta);
      }
    }
    counts.push(metas.length);
    datas.push(new Uint8Array(instruction.data ?? []));
  }
  const data = concat([
    new Uint8Array(discriminator),
    u64(nonce),
    u32(counts.length),
    Uint8Array.from(counts),
    u32(datas.length),
    ...datas.flatMap((bytes) => [u32(bytes.length), bytes]),
  ]);
  return { programAddress: program, accounts, data } as Instruction;
}

// ---------------------------------------------------------------------------
// Instruction plans of the token-2022 helpers
// ---------------------------------------------------------------------------

export function flatten(plan: any): Instruction[] {
  if (plan.kind === "single") return [plan.instruction];
  if (plan.kind === "sequential" || plan.kind === "parallel") return plan.plans.flatMap(flatten);
  throw new Error(`unsupported instruction plan kind: ${plan.kind}`);
}

// ---------------------------------------------------------------------------
// Confidential state and proofs
// ---------------------------------------------------------------------------

const { Point } = ristretto255;
const LO_BITS = 16n;

export function confidentialState(tokenAccount: any) {
  if (!isSome(tokenAccount.extensions)) throw new Error("the token account has no extensions");
  const extension = (tokenAccount.extensions.value as any[]).find(
    (candidate) => candidate.__kind === "ConfidentialTransferAccount",
  );
  if (!extension) throw new Error("the token account has no ConfidentialTransferAccount extension");
  return extension;
}

export const elgamalPubkeyOf = (address: Address) =>
  ElGamalPubkey.fromBytes(new Uint8Array(getAddressEncoder().encode(address)));

export function ciphertext(bytes: ArrayLike<number>): ElGamalCiphertext {
  const parsed = ElGamalCiphertext.fromBytes(new Uint8Array(bytes));
  if (!parsed) throw new Error("not an ElGamal ciphertext");
  return parsed;
}

function points(bytes: Uint8Array) {
  return { commitment: Point.fromBytes(bytes.slice(0, 32)), handle: Point.fromBytes(bytes.slice(32, 64)) };
}

/** `left - (lo + 2^16 * hi)` on ElGamal ciphertexts, as Token-2022 computes the new source balance. */
export function subtractLoHi(left: Uint8Array, lo: Uint8Array, hi: Uint8Array): Uint8Array {
  const scale = 1n << LO_BITS;
  const a = points(left);
  const l = points(lo);
  const h = points(hi);
  const out = new Uint8Array(64);
  out.set(a.commitment.subtract(l.commitment.add(h.commitment.multiply(scale))).toBytes(), 0);
  out.set(a.handle.subtract(l.handle.add(h.handle.multiply(scale))).toBytes(), 32);
  return out;
}

function handleCiphertext(grouped: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(64);
  out.set(grouped.slice(0, 32), 0);
  out.set(grouped.slice(32 + index * 32, 64 + index * 32), 32);
  return out;
}

export type TransferProofs = {
  equality: Uint8Array;
  validity: Uint8Array;
  range: Uint8Array;
  auditorLo: Uint8Array;
  auditorHi: Uint8Array;
  newBalance: bigint;
  /** The source's available balance ciphertext after the transfer. */
  newCiphertext: Uint8Array;
  /** The Pedersen commitments to the low and the high part of the amount. */
  commitmentLo: Uint8Array;
  commitmentHi: Uint8Array;
};

/**
 * The three proofs of a confidential transfer, from the source's ElGamal
 * keypair, its current available balance (ciphertext and plaintext) and the
 * destination's public key. The statement is the one `@solana-program/token-2022`
 * 0.19.0 builds in `buildConfidentialTransferProofData`; it is rebuilt here
 * because that function is not exported and fixes the proof accounts' authority.
 */
export function transferProofs(input: {
  sourceKeypair: ElGamalKeypair;
  available: Uint8Array;
  balance: bigint;
  amount: bigint;
  destination: ElGamalPubkey;
  auditor?: ElGamalPubkey;
}): TransferProofs {
  const { sourceKeypair, amount } = input;
  if (amount > input.balance) throw new Error("the amount is above the balance");
  const source = sourceKeypair.pubkey();
  const auditor = input.auditor ?? ElGamalPubkey.fromBytes(new Uint8Array(32));
  const amountLo = amount & ((1n << LO_BITS) - 1n);
  const amountHi = amount >> LO_BITS;
  const openingLo = new PedersenOpening();
  const openingHi = new PedersenOpening();
  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(source, input.destination, auditor, amountLo, openingLo);
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(source, input.destination, auditor, amountHi, openingHi);
  const groupedLoBytes = groupedLo.toBytes();
  const groupedHiBytes = groupedHi.toBytes();

  const newBalance = input.balance - amount;
  const newOpening = new PedersenOpening();
  const newCommitment = PedersenCommitment.from(newBalance, newOpening);
  const newCiphertext = subtractLoHi(
    input.available,
    handleCiphertext(groupedLoBytes, 0),
    handleCiphertext(groupedHiBytes, 0),
  );
  const equality = new CiphertextCommitmentEqualityProofData(
    sourceKeypair,
    ciphertext(newCiphertext),
    newCommitment,
    newOpening,
    newBalance,
  );
  const validity = new BatchedGroupedCiphertext3HandlesValidityProofData(
    source,
    input.destination,
    auditor,
    groupedLo,
    groupedHi,
    amountLo,
    amountHi,
    openingLo,
    openingHi,
  );
  const commitmentLo = groupedLoBytes.slice(0, 32);
  const commitmentHi = groupedHiBytes.slice(0, 32);
  const paddingOpening = new PedersenOpening();
  const range = new BatchedRangeProofU128Data(
    [
      newCommitment,
      PedersenCommitment.fromBytes(commitmentLo),
      PedersenCommitment.fromBytes(commitmentHi),
      PedersenCommitment.from(0n, paddingOpening),
    ],
    new BigUint64Array([newBalance, amountLo, amountHi, 0n]),
    Uint8Array.from([64, 16, 32, 16]),
    [newOpening, openingLo, openingHi, paddingOpening],
  );
  return {
    equality: new Uint8Array(equality.toBytes()),
    validity: new Uint8Array(validity.toBytes()),
    range: new Uint8Array(range.toBytes()),
    auditorLo: handleCiphertext(groupedLoBytes, 2),
    auditorHi: handleCiphertext(groupedHiBytes, 2),
    newBalance,
    newCiphertext,
    commitmentLo,
    commitmentHi,
  };
}

type Verify = (args: any) => Promise<Instruction[]>;

/** Verifies a proof into a new context state account whose authority is `authority`. */
export async function proofInContext(
  rpc: Rpc,
  payer: TransactionSigner,
  verify: Verify,
  proof: Uint8Array,
  authority: Address,
): Promise<{ address: Address; instructions: Instruction[] }> {
  const contextAccount = await generateKeyPairSigner();
  const instructions = await verify({ rpc, payer, proofData: proof, contextState: { contextAccount, authority } });
  return { address: contextAccount.address, instructions };
}

/** The verification instruction alone, for a proof that sits in the same transaction. */
export async function proofInline(rpc: Rpc, payer: TransactionSigner, verify: Verify, proof: Uint8Array) {
  const instructions = await verify({ rpc, payer, proofData: proof });
  if (instructions.length !== 1) throw new Error("expected one verification instruction");
  return instructions[0] as Instruction;
}

export { AeKey, ElGamalKeypair, ElGamalPubkey };
