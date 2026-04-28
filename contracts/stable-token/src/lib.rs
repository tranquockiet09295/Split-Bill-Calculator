#![no_std]

// Minimal SEP-41 token used as the settlement currency for BillSplit.
// `BillSplit::settle` does an inter-contract `transfer(from=payer, to=creator,
// amount=share)` against this token to actually move funds — no off-chain
// payment leg needed.

use soroban_sdk::token::TokenInterface;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env,
    MuxedAddress, String, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    NegativeAmount = 4,
    AllowanceExpired = 5,
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Decimals,
    Name,
    Symbol,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
}

#[contract]
pub struct StableToken;

#[contractimpl]
impl StableToken {
    pub fn __constructor(
        env: Env,
        admin: Address,
        decimal: u32,
        name: String,
        symbol: String,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimal);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
    }

    /// Admin-only: mint `amount` to `to`.
    pub fn mint(env: Env, to: Address, amount: i128) {
        check_nonneg(&env, amount);
        let admin = read_admin(&env);
        admin.require_auth();
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        bump_supply(&env, amount);
        env.events()
            .publish((Symbol::new(&env, "mint"), admin, to.clone()), amount);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((Symbol::new(&env, "set_admin"), admin), new_admin);
    }

    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }
}

#[contractimpl]
impl TokenInterface for StableToken {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = DataKey::Allowance(from, spender);
        match env.storage().temporary().get::<DataKey, AllowanceData>(&key) {
            Some(a) if a.expiration_ledger >= env.ledger().sequence() => a.amount,
            _ => 0,
        }
    }

    fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        check_nonneg(&env, amount);
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().temporary().set(
            &key,
            &AllowanceData {
                amount,
                expiration_ledger,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        check_nonneg(&env, amount);
        let to_addr = to.address();
        spend_balance(&env, &from, amount);
        write_balance(&env, &to_addr, read_balance(&env, &to_addr) + amount);
        env.events()
            .publish((Symbol::new(&env, "transfer"), from, to_addr), amount);
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        check_nonneg(&env, amount);
        spend_allowance(&env, &from, &spender, amount);
        spend_balance(&env, &from, amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        env.events()
            .publish((Symbol::new(&env, "transfer"), from, to), amount);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        check_nonneg(&env, amount);
        spend_balance(&env, &from, amount);
        bump_supply(&env, -amount);
        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        check_nonneg(&env, amount);
        spend_allowance(&env, &from, &spender, amount);
        spend_balance(&env, &from, amount);
        bump_supply(&env, -amount);
        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(0)
    }

    fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn check_nonneg(env: &Env, amount: i128) {
    if amount < 0 {
        panic_with_error!(env, Error::NegativeAmount);
    }
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::Balance(id.clone()), &amount);
}

fn spend_balance(env: &Env, id: &Address, amount: i128) {
    let bal = read_balance(env, id);
    if bal < amount {
        panic_with_error!(env, Error::InsufficientBalance);
    }
    write_balance(env, id, bal - amount);
}

fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let key = DataKey::Allowance(from.clone(), spender.clone());
    let allowance: AllowanceData = env.storage().temporary().get(&key).unwrap_or(AllowanceData {
        amount: 0,
        expiration_ledger: 0,
    });
    if allowance.expiration_ledger < env.ledger().sequence() {
        panic_with_error!(env, Error::AllowanceExpired);
    }
    if allowance.amount < amount {
        panic_with_error!(env, Error::InsufficientAllowance);
    }
    env.storage().temporary().set(
        &key,
        &AllowanceData {
            amount: allowance.amount - amount,
            expiration_ledger: allowance.expiration_ledger,
        },
    );
}

fn bump_supply(env: &Env, delta: i128) {
    let supply: i128 = env
        .storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::TotalSupply, &(supply + delta));
}

mod test;
