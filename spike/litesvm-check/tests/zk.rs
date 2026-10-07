//! Does LiteSVM 0.7.0, built as the DvP integration tests build it, run the
//! ZK ElGamal Proof program, and what does its bundled Token-2022 do with a
//! confidential transfer instruction?
//!
//! Run: cargo test -- --nocapture --test-threads 1
//! The Cargo.lock next to Cargo.toml is DvP's, after cargo dropped the packages this crate does not use.
//! Optional: TOKEN_2022_SO=<path to a Token-2022 ELF dumped from mainnet>.

use {
    litesvm::LiteSVM,
    solana_sdk::{
        instruction::Instruction,
        pubkey::Pubkey,
        signature::{Keypair, Signer},
        system_instruction,
        transaction::Transaction,
    },
    solana_zk_sdk::{
        encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
        zk_elgamal_proof_program::{instruction::ProofInstruction, proof_data::PubkeyValidityProofData},
    },
    spl_token_2022::{
        extension::{confidential_transfer, ExtensionType},
        state::{Account, Mint},
    },
    spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation,
};

/// The same construction as DvP's `TestContext::new`
/// (tests/integration-tests/src/utils.rs line 97).
fn svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new().with_sysvars().with_default_programs();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    (svm, payer)
}

fn send(svm: &mut LiteSVM, payer: &Keypair, signers: &[&Keypair], instructions: &[Instruction]) -> Result<u64, String> {
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let transaction =
        Transaction::new_signed_with_payer(instructions, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    match svm.send_transaction(transaction) {
        Ok(meta) => {
            for line in &meta.logs {
                println!("    {line}");
            }
            Ok(meta.compute_units_consumed)
        }
        Err(failed) => {
            for line in &failed.meta.logs {
                println!("    {line}");
            }
            Err(format!("{:?}", failed.err))
        }
    }
}

#[test]
fn a_1_the_proof_program_verifies_a_valid_proof() {
    let (mut svm, payer) = svm();
    let keypair = ElGamalKeypair::new_rand();
    let proof = PubkeyValidityProofData::new(&keypair).unwrap();
    let instruction = ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(None, &proof);
    let result = send(&mut svm, &payer, &[], &[instruction]);
    println!("RESULT a_1 VerifyPubkeyValidity with a valid proof: {result:?}");
    assert!(result.is_ok(), "the proof program did not verify a valid proof");
}

#[test]
fn a_2_the_proof_program_rejects_a_tampered_proof() {
    let (mut svm, payer) = svm();
    let keypair = ElGamalKeypair::new_rand();
    let proof = PubkeyValidityProofData::new(&keypair).unwrap();
    let mut instruction = ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(None, &proof);
    let last = instruction.data.len() - 1;
    instruction.data[last] ^= 1;
    let result = send(&mut svm, &payer, &[], &[instruction]);
    println!("RESULT a_2 VerifyPubkeyValidity with one bit flipped: {result:?}");
    assert!(result.is_err(), "a tampered proof was accepted, so the program does not really verify");
}

/// A mint with ConfidentialTransferMint, a token account, ConfigureAccount
/// with the proof in the same transaction, then ApplyPendingBalance, which
/// Token-2022 compiles only with its `zk-ops` feature.
fn configure_then_apply(svm: &mut LiteSVM, payer: &Keypair) -> (Result<u64, String>, Result<u64, String>) {
    let token_program = spl_token_2022::id();
    let mint = Keypair::new();
    let owner = Keypair::new();
    let account = Keypair::new();
    let mint_len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::ConfidentialTransferMint]).unwrap();
    let account_len =
        ExtensionType::try_calculate_account_len::<Account>(&[ExtensionType::ConfidentialTransferAccount]).unwrap();
    let keypair = ElGamalKeypair::new_rand();
    let aes = AeKey::new_rand();
    let proof = PubkeyValidityProofData::new(&keypair).unwrap();
    let zero = aes.encrypt(0).into();

    let mut instructions = vec![
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(mint_len),
            mint_len as u64,
            &token_program,
        ),
        confidential_transfer::instruction::initialize_mint(&token_program, &mint.pubkey(), None, true, None).unwrap(),
        spl_token_2022::instruction::initialize_mint(&token_program, &mint.pubkey(), &payer.pubkey(), None, 6).unwrap(),
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            svm.minimum_balance_for_rent_exemption(account_len),
            account_len as u64,
            &token_program,
        ),
        spl_token_2022::instruction::initialize_account3(&token_program, &account.pubkey(), &mint.pubkey(), &owner.pubkey())
            .unwrap(),
    ];
    instructions.extend(
        confidential_transfer::instruction::configure_account(
            &token_program,
            &account.pubkey(),
            &mint.pubkey(),
            &zero,
            65536,
            &owner.pubkey(),
            &[],
            ProofLocation::InstructionOffset(1.try_into().unwrap(), &proof),
        )
        .unwrap(),
    );
    println!("  configure:");
    let configure = send(svm, payer, &[&mint, &account, &owner], &instructions);
    println!("  apply pending balance:");
    let apply = send(
        svm,
        payer,
        &[&owner],
        &[confidential_transfer::instruction::apply_pending_balance(
            &token_program,
            &account.pubkey(),
            0,
            &zero,
            &owner.pubkey(),
            &[],
        )
        .unwrap()],
    );
    (configure, apply)
}

#[test]
fn b_1_bundled_token_2022_and_confidential_instructions() {
    let (mut svm, payer) = svm();
    let (configure, apply) = configure_then_apply(&mut svm, &payer);
    println!("RESULT b_1 bundled Token-2022, ConfigureAccount with an inline proof: {configure:?}");
    println!("RESULT b_1 bundled Token-2022, ApplyPendingBalance: {apply:?}");
    assert!(configure.is_ok(), "ConfigureAccount failed on the bundled Token-2022");
}

#[test]
fn b_2_mainnet_token_2022_loaded_into_litesvm() {
    let Ok(path) = std::env::var("TOKEN_2022_SO") else {
        println!("RESULT b_2 skipped: TOKEN_2022_SO is not set");
        return;
    };
    let (mut svm, payer) = svm();
    let bytes = std::fs::read(&path).unwrap();
    let _ = svm.add_program(Pubkey::from(spl_token_2022::id().to_bytes()), &bytes);
    let (configure, apply) = configure_then_apply(&mut svm, &payer);
    println!("RESULT b_2 Token-2022 from {path}, ConfigureAccount with an inline proof: {configure:?}");
    println!("RESULT b_2 Token-2022 from {path}, ApplyPendingBalance: {apply:?}");
}
