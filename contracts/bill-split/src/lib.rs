#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec,
};

const MAX_PAYERS: u32 = 20;
const MAX_MEMO_LEN: u32 = 80;

#[contracttype]
#[derive(Clone)]
pub struct Bill {
    pub id: u32,
    pub creator: Address,
    pub payers: Vec<Address>,
    pub share: i128,
    pub memo: String,
    pub timestamp: u64,
}

#[contracttype]
pub enum DataKey {
    Token,
    BillCount,
    Bill(u32),
    Settled(u32, Address),
    BillsByCreator(Address),
    BillsByPayer(Address),
}

#[contract]
pub struct BillSplit;

#[contractimpl]
impl BillSplit {
    /// Constructor — wires the BillSplit contract to a settlement token. Every
    /// `settle` invocation does an inter-contract `transfer(payer, creator,
    /// share)` against this token, so the payer must hold at least `share`
    /// units of it (and the contract must be authorized via the wallet's
    /// auth chain — `settle` is a single root call so plain `mock_all_auths`
    /// works in tests).
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::BillCount, &0u32);
    }

    /// Create a new bill. `share` is the per-payer amount in token base units.
    pub fn create_bill(
        env: Env,
        creator: Address,
        payers: Vec<Address>,
        share: i128,
        memo: String,
    ) -> u32 {
        creator.require_auth();
        if share <= 0 {
            panic!("share must be positive");
        }
        if payers.is_empty() {
            panic!("payers required");
        }
        if payers.len() > MAX_PAYERS {
            panic!("too many payers");
        }
        if memo.len() > MAX_MEMO_LEN {
            panic!("memo too long");
        }

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BillCount)
            .unwrap_or(0);
        let next_id = id + 1;
        env.storage().instance().set(&DataKey::BillCount, &next_id);

        let timestamp = env.ledger().timestamp();
        let bill = Bill {
            id: next_id,
            creator: creator.clone(),
            payers: payers.clone(),
            share,
            memo: memo.clone(),
            timestamp,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Bill(next_id), &bill);

        let creator_key = DataKey::BillsByCreator(creator.clone());
        let mut by_creator: Vec<u32> = env
            .storage()
            .persistent()
            .get(&creator_key)
            .unwrap_or_else(|| Vec::new(&env));
        by_creator.push_back(next_id);
        env.storage().persistent().set(&creator_key, &by_creator);

        for payer in payers.iter() {
            let payer_key = DataKey::BillsByPayer(payer.clone());
            let mut by_payer: Vec<u32> = env
                .storage()
                .persistent()
                .get(&payer_key)
                .unwrap_or_else(|| Vec::new(&env));
            by_payer.push_back(next_id);
            env.storage().persistent().set(&payer_key, &by_payer);
        }

        env.events()
            .publish((symbol_short!("created"), creator), (next_id, share, memo));

        next_id
    }

    /// Settle bill `id` for `payer`. Pulls `share` units of the configured
    /// settlement token from `payer` to the bill's `creator` via an
    /// **inter-contract `token::Client::transfer` call**, then marks the
    /// (id, payer) pair as settled and emits a `settled` event.
    pub fn settle(env: Env, id: u32, payer: Address) {
        payer.require_auth();

        let bill: Bill = env
            .storage()
            .persistent()
            .get(&DataKey::Bill(id))
            .expect("bill not found");

        if !bill.payers.contains(&payer) {
            panic!("address is not a payer on this bill");
        }

        let settled_key = DataKey::Settled(id, payer.clone());
        if env.storage().persistent().get(&settled_key).unwrap_or(false) {
            panic!("already settled");
        }

        // Inter-contract call: move funds from payer → creator on the
        // configured token. `payer.require_auth()` above plus the SDK's
        // sub-invocation auth chain means the wallet's signature on the
        // `settle` call also authorizes this transfer.
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("contract not initialized");
        token::Client::new(&env, &token_addr).transfer(&payer, &bill.creator, &bill.share);

        env.storage().persistent().set(&settled_key, &true);

        env.events()
            .publish((symbol_short!("settled"), payer), (id, bill.share));
    }

    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .expect("contract not initialized")
    }

    pub fn get_bill(env: Env, id: u32) -> Bill {
        env.storage()
            .persistent()
            .get(&DataKey::Bill(id))
            .expect("bill not found")
    }

    pub fn is_settled(env: Env, id: u32, payer: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Settled(id, payer))
            .unwrap_or(false)
    }

    pub fn bill_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::BillCount)
            .unwrap_or(0)
    }

    pub fn bills_by_creator(env: Env, creator: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::BillsByCreator(creator))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn bills_by_payer(env: Env, payer: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::BillsByPayer(payer))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

mod test;
