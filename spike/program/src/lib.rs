//! Throwaway program for the DvP confidential leg spike. Not for deployment.
//!
//! One PDA (the "escrow authority") owns a Token-2022 account. The single
//! instruction `relay` runs a list of CPIs, each signed by that PDA, so a
//! test can drive every Token-2022 and ZK ElGamal Proof instruction the
//! proposal needs and see how each behaves under CPI.
//!
//! The program adds no checks of its own beyond the allow list of target
//! programs: it measures mechanics, it is not a design for the escrow.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};

declare_id!("5xhvtBJTUsBwELm9o8B1gW6Rwj86Gmr2b8Hjeyf6SLNd");

pub const AUTHORITY_SEED: &[u8] = b"escrow-authority";

const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ZK_ELGAMAL_PROOF: Pubkey = pubkey!("ZkE1Gama1Proof11111111111111111111111111111");

#[program]
pub mod dvp_spike {
    use super::*;

    /// Runs `counts.len()` CPIs in order, each signed by the escrow authority.
    ///
    /// Remaining accounts, per CPI: the target program, then `counts[i]`
    /// accounts in the order the target instruction expects. `datas[i]` is
    /// the target instruction's data, passed through unchanged. The escrow
    /// authority is marked as a signer wherever it appears; every other
    /// account keeps the signer and writable flags of the transaction.
    pub fn relay(ctx: Context<Relay>, nonce: u64, counts: Vec<u8>, datas: Vec<Vec<u8>>) -> Result<()> {
        require_eq!(counts.len(), datas.len(), SpikeError::LengthMismatch);
        let authority = ctx.accounts.authority.key();
        let nonce_bytes = nonce.to_le_bytes();
        let bump = [ctx.bumps.authority];
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &nonce_bytes, &bump];

        let mut rest = ctx.remaining_accounts;
        for (count, data) in counts.iter().zip(datas) {
            let count = *count as usize;
            require!(rest.len() > count, SpikeError::NotEnoughAccounts);
            let (program, tail) = rest.split_first().unwrap();
            let (accounts, tail) = tail.split_at(count);
            rest = tail;

            require!(
                program.key == &TOKEN_2022 || program.key == &ASSOCIATED_TOKEN || program.key == &ZK_ELGAMAL_PROOF,
                SpikeError::ProgramNotAllowed
            );
            let metas = accounts
                .iter()
                .map(|account| AccountMeta {
                    pubkey: *account.key,
                    is_signer: account.is_signer || account.key == &authority,
                    is_writable: account.is_writable,
                })
                .collect();
            let instruction = Instruction { program_id: *program.key, accounts: metas, data };
            invoke_signed(&instruction, accounts, &[seeds])?;
        }
        require!(rest.is_empty(), SpikeError::LengthMismatch);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Relay<'info> {
    /// CHECK: the escrow authority PDA. It holds no data and only signs CPIs.
    #[account(seeds = [AUTHORITY_SEED, &nonce.to_le_bytes()], bump)]
    pub authority: UncheckedAccount<'info>,
}

#[error_code]
pub enum SpikeError {
    #[msg("counts, datas and the remaining accounts do not line up")]
    LengthMismatch,
    #[msg("fewer remaining accounts than the counts ask for")]
    NotEnoughAccounts,
    #[msg("the target program is not Token-2022, the ATA program or the ZK ElGamal Proof program")]
    ProgramNotAllowed,
}
