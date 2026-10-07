// DvP confidential leg spike, questions 2 and 3: every Token-2022 and ZK
// ElGamal Proof instruction a confidential escrow needs, run by CPI from a
// program whose PDA owns the escrow token account, on a local validator.
//
// Usage: node localnet.ts <rpc url> <program id> <results file>

import { writeFileSync } from "node:fs";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken,
  fetchToken,
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getConfidentialDepositInstruction,
  getConfidentialTransferInstruction,
  getConfigureConfidentialTransferAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getDisableConfidentialCreditsInstruction,
  getDisableNonConfidentialCreditsInstruction,
  getEmptyConfidentialTransferAccountInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getReallocateInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getConfidentialTransferInstructionPlan,
  getCreateConfidentialTransferAccountInstructionPlan,
} from "@solana-program/token-2022/confidential";
import {
  closeContextStateProof,
  verifyBatchedGroupedCiphertext3HandlesValidity,
  verifyBatchedRangeProofU128,
  verifyCiphertextCommitmentEquality,
  verifyPubkeyValidity,
  verifyZeroCiphertext,
} from "@solana-program/zk-elgamal-proof";
import {
  createNoopSigner,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressDecoder,
  lamports,
  none,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { AeCiphertext, PubkeyValidityProofData, ZeroCiphertextProofData } from "@solana/zk-sdk/bundler";
import {
  AeKey,
  ElGamalKeypair,
  SYSVAR_INSTRUCTIONS,
  ciphertext,
  confidentialState,
  elgamalPubkeyOf,
  escrowAuthority,
  flatten,
  json,
  must,
  proofInContext,
  proofInline,
  relay,
  results,
  step,
  transferProofs,
  type Rpc,
} from "./lib.ts";

const [rpcUrl, programArg, resultsFile] = process.argv.slice(2);
if (!rpcUrl || !programArg || !resultsFile) {
  throw new Error("usage: node localnet.ts <rpc url> <program id> <results file>");
}
const PROGRAM = programArg as Address;
const rpc: Rpc = createSolanaRpc(rpcUrl);
const DECIMALS = 6;
const UNIT = 1_000_000n;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`   ${ok ? "ok " : "BAD"} ${name}${detail ? ` (${detail})` : ""}`);
}

const payer = await generateKeyPairSigner();
await rpc.requestAirdrop(payer.address, lamports(100_000_000_000n)).send();
for (let attempt = 0; attempt < 60; attempt += 1) {
  const { value } = await rpc.getBalance(payer.address, { commitment: "confirmed" }).send();
  if (value > 0n) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const run = (name: string, instructions: readonly Instruction[], options = {}) =>
  step(rpc, payer, name, instructions, options);
const cpi = (nonce: bigint, authority: Address, inner: readonly Instruction[]) =>
  relay(PROGRAM, nonce, authority, inner);
const tokenOf = async (address: Address) => (await fetchToken(rpc, address, { commitment: "confirmed" })).data;
const exists = async (address: Address) =>
  (await rpc.getAccountInfo(address, { commitment: "confirmed", encoding: "base64" }).send()).value !== null;

// ---------------------------------------------------------------------------
// Setup, all top level and ordinary: a mint with the confidential transfer
// extension (accounts approved automatically, no auditor), a depositor with
// a confidential balance, and a recipient.
// ---------------------------------------------------------------------------

console.log("\n== setup ==");
const mint = await generateKeyPairSigner();
const mintExtension = {
  __kind: "ConfidentialTransferMint" as const,
  authority: none(),
  autoApproveNewAccounts: true,
  auditorElgamalPubkey: none(),
};
const mintSpace = BigInt(getMintSize([mintExtension]));
await must(
  run("setup: mint with ConfidentialTransferMint", [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: await rpc.getMinimumBalanceForRentExemption(mintSpace).send(),
      space: mintSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint: mint.address,
      authority: none(),
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: none(),
    }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: payer.address }),
  ]),
);

type Party = { signer: KeyPairSigner; keys: ElGamalKeypair; aes: AeKey; token: Address };
async function party(label: string): Promise<Party> {
  const signer = await generateKeyPairSigner();
  const keys = new ElGamalKeypair();
  const aes = new AeKey();
  const [token] = await findAssociatedTokenPda({
    owner: signer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint: mint.address,
  });
  const plan = await getCreateConfidentialTransferAccountInstructionPlan({
    payer,
    owner: signer,
    mint: mint.address,
    rpc,
    elgamalKeypair: keys,
    aesKey: aes,
  });
  await must(run(`setup: ${label} confidential account`, flatten(plan)));
  return { signer, keys, aes, token };
}
const depositor = await party("depositor");
const recipient = await party("recipient");

await must(
  run("setup: mint 1000, deposit 800 to the depositor's confidential balance", [
    getMintToInstruction({ mint: mint.address, token: depositor.token, mintAuthority: payer, amount: 1000n * UNIT }),
    getConfidentialDepositInstruction({
      token: depositor.token,
      mint: mint.address,
      authority: depositor.signer,
      amount: 800n * UNIT,
      decimals: DECIMALS,
    }),
  ]),
);
await must(
  run("setup: depositor applies the pending balance", [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: depositor.token,
      tokenAccount: await tokenOf(depositor.token),
      authority: depositor.signer,
      elgamalSecretKey: depositor.keys.secret(),
      aesKey: depositor.aes,
    }),
  ]),
);

/** An ordinary confidential transfer from the depositor, proofs in context accounts, one transaction. */
async function fundingTransfer(destination: Address, amount: bigint): Promise<Instruction[]> {
  const plan = await getConfidentialTransferInstructionPlan({
    sourceToken: depositor.token,
    mint: mint.address,
    destinationToken: destination,
    sourceTokenAccount: await tokenOf(depositor.token),
    destinationTokenAccount: await tokenOf(destination),
    authority: depositor.signer,
    amount,
    sourceElgamalKeypair: depositor.keys,
    aesKey: depositor.aes,
    payer,
    rpc,
  });
  return flatten(plan);
}

// ---------------------------------------------------------------------------
// An escrow: the token account of a PDA of the throwaway program, with an
// ElGamal keypair and an AES key that only this script holds.
// ---------------------------------------------------------------------------

type Escrow = { nonce: bigint; authority: Address; token: Address; keys: ElGamalKeypair; aes: AeKey };
async function escrow(nonce: bigint): Promise<Escrow> {
  const authority = await escrowAuthority(PROGRAM, nonce);
  const [token] = await findAssociatedTokenPda({
    owner: authority,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint: mint.address,
  });
  return { nonce, authority, token, keys: new ElGamalKeypair(), aes: new AeKey() };
}

const createAta = (e: Escrow) =>
  getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: e.token,
    owner: e.authority,
    mint: mint.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
const reallocate = (e: Escrow) =>
  getReallocateInstruction({
    token: e.token,
    payer,
    owner: e.authority,
    newExtensionTypes: [ExtensionType.ConfidentialTransferAccount],
  });
const configure = (e: Escrow, proof: { context: Address } | { offset: number }) =>
  getConfigureConfidentialTransferAccountInstruction({
    token: e.token,
    mint: mint.address,
    instructionsSysvarOrContextState: "context" in proof ? proof.context : SYSVAR_INSTRUCTIONS,
    authority: e.authority,
    decryptableZeroBalance: e.aes.encrypt(0n).toBytes(),
    maximumPendingBalanceCreditCounter: 65536n,
    proofInstructionOffset: "context" in proof ? 0 : proof.offset,
  });
const pubkeyProof = (e: Escrow) => new Uint8Array(new PubkeyValidityProofData(e.keys).toBytes());
const applyPending = async (e: Escrow) =>
  getApplyConfidentialPendingBalanceInstructionFromToken({
    token: e.token,
    tokenAccount: await tokenOf(e.token),
    authority: e.authority,
    elgamalSecretKey: e.keys.secret(),
    aesKey: e.aes,
  });
const disableCredits = (e: Escrow) =>
  getDisableConfidentialCreditsInstruction({ token: e.token, authority: e.authority });
const disablePublicCredits = (e: Escrow) =>
  getDisableNonConfidentialCreditsInstruction({ token: e.token, authority: e.authority });
const closeEscrow = (e: Escrow) =>
  getCloseAccountInstruction({ account: e.token, destination: payer.address, owner: e.authority });
const closeContext = (e: Escrow, context: Address) =>
  closeContextStateProof({
    contextState: context,
    authority: createNoopSigner(e.authority),
    destination: payer.address,
  });
const emptyAccount = (e: Escrow, proof: { context: Address } | { offset: number }) =>
  getEmptyConfidentialTransferAccountInstruction({
    token: e.token,
    instructionsSysvarOrContextState: "context" in proof ? proof.context : SYSVAR_INSTRUCTIONS,
    authority: e.authority,
    proofInstructionOffset: "context" in proof ? 0 : proof.offset,
  });

/** The escrow's available balance: ciphertext from chain, plaintext by the AES key. */
async function available(e: Escrow) {
  const state = confidentialState(await tokenOf(e.token));
  const balance = e.aes.decrypt(AeCiphertext.fromBytes(new Uint8Array(state.decryptableAvailableBalance))!);
  return { state, ciphertext: new Uint8Array(state.availableBalance), balance };
}

type Offsets = { equality: number; validity: number; range: number };
async function transferOut(
  e: Escrow,
  amount: bigint,
  proofs: ReturnType<typeof transferProofs>,
  location: { contexts: { equality: Address; validity: Address; range: Address } } | { offsets: Offsets },
  destination: Address = recipient.token,
) {
  const inline = "offsets" in location;
  return getConfidentialTransferInstruction({
    sourceToken: e.token,
    mint: mint.address,
    destinationToken: destination,
    ...(inline
      ? { instructionsSysvar: SYSVAR_INSTRUCTIONS }
      : {
          equalityRecord: location.contexts.equality,
          ciphertextValidityRecord: location.contexts.validity,
          rangeRecord: location.contexts.range,
        }),
    authority: e.authority,
    newSourceDecryptableAvailableBalance: e.aes.encrypt(proofs.newBalance).toBytes(),
    transferAmountAuditorCiphertextLo: proofs.auditorLo,
    transferAmountAuditorCiphertextHi: proofs.auditorHi,
    equalityProofInstructionOffset: inline ? location.offsets.equality : 0,
    ciphertextValidityProofInstructionOffset: inline ? location.offsets.validity : 0,
    rangeProofInstructionOffset: inline ? location.offsets.range : 0,
  });
}

async function proofsFor(
  e: Escrow,
  amount: bigint,
  from?: { ciphertext: Uint8Array; balance: bigint },
  destination: Address = recipient.token,
) {
  const current = from ?? (await available(e));
  return transferProofs({
    sourceKeypair: e.keys,
    available: current.ciphertext,
    balance: current.balance,
    amount,
    destination: elgamalPubkeyOf(confidentialState(await tokenOf(destination)).elgamalPubkey),
  });
}

/** Verifies the three transfer proofs into context accounts owned by the escrow authority, one transaction each. */
async function stageTransferProofs(
  e: Escrow,
  proofs: ReturnType<typeof transferProofs>,
  label: string,
  splitRange = false,
) {
  const equality = await proofInContext(rpc, payer, verifyCiphertextCommitmentEquality, proofs.equality, e.authority);
  const validity = await proofInContext(
    rpc,
    payer,
    verifyBatchedGroupedCiphertext3HandlesValidity,
    proofs.validity,
    e.authority,
  );
  const range = await proofInContext(rpc, payer, verifyBatchedRangeProofU128, proofs.range, e.authority);
  await must(run(`${label}: equality proof into a context account`, equality.instructions));
  await must(run(`${label}: validity proof into a context account`, validity.instructions));
  if (splitRange) {
    // The account creation and the verification as two transactions, to see
    // whether the verification alone fits a version 0 transaction.
    if (range.instructions.length !== 2) throw new Error("expected a create and a verify instruction");
    await must(run(`${label}: range proof, create the context account`, [range.instructions[0] as Instruction]));
    await must(run(`${label}: range proof, verify into the existing context account`, [range.instructions[1] as Instruction]));
  } else {
    await must(run(`${label}: range proof into a context account`, range.instructions));
  }
  return { equality: equality.address, validity: validity.address, range: range.address };
}

// ---------------------------------------------------------------------------
// Question 2: one CPI per transaction, pass or fail per step.
// ---------------------------------------------------------------------------

console.log("\n== question 2: step by step, escrow 1 ==");
const e1 = await escrow(1n);
await must(run("escrow 1: create the PDA's token account (top level)", [createAta(e1)]));

await run("2.1 Reallocate by CPI", [cpi(e1.nonce, e1.authority, [reallocate(e1)])]);

const e1Pubkey = await proofInContext(rpc, payer, verifyPubkeyValidity, pubkeyProof(e1), e1.authority);
await must(run("escrow 1: pubkey validity proof into a context account", e1Pubkey.instructions));
await run("2.2 ConfigureAccount by CPI, proof in a context account", [
  cpi(e1.nonce, e1.authority, [configure(e1, { context: e1Pubkey.address })]),
]);
{
  const state = confidentialState(await tokenOf(e1.token));
  check(
    "escrow 1 carries the escrow ElGamal key and is approved",
    state.approved === true && state.elgamalPubkey === getAddressDecoder().decode(e1.keys.pubkey().toBytes()),
    `approved ${state.approved}`,
  );
}

await must(run("escrow 1: depositor funds 100 by confidential transfer (top level)", await fundingTransfer(e1.token, 100n * UNIT)));
{
  const state = confidentialState(await tokenOf(e1.token));
  check("the funding sits in the pending balance", state.pendingBalanceCreditCounter === 1n, `credit counter ${state.pendingBalanceCreditCounter}`);
}

await run("2.3 ApplyPendingBalance by CPI", [cpi(e1.nonce, e1.authority, [await applyPending(e1)])]);
{
  const now = await available(e1);
  check("escrow 1 available balance decrypts to 100", now.balance === 100n * UNIT, `${now.balance}`);
  check("pending credit counter back to 0", now.state.pendingBalanceCreditCounter === 0n);
}

await run("2.4 DisableConfidentialCredits by CPI", [cpi(e1.nonce, e1.authority, [disableCredits(e1)])]);
{
  const state = confidentialState(await tokenOf(e1.token));
  check("allowConfidentialCredits is false", state.allowConfidentialCredits === false);
}
await run("2.4b a confidential transfer into the locked escrow is refused", await fundingTransfer(e1.token, 1n * UNIT), {
  expect: "fail",
});

// 2.5 Transfer of 60 that reads three context state accounts.
const first = await proofsFor(e1, 60n * UNIT);
const firstContexts = await stageTransferProofs(e1, first, "escrow 1, transfer of 60");
await run("2.5 confidential Transfer by CPI, proofs in context accounts", [
  cpi(e1.nonce, e1.authority, [await transferOut(e1, 60n * UNIT, first, { contexts: firstContexts })]),
]);
{
  const now = await available(e1);
  check("escrow 1 available balance decrypts to 40", now.balance === 40n * UNIT, `${now.balance}`);
  check(
    "the new balance ciphertext is the one computed before the transfer",
    Buffer.from(now.ciphertext).equals(Buffer.from(first.newCiphertext)),
  );
}

await run("2.6 CloseContextState by CPI, three accounts, PDA is their authority", [
  cpi(e1.nonce, e1.authority, [
    closeContext(e1, firstContexts.equality),
    closeContext(e1, firstContexts.validity),
    closeContext(e1, firstContexts.range),
  ]),
]);
check(
  "the three context accounts are gone",
  !(await exists(firstContexts.equality)) && !(await exists(firstContexts.validity)) && !(await exists(firstContexts.range)),
);

// 2.7 Transfers with the three proofs in the same transaction.
console.log("\n== question 2: proofs inline, what the instruction offset means under CPI ==");
{
  // Proofs before the program's instruction: offsets -3, -2, -1.
  const proofs = await proofsFor(e1, 15n * UNIT);
  const instructions = [
    await proofInline(rpc, payer, verifyCiphertextCommitmentEquality, proofs.equality),
    await proofInline(rpc, payer, verifyBatchedGroupedCiphertext3HandlesValidity, proofs.validity),
    await proofInline(rpc, payer, verifyBatchedRangeProofU128, proofs.range),
  ];
  const before = [
    ...instructions,
    cpi(e1.nonce, e1.authority, [
      await transferOut(e1, 15n * UNIT, proofs, { offsets: { equality: -3, validity: -2, range: -1 } }),
    ]),
  ];
  // The same proofs with offsets that point at the wrong proof instructions.
  const wrong = [
    ...instructions,
    cpi(e1.nonce, e1.authority, [
      await transferOut(e1, 15n * UNIT, proofs, { offsets: { equality: -1, validity: -2, range: -3 } }),
    ]),
  ];
  // An unrelated top level instruction between the proofs and the program's
  // instruction: the offsets must then count it.
  const filler = getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: recipient.token,
    owner: recipient.signer.address,
    mint: mint.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const shiftedStale = [
    ...instructions,
    filler,
    cpi(e1.nonce, e1.authority, [
      await transferOut(e1, 15n * UNIT, proofs, { offsets: { equality: -3, validity: -2, range: -1 } }),
    ]),
  ];
  await run("2.7x inline proofs, offsets pointing at the wrong proofs (simulated)", wrong, { expect: "fail" });
  await run("2.7y inline proofs, a filler instruction not counted in the offsets (simulated)", shiftedStale, {
    expect: "fail",
  });
  await run("2.7a confidential Transfer by CPI, proofs inline before it, offsets -3 -2 -1", before);
  const now = await available(e1);
  check("escrow 1 available balance decrypts to 25", now.balance === 25n * UNIT, `${now.balance}`);
}
{
  // Proofs after the program's instruction: offsets +1, +2, +3, and two CPIs
  // before the Transfer inside the same program instruction, to show that
  // inner instructions are not counted.
  const proofs = await proofsFor(e1, 25n * UNIT);
  const after = [
    cpi(e1.nonce, e1.authority, [
      createAta(e1),
      createAta(e1),
      await transferOut(e1, 25n * UNIT, proofs, { offsets: { equality: 1, validity: 2, range: 3 } }),
    ]),
    await proofInline(rpc, payer, verifyCiphertextCommitmentEquality, proofs.equality),
    await proofInline(rpc, payer, verifyBatchedGroupedCiphertext3HandlesValidity, proofs.validity),
    await proofInline(rpc, payer, verifyBatchedRangeProofU128, proofs.range),
  ];
  await run("2.7b confidential Transfer as the third CPI, proofs inline after it, offsets +1 +2 +3", after);
  const now = await available(e1);
  check("escrow 1 available balance decrypts to 0", now.balance === 0n, `${now.balance}`);
}

// 2.8 to 2.10: empty, close, and the remaining context accounts.
console.log("\n== question 2: empty and close, escrow 1 ==");
await run("2.8x CloseAccount by CPI before EmptyAccount is refused (simulated)", [cpi(e1.nonce, e1.authority, [closeEscrow(e1)])], {
  expect: "fail",
});
const e1Zero = await proofInContext(
  rpc,
  payer,
  verifyZeroCiphertext,
  new Uint8Array(new ZeroCiphertextProofData(e1.keys, ciphertext((await available(e1)).ciphertext)).toBytes()),
  e1.authority,
);
await must(run("escrow 1: zero ciphertext proof into a context account", e1Zero.instructions));
await run("2.8 EmptyAccount by CPI, proof in a context account", [
  cpi(e1.nonce, e1.authority, [emptyAccount(e1, { context: e1Zero.address })]),
]);
await run("2.9 CloseAccount by CPI", [cpi(e1.nonce, e1.authority, [closeEscrow(e1)])]);
check("the escrow token account is gone", !(await exists(e1.token)));
await run("2.10 CloseContextState by CPI, the two remaining accounts", [
  cpi(e1.nonce, e1.authority, [closeContext(e1, e1Zero.address), closeContext(e1, e1Pubkey.address)]),
]);
check("the last two context accounts are gone", !(await exists(e1Zero.address)) && !(await exists(e1Pubkey.address)));

// ---------------------------------------------------------------------------
// Question 3: a Create and a Settle as one program instruction each.
// ---------------------------------------------------------------------------

console.log("\n== question 3: Create for one confidential leg ==");
const e2 = await escrow(2n);
const e2Pubkey = await proofInContext(rpc, payer, verifyPubkeyValidity, pubkeyProof(e2), e2.authority);
await must(run("escrow 2: pubkey validity proof into a context account", e2Pubkey.instructions));
await run("3.1 Create, one instruction, 4 CPIs: create account, Reallocate, ConfigureAccount (context proof), DisableNonConfidentialCredits", [
  cpi(e2.nonce, e2.authority, [
    createAta(e2),
    reallocate(e2),
    configure(e2, { context: e2Pubkey.address }),
    disablePublicCredits(e2),
  ]),
]);

const e3 = await escrow(3n);
await run("3.2 Create, same 4 CPIs, pubkey validity proof inline as the next instruction (offset +1)", [
  cpi(e3.nonce, e3.authority, [createAta(e3), reallocate(e3), configure(e3, { offset: 1 }), disablePublicCredits(e3)]),
  await proofInline(rpc, payer, verifyPubkeyValidity, pubkeyProof(e3)),
]);
{
  const state = confidentialState(await tokenOf(e3.token));
  check("escrow 3 is configured and refuses public credits", state.approved === true && state.allowNonConfidentialCredits === false);
}
await run(
  "3.2x a public TransferChecked into an escrow that refuses public credits (simulated)",
  [
    getTransferCheckedInstruction({
      source: depositor.token,
      mint: mint.address,
      destination: e3.token,
      authority: depositor.signer,
      amount: 1n * UNIT,
      decimals: DECIMALS,
    }),
  ],
  { expect: "fail" },
);

console.log("\n== question 3: Lock and Settle for one confidential leg ==");
for (const e of [e2, e3]) {
  await must(run(`escrow ${e.nonce}: depositor funds 100 by confidential transfer (top level)`, await fundingTransfer(e.token, 100n * UNIT)));
}
await run("3.3 Lock, one instruction, 2 CPIs: ApplyPendingBalance, DisableConfidentialCredits", [
  cpi(e2.nonce, e2.authority, [await applyPending(e2), disableCredits(e2)]),
]);
await must(run("escrow 3: Lock", [cpi(e3.nonce, e3.authority, [await applyPending(e3), disableCredits(e3)])]));

/** Every proof of a Settle that pays the whole balance, verified before the Settle exists. */
async function stageSettle(e: Escrow, destination: Address = recipient.token, splitRange = false) {
  const now = await available(e);
  const proofs = await proofsFor(e, now.balance, now, destination);
  const contexts = await stageTransferProofs(e, proofs, `escrow ${e.nonce}, settle`, splitRange);
  // The zero proof is for the balance the transfer will leave, which nobody
  // has seen onchain yet.
  const zero = await proofInContext(
    rpc,
    payer,
    verifyZeroCiphertext,
    new Uint8Array(new ZeroCiphertextProofData(e.keys, ciphertext(proofs.newCiphertext)).toBytes()),
    e.authority,
  );
  await must(run(`escrow ${e.nonce}, settle: zero ciphertext proof for the balance after the transfer`, zero.instructions));
  return { amount: now.balance, proofs, contexts, zero: zero.address };
}

const s2 = await stageSettle(e2);
await run("3.4 Settle, one instruction, 3 CPIs: Transfer (context proofs), EmptyAccount (context proof), CloseAccount", [
  cpi(e2.nonce, e2.authority, [
    await transferOut(e2, s2.amount, s2.proofs, { contexts: s2.contexts }),
    emptyAccount(e2, { context: s2.zero }),
    closeEscrow(e2),
  ]),
]);
check("escrow 2 is closed", !(await exists(e2.token)));
await run("3.4b after Settle: CloseContextState by CPI, the five context accounts of escrow 2", [
  cpi(e2.nonce, e2.authority, [
    closeContext(e2, s2.contexts.equality),
    closeContext(e2, s2.contexts.validity),
    closeContext(e2, s2.contexts.range),
    closeContext(e2, s2.zero),
    closeContext(e2, e2Pubkey.address),
  ]),
]);

const s3 = await stageSettle(e3, recipient.token, true);
await run("3.5 Settle, one instruction, 7 CPIs: Transfer, EmptyAccount, CloseAccount and CloseContextState for the four proof accounts", [
  cpi(e3.nonce, e3.authority, [
    await transferOut(e3, s3.amount, s3.proofs, { contexts: s3.contexts }),
    emptyAccount(e3, { context: s3.zero }),
    closeEscrow(e3),
    closeContext(e3, s3.contexts.equality),
    closeContext(e3, s3.contexts.validity),
    closeContext(e3, s3.contexts.range),
    closeContext(e3, s3.zero),
  ]),
]);
check("escrow 3 is closed", !(await exists(e3.token)));
check(
  "its four proof accounts are gone",
  !(await exists(s3.contexts.equality)) && !(await exists(s3.contexts.validity)) && !(await exists(s3.contexts.range)) && !(await exists(s3.zero)),
);

// Two escrows settled in one transaction, as an approximation of a Settle with
// two confidential legs: one program instruction per escrow here (a DvP would
// use one PDA and one instruction), the same mint for both (a DvP has two),
// and different destinations.
console.log("\n== question 3: two confidential escrows settled in one transaction ==");
const e4 = await escrow(4n);
const e5 = await escrow(5n);
for (const e of [e4, e5]) {
  await must(
    run(`escrow ${e.nonce}: Create with the proof inline`, [
      cpi(e.nonce, e.authority, [createAta(e), reallocate(e), configure(e, { offset: 1 }), disablePublicCredits(e)]),
      await proofInline(rpc, payer, verifyPubkeyValidity, pubkeyProof(e)),
    ]),
  );
  await must(run(`escrow ${e.nonce}: depositor funds 100 by confidential transfer (top level)`, await fundingTransfer(e.token, 100n * UNIT)));
  await must(run(`escrow ${e.nonce}: Lock`, [cpi(e.nonce, e.authority, [await applyPending(e), disableCredits(e)])]));
}
const s4 = await stageSettle(e4, recipient.token);
const s5 = await stageSettle(e5, depositor.token);
const settleOf = async (e: Escrow, s: Awaited<ReturnType<typeof stageSettle>>, destination: Address, closeProofs: boolean) =>
  cpi(e.nonce, e.authority, [
    await transferOut(e, s.amount, s.proofs, { contexts: s.contexts }, destination),
    emptyAccount(e, { context: s.zero }),
    closeEscrow(e),
    ...(closeProofs
      ? [
          closeContext(e, s.contexts.equality),
          closeContext(e, s.contexts.validity),
          closeContext(e, s.contexts.range),
          closeContext(e, s.zero),
        ]
      : []),
  ]);
await run(
  "3.6x two escrows, each Transfer, EmptyAccount, CloseAccount, without closing the proof accounts (simulated)",
  [await settleOf(e4, s4, recipient.token, false), await settleOf(e5, s5, depositor.token, false)],
  { simulateOnly: true },
);
await run("3.6 two escrows, each Transfer, EmptyAccount, CloseAccount and four CloseContextState: 14 CPIs in one transaction", [
  await settleOf(e4, s4, recipient.token, true),
  await settleOf(e5, s5, depositor.token, true),
]);
check("escrows 4 and 5 are closed", !(await exists(e4.token)) && !(await exists(e5.token)));

// The recipient received 60 + 15 + 25 + 100 + 100 + 100 = 400 across six credits.
console.log("\n== end state ==");
await must(
  run("recipient applies the pending balance", [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: recipient.token,
      tokenAccount: await tokenOf(recipient.token),
      authority: recipient.signer,
      elgamalSecretKey: recipient.keys.secret(),
      aesKey: recipient.aes,
    }),
  ]),
);
{
  const state = confidentialState(await tokenOf(recipient.token));
  const balance = recipient.aes.decrypt(AeCiphertext.fromBytes(new Uint8Array(state.decryptableAvailableBalance))!);
  check("the recipient's confidential balance decrypts to 400", balance === 400n * UNIT, `${balance}`);
}
check("no escrow account of the three is left", !(await fetchMaybeToken(rpc, e1.token)).exists && !(await exists(e2.token)) && !(await exists(e3.token)));

const unexpected = results.filter((result) => (result.ok ? "pass" : "fail") !== result.expected);
const badChecks = checks.filter((entry) => !entry.ok);
writeFileSync(
  resultsFile,
  json({
    rpcUrl,
    program: PROGRAM,
    mint: mint.address,
    steps: results,
    checks,
    summary: { steps: results.length, unexpected: unexpected.map((result) => result.name), badChecks: badChecks.map((entry) => entry.name) },
  }),
);
console.log(`\n${results.length} steps, ${unexpected.length} not as expected, ${badChecks.length} bad state checks. Results: ${resultsFile}`);
process.exit(unexpected.length + badChecks.length === 0 ? 0 : 1);
