#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _, token::StellarAssetClient, vec, Address, Env, String,
};

const STARTING_BALANCE: i128 = 10_000_000_000; // 1000 BILL in 7-decimal units

struct Fixture<'a> {
    env: Env,
    client: BillSplitClient<'a>,
    token_addr: Address,
    creator: Address,
    alice: Address,
    bob: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    // settle() does a sub-invocation into the token contract, so the inner
    // auth check must pass without being the root call.
    env.mock_all_auths_allowing_non_root_auth();

    // A SAC stands in for the StableToken — its `transfer(from, to, amount)`
    // signature matches what BillSplit invokes via inter-contract call.
    let sac_admin = Address::generate(&env);
    let token_sac = env.register_stellar_asset_contract_v2(sac_admin);
    let token_addr = token_sac.address();

    // Deploy BillSplit pointing at this token.
    let contract_id = env.register(BillSplit, (token_addr.clone(),));
    let client = BillSplitClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Mint starting tokens to the payers so they can settle.
    let admin_client = StellarAssetClient::new(&env, &token_addr);
    admin_client.mint(&alice, &STARTING_BALANCE);
    admin_client.mint(&bob, &STARTING_BALANCE);

    Fixture {
        env,
        client,
        token_addr,
        creator,
        alice,
        bob,
    }
}

#[test]
fn create_bill_records_state_and_returns_incrementing_id() {
    let f = setup();
    let payers = vec![&f.env, f.alice.clone(), f.bob.clone()];
    let share: i128 = 50_000_000;

    let id1 = f.client.create_bill(
        &f.creator,
        &payers,
        &share,
        &String::from_str(&f.env, "Dinner"),
    );
    let id2 = f.client.create_bill(
        &f.creator,
        &payers,
        &share,
        &String::from_str(&f.env, "Cab"),
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(f.client.bill_count(), 2);

    let bill = f.client.get_bill(&id1);
    assert_eq!(bill.creator, f.creator);
    assert_eq!(bill.share, share);
    assert_eq!(bill.payers.len(), 2);
    assert_eq!(bill.memo, String::from_str(&f.env, "Dinner"));

    assert_eq!(f.client.bills_by_creator(&f.creator).len(), 2);
    assert_eq!(f.client.bills_by_payer(&f.alice).len(), 2);
    assert_eq!(f.client.bills_by_payer(&f.bob).len(), 2);
}

#[test]
fn settle_transfers_tokens_via_inter_contract_call() {
    let f = setup();
    let payers = vec![&f.env, f.alice.clone(), f.bob.clone()];
    let share: i128 = 50_000_000;

    let id = f.client.create_bill(
        &f.creator,
        &payers,
        &share,
        &String::from_str(&f.env, "Dinner"),
    );

    // Pre-state: alice and bob both at full balance, creator at 0.
    let token = soroban_sdk::token::Client::new(&f.env, &f.token_addr);
    assert_eq!(token.balance(&f.alice), STARTING_BALANCE);
    assert_eq!(token.balance(&f.creator), 0);

    f.client.settle(&id, &f.alice);

    // alice's share moved to creator.
    assert_eq!(token.balance(&f.alice), STARTING_BALANCE - share);
    assert_eq!(token.balance(&f.creator), share);
    assert!(f.client.is_settled(&id, &f.alice));
    assert!(!f.client.is_settled(&id, &f.bob));

    // bob settles too — creator now has both shares.
    f.client.settle(&id, &f.bob);
    assert_eq!(token.balance(&f.bob), STARTING_BALANCE - share);
    assert_eq!(token.balance(&f.creator), share * 2);
}

#[test]
#[should_panic(expected = "share must be positive")]
fn rejects_zero_share() {
    let f = setup();
    let payers = vec![&f.env, f.alice.clone()];
    f.client.create_bill(
        &f.creator,
        &payers,
        &0,
        &String::from_str(&f.env, ""),
    );
}

#[test]
#[should_panic(expected = "payers required")]
fn rejects_empty_payers() {
    let f = setup();
    let payers: Vec<Address> = Vec::new(&f.env);
    f.client.create_bill(
        &f.creator,
        &payers,
        &10,
        &String::from_str(&f.env, ""),
    );
}

#[test]
#[should_panic(expected = "address is not a payer on this bill")]
fn settle_rejects_non_payer() {
    let f = setup();
    let payers = vec![&f.env, f.alice.clone()];
    let id = f.client.create_bill(
        &f.creator,
        &payers,
        &50_000_000,
        &String::from_str(&f.env, ""),
    );
    f.client.settle(&id, &f.bob);
}

#[test]
#[should_panic(expected = "already settled")]
fn settle_rejects_double_settle() {
    let f = setup();
    let payers = vec![&f.env, f.alice.clone()];
    let id = f.client.create_bill(
        &f.creator,
        &payers,
        &50_000_000,
        &String::from_str(&f.env, ""),
    );
    f.client.settle(&id, &f.alice);
    f.client.settle(&id, &f.alice);
}

#[test]
fn token_view_returns_configured_address() {
    let f = setup();
    assert_eq!(f.client.token(), f.token_addr);
}
