#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::TokenInterface,
    Address, Env, String,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Decimal,
    Name,
    Symbol,
    Balance(Address),
    Allowance(AllowanceKey),
    Minter,
    TotalSupply,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

fn write_balance(env: &Env, addr: &Address, amount: i128) {
    env.storage().persistent().set(&DataKey::Balance(addr.clone()), &amount);
}

fn read_balance(env: &Env, addr: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Balance(addr.clone())).unwrap_or(0)
}

fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceData {
    let key = AllowanceKey { from: from.clone(), spender: spender.clone() };
    env.storage()
        .temporary()
        .get(&DataKey::Allowance(key))
        .unwrap_or(AllowanceData { amount: 0, expiration_ledger: 0 })
}

fn write_allowance(env: &Env, from: &Address, spender: &Address, data: AllowanceData) {
    let key = AllowanceKey { from: from.clone(), spender: spender.clone() };
    let ttl = if data.expiration_ledger >= env.ledger().sequence() {
        data.expiration_ledger - env.ledger().sequence()
    } else {
        0
    };
    env.storage().temporary().set(&DataKey::Allowance(key.clone()), &data);
    if ttl > 0 {
        env.storage().temporary().extend_ttl(&DataKey::Allowance(key), ttl, ttl);
    }
}

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    pub fn initialize(env: Env, admin: Address, decimal: u32, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &admin);
        env.storage().instance().set(&DataKey::Decimal, &decimal);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let minter: Address = env.storage().instance().get(&DataKey::Minter).unwrap();
        minter.require_auth();
        assert!(amount > 0, "amount must be positive");
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + amount));
        env.events().publish((symbol_short!("mint"),), (to, amount));
    }

    pub fn set_minter(env: Env, new_minter: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Minter, &new_minter);
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }
}

#[contractimpl]
impl TokenInterface for Token {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let data = read_allowance(&env, &from, &spender);
        if data.expiration_ledger < env.ledger().sequence() { 0 } else { data.amount }
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        assert!(expiration_ledger >= env.ledger().sequence(), "expiration in past");
        write_allowance(&env, &from, &spender, AllowanceData { amount, expiration_ledger });
        env.events().publish((symbol_short!("approve"),), (from, spender, amount, expiration_ledger));
    }

    fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "non-positive amount");
        let from_bal = read_balance(&env, &from);
        assert!(from_bal >= amount, "insufficient balance");
        write_balance(&env, &from, from_bal - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        env.events().publish((symbol_short!("transfer"),), (from, to, amount));
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        assert!(amount > 0, "non-positive amount");
        let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        assert!(allowance >= amount, "insufficient allowance");
        let data = read_allowance(&env, &from, &spender);
        write_allowance(&env, &from, &spender, AllowanceData {
            amount: data.amount - amount,
            expiration_ledger: data.expiration_ledger,
        });
        let from_bal = read_balance(&env, &from);
        assert!(from_bal >= amount, "insufficient balance");
        write_balance(&env, &from, from_bal - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        env.events().publish((symbol_short!("transfer"),), (from, to, amount));
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "non-positive amount");
        let bal = read_balance(&env, &from);
        assert!(bal >= amount, "insufficient balance");
        write_balance(&env, &from, bal - amount);
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events().publish((symbol_short!("burn"),), (from, amount));
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        assert!(allowance >= amount, "insufficient allowance");
        let data = read_allowance(&env, &from, &spender);
        write_allowance(&env, &from, &spender, AllowanceData {
            amount: data.amount - amount,
            expiration_ledger: data.expiration_ledger,
        });
        let bal = read_balance(&env, &from);
        assert!(bal >= amount, "insufficient balance");
        write_balance(&env, &from, bal - amount);
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events().publish((symbol_short!("burn"),), (from, amount));
    }

    fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimal).unwrap()
    }

    fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup(e: &Env) -> (Address, Address, Address) {
        e.mock_all_auths();
        let admin = Address::generate(e);
        let user = Address::generate(e);
        let contract_id = e.register_contract(None, Token);
        let client = TokenClient::new(e, &contract_id);
        client.initialize(
            &admin,
            &7,
            &String::from_str(e, "StellarSwap"),
            &String::from_str(e, "SSW"),
        );
        (contract_id, admin, user)
    }

    #[test]
    fn initialize_sets_metadata() {
        let e = Env::default();
        let (contract_id, admin, _) = setup(&e);
        let client = TokenClient::new(&e, &contract_id);
        assert_eq!(client.decimals(), 7);
        assert_eq!(client.name(), String::from_str(&e, "StellarSwap"));
        assert_eq!(client.symbol(), String::from_str(&e, "SSW"));
        assert_eq!(client.admin(), admin);
        assert_eq!(client.total_supply(), 0);
    }

    #[test]
    fn mint_increases_balance_and_supply() {
        let e = Env::default();
        let (contract_id, _, user) = setup(&e);
        let client = TokenClient::new(&e, &contract_id);
        client.mint(&user, &1000);
        assert_eq!(client.balance(&user), 1000);
        assert_eq!(client.total_supply(), 1000);
    }

    #[test]
    fn transfer_moves_tokens_between_accounts() {
        let e = Env::default();
        let (contract_id, _, user) = setup(&e);
        let recipient = Address::generate(&e);
        let client = TokenClient::new(&e, &contract_id);
        client.mint(&user, &5000);
        client.transfer(&user, &recipient, &2000);
        assert_eq!(client.balance(&user), 3000);
        assert_eq!(client.balance(&recipient), 2000);
    }

    #[test]
    fn approve_and_transfer_from_uses_allowance() {
        let e = Env::default();
        let (contract_id, _, user) = setup(&e);
        let spender = Address::generate(&e);
        let recipient = Address::generate(&e);
        let client = TokenClient::new(&e, &contract_id);
        client.mint(&user, &10000);
        client.approve(&user, &spender, &3000, &e.ledger().sequence() + 100);
        assert_eq!(client.allowance(&user, &spender), 3000);
        client.transfer_from(&spender, &user, &recipient, &1500);
        assert_eq!(client.balance(&recipient), 1500);
        assert_eq!(client.allowance(&user, &spender), 1500);
    }
}
