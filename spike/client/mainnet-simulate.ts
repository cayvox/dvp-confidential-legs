// DvP confidential leg spike, question 1: does the Token-2022 program
// deployed on mainnet accept confidential transfer instructions today?
//
// Read only. It reads accounts and calls simulateTransaction. It never
// signs and never sends: the transactions carry no signature at all.
//
// Usage: node mainnet-simulate.ts <results file>

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getApplyConfidentialPendingBalanceInstruction,
} from "@solana-program/token-2022";
import { getCreateConfidentialTransferAccountInstructionPlan } from "@solana-program/token-2022/confidential";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getTransactionSize,
  isSome,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";
import { flatten, json } from "./lib.ts";

const [resultsFile] = process.argv.slice(2);
if (!resultsFile) throw new Error("usage: node mainnet-simulate.ts <results file>");

const RPC_URL = "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// Mints to try, in order. The first one that carries ConfidentialTransferMint is used.
const MINT_CANDIDATES = [
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PayPal USD
] as Address[];
// Fee payers to try for the simulation: any system owned account with a few
// SOL works, because the simulation skips signature checks. Nothing is signed
// for these accounts and nothing is sent.
const FEE_PAYER_CANDIDATES = [
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
] as Address[];

const rpc: any = createSolanaRpc(RPC_URL);
const out: Record<string, unknown> = { rpcUrl: RPC_URL, readAt: new Date().toISOString() };

const genesis = await rpc.getGenesisHash().send();
if (genesis !== MAINNET_GENESIS) throw new Error(`not mainnet: genesis hash ${genesis}`);
out.genesisHash = genesis;
out.rpcVersion = await rpc.getVersion().send();

// --- The deployed program ---------------------------------------------------
const program = (await rpc.getAccountInfo(TOKEN_2022_PROGRAM_ADDRESS, { encoding: "base64" }).send()).value;
const programBytes = Buffer.from(program.data[0], "base64");
// An upgradeable program account: u32 tag 2, then the ProgramData address.
const programData = getAddressDecoder().decode(programBytes.subarray(4, 36));
const data = (await rpc.getAccountInfo(programData, { encoding: "base64" }).send()).value;
const dataBytes = Buffer.from(data.data[0], "base64");
// ProgramData: u32 tag 3, u64 slot, option tag, 32 byte upgrade authority, then the ELF.
const deploySlot = dataBytes.readBigUInt64LE(4);
const hasAuthority = dataBytes[12] === 1;
const upgradeAuthority = hasAuthority ? getAddressDecoder().decode(dataBytes.subarray(13, 45)) : null;
const elf = dataBytes.subarray(45);
let end = elf.length;
while (end > 0 && elf[end - 1] === 0) end -= 1;
const deployTime = await rpc.getBlockTime(deploySlot).send().catch(() => null);
out.program = {
  address: TOKEN_2022_PROGRAM_ADDRESS,
  owner: program.owner,
  executable: program.executable,
  programData,
  lastDeploySlot: deploySlot,
  lastDeployBlockTime: deployTime === null ? null : new Date(Number(deployTime) * 1000).toISOString(),
  upgradeAuthority,
  programDataBytes: dataBytes.length,
  elfBytesWithoutTrailingZeros: end,
  // The hash solana-verify prints for an onchain program: SHA-256 of the ELF with trailing zero bytes removed.
  sha256TrimmedElf: createHash("sha256").update(elf.subarray(0, end)).digest("hex"),
  sha256FullElfRegion: createHash("sha256").update(elf).digest("hex"),
};
console.log(json(out.program));

// --- A mint with the confidential transfer extension ------------------------
let mint: Address | null = null;
let mintHasTransferFee = false;
for (const candidate of MINT_CANDIDATES) {
  const account = await fetchMint(rpc, candidate).catch(() => null);
  if (!account || !isSome(account.data.extensions)) continue;
  const extension = (account.data.extensions.value as any[]).find((e) => e.__kind === "ConfidentialTransferMint");
  if (!extension) continue;
  mint = candidate;
  mintHasTransferFee = (account.data.extensions.value as any[]).some((e) => e.__kind === "TransferFeeConfig");
  out.mint = {
    address: candidate,
    owner: account.programAddress,
    decimals: account.data.decimals,
    supply: account.data.supply,
    confidentialTransferMint: extension,
    extensions: (account.data.extensions.value as any[]).map((e) => e.__kind),
  };
  break;
}
if (!mint) throw new Error("no candidate mint carries ConfidentialTransferMint");
console.log(json(out.mint));

// --- A fee payer that exists ------------------------------------------------
let feePayer: Address | null = null;
for (const candidate of FEE_PAYER_CANDIDATES) {
  const account = (await rpc.getAccountInfo(candidate, { encoding: "base64" }).send()).value;
  if (account && account.owner === SYSTEM_PROGRAM && BigInt(account.lamports) > 100_000_000n) {
    feePayer = candidate;
    out.feePayer = { address: candidate, lamports: account.lamports, note: "simulation only, never signed for" };
    break;
  }
}
if (!feePayer) throw new Error("no candidate fee payer is a funded system account");

// --- The simulations --------------------------------------------------------
// A throwaway owner whose key is generated here and discarded: its token
// account does not exist onchain and the simulation does not create it.
const owner = await generateKeyPairSigner();
const keys = new ElGamalKeypair();
const aes = new AeKey();
const [token] = await findAssociatedTokenPda({ owner: owner.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint });
const setup = flatten(
  await getCreateConfidentialTransferAccountInstructionPlan({
    payer: createNoopSigner(feePayer),
    owner: createNoopSigner(owner.address),
    mint,
    rpc,
    elgamalKeypair: keys,
    aesKey: aes,
    // A mint with a transfer fee also needs room for the confidential fee
    // amount on the account; ConfigureAccount answers InvalidAccountData
    // without it (the first attempt of this script, kept in the results folder).
    includeConfidentialTransferFeeAmount: mintHasTransferFee,
  }),
);
// ApplyPendingBalance is compiled into Token-2022 only with its `zk-ops`
// feature, unlike ConfigureAccount. A build without it answers
// InvalidInstructionData.
const apply = getApplyConfidentialPendingBalanceInstruction({
  token,
  authority: createNoopSigner(owner.address),
  expectedPendingBalanceCreditCounter: 0n,
  newDecryptableAvailableBalance: aes.encrypt(0n).toBytes(),
});

async function simulate(name: string, instructions: readonly Instruction[]) {
  const lifetime = (await rpc.getLatestBlockhash().send()).value;
  let message: any = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer as Address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  message = setTransactionMessageComputeUnitLimit(400_000, message);
  const compiled = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(compiled);
  const { value, context } = await rpc
    .simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true })
    .send();
  const result = {
    name,
    slot: context.slot,
    programs: instructions.map((instruction) => instruction.programAddress),
    transactionBytes: getTransactionSize(compiled),
    signaturesInTransaction: Object.values(compiled.signatures).filter((signature) => signature !== null).length,
    err: value.err ?? null,
    unitsConsumed: value.unitsConsumed,
    logs: value.logs,
  };
  console.log(`\n${name}\n${json(result)}`);
  return result;
}

out.throwaway = { owner: owner.address, token, note: "generated for this run, never funded, never created onchain" };
out.simulations = [
  await simulate(
    "A. create the token account, Reallocate, ConfigureAccount, VerifyPubkeyValidity",
    setup,
  ),
  await simulate("B. the same, then ApplyPendingBalance (a zk-ops instruction)", [...setup, apply]),
];
out.tokenAccountExistsAfterwards =
  (await rpc.getAccountInfo(token, { encoding: "base64" }).send()).value !== null;
writeFileSync(resultsFile, json(out));
console.log(`\nthe throwaway token account exists onchain afterwards: ${out.tokenAccountExistsAfterwards}`);
console.log(`results: ${resultsFile}`);
