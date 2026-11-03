//! # Unbound redemption-return escrow
//!
//! The one place Unbound uses Soroban (see `docs/adr/0002-soroban-redemption-escrow.md`).
//!
//! A consumer redeeming merchant credit returns it to the issuer. With a plain classic payment the
//! credit reaches (and is burned by) the issuer immediately, so a merchant that then rejects or
//! ignores the redemption leaves the consumer with nothing on-chain: only an off-chain refund
//! promise. This contract holds the returned credit instead:
//!
//! * `open_return` - the consumer authorizes moving `amount` of the issued credit (through its
//!   Stellar Asset Contract) into escrow, keyed by a single-use `redemption_id`.
//! * `confirm` - the issuer confirms fulfilment; the credit goes to the issuer (a SAC transfer to
//!   the issuer burns it).
//! * `reject` - the issuer rejects; the credit is refunded to the consumer.
//! * `expire_refund` - anyone may refund the consumer once `deadline` has passed without an answer.
//!
//! Invariant: for every token, the escrow's token balance equals `locked(token)`, which equals the
//! sum of the amounts of all `Open` returns for that token. TESTNET ONLY; this contract has not been
//! externally audited.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env,
};

/// Shortest allowed answer window for the merchant (1 hour).
pub const MIN_WINDOW_SECS: u64 = 3_600;
/// Longest allowed escrow window (30 days); keeps consumer funds from being locked indefinitely.
pub const MAX_WINDOW_SECS: u64 = 30 * 24 * 3_600;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
/// Records outlive the longest window by a wide margin so single-use ids stay observable.
const RECORD_BUMP: u32 = 120 * DAY_IN_LEDGERS;
const RECORD_THRESHOLD: u32 = RECORD_BUMP - 7 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    DeadlineTooSoon = 4,
    DeadlineTooFar = 5,
    DuplicateRedemption = 6,
    NotFound = 7,
    NotOpen = 8,
    DeadlineNotReached = 9,
    DeadlinePassed = 10,
    IssuerMismatch = 11,
    SameParty = 12,
    Paused = 13,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ReturnStatus {
    /// Credit is held by the escrow, waiting for the issuer.
    Open,
    /// Issuer confirmed fulfilment; credit went to the issuer.
    Confirmed,
    /// Issuer rejected; credit was refunded to the consumer.
    Rejected,
    /// Deadline passed without an answer; credit was refunded to the consumer.
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowedReturn {
    pub consumer: Address,
    pub issuer: Address,
    pub token: Address,
    pub amount: i128,
    /// Ledger timestamp (unix seconds) after which only a refund is possible.
    pub deadline: u64,
    pub opened_at: u64,
    pub status: ReturnStatus,
    /// Ledger timestamp of the confirm / reject / expiry; 0 while open.
    pub closed_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Paused,
    Return(BytesN<32>),
    Locked(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReturnOpened {
    #[topic]
    pub redemption_id: BytesN<32>,
    pub consumer: Address,
    pub issuer: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReturnConfirmed {
    #[topic]
    pub redemption_id: BytesN<32>,
    pub issuer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReturnRejected {
    #[topic]
    pub redemption_id: BytesN<32>,
    pub consumer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReturnExpired {
    #[topic]
    pub redemption_id: BytesN<32>,
    pub consumer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedChanged {
    pub paused: bool,
}

#[contract]
pub struct RedemptionEscrow;

#[contractimpl]
impl RedemptionEscrow {
    /// One-time initialization. The admin can only pause/unpause *new* returns; it can never move
    /// escrowed funds, and refunds/confirmations keep working while paused.
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&env);
    }

    /// Consumer returns `amount` of `token` (the issuer's Stellar Asset Contract) into escrow.
    pub fn open_return(
        env: Env,
        consumer: Address,
        issuer: Address,
        token: Address,
        amount: i128,
        redemption_id: BytesN<32>,
        deadline: u64,
    ) {
        require_init(&env);
        if Self::is_paused(env.clone()) {
            panic_with_error!(&env, EscrowError::Paused);
        }
        consumer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        if consumer == issuer {
            panic_with_error!(&env, EscrowError::SameParty);
        }
        let now = env.ledger().timestamp();
        if deadline < now.saturating_add(MIN_WINDOW_SECS) {
            panic_with_error!(&env, EscrowError::DeadlineTooSoon);
        }
        if deadline > now.saturating_add(MAX_WINDOW_SECS) {
            panic_with_error!(&env, EscrowError::DeadlineTooFar);
        }
        let key = DataKey::Return(redemption_id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, EscrowError::DuplicateRedemption);
        }
        // Fail closed: only the asset's own issuer (the SAC admin) may receive its returned credit.
        // A non-SAC token without `admin()` traps here, which is also a refusal.
        if token::StellarAssetClient::new(&env, &token).admin() != issuer {
            panic_with_error!(&env, EscrowError::IssuerMismatch);
        }

        token::TokenClient::new(&env, &token).transfer(
            &consumer,
            env.current_contract_address(),
            &amount,
        );

        let record = EscrowedReturn {
            consumer: consumer.clone(),
            issuer: issuer.clone(),
            token: token.clone(),
            amount,
            deadline,
            opened_at: now,
            status: ReturnStatus::Open,
            closed_at: 0,
        };
        env.storage().persistent().set(&key, &record);
        bump_record(&env, &key);
        add_locked(&env, &token, amount);
        bump_instance(&env);

        ReturnOpened {
            redemption_id,
            consumer,
            issuer,
            token,
            amount,
            deadline,
        }
        .publish(&env);
    }

    /// Issuer confirms fulfilment before the deadline: the credit goes to the issuer.
    pub fn confirm(env: Env, redemption_id: BytesN<32>) {
        let (key, mut r) = load_open(&env, &redemption_id);
        r.issuer.require_auth();
        let now = env.ledger().timestamp();
        if now >= r.deadline {
            panic_with_error!(&env, EscrowError::DeadlinePassed);
        }
        let issuer = r.issuer.clone();
        close(&env, &key, &mut r, ReturnStatus::Confirmed, &issuer, now);
        ReturnConfirmed {
            redemption_id,
            issuer,
            amount: r.amount,
        }
        .publish(&env);
    }

    /// Issuer rejects the redemption: the credit is refunded to the consumer. Allowed at any time
    /// while the return is open (it only ever benefits the consumer).
    pub fn reject(env: Env, redemption_id: BytesN<32>) {
        let (key, mut r) = load_open(&env, &redemption_id);
        r.issuer.require_auth();
        let now = env.ledger().timestamp();
        let consumer = r.consumer.clone();
        close(&env, &key, &mut r, ReturnStatus::Rejected, &consumer, now);
        ReturnRejected {
            redemption_id,
            consumer,
            amount: r.amount,
        }
        .publish(&env);
    }

    /// Anyone may trigger the timeout refund once the deadline has passed.
    pub fn expire_refund(env: Env, redemption_id: BytesN<32>) {
        let (key, mut r) = load_open(&env, &redemption_id);
        let now = env.ledger().timestamp();
        if now < r.deadline {
            panic_with_error!(&env, EscrowError::DeadlineNotReached);
        }
        let consumer = r.consumer.clone();
        close(&env, &key, &mut r, ReturnStatus::Expired, &consumer, now);
        ReturnExpired {
            redemption_id,
            consumer,
            amount: r.amount,
        }
        .publish(&env);
    }

    /// Admin: stop or resume accepting NEW returns (e.g. during a reconciliation discrepancy).
    pub fn set_paused(env: Env, paused: bool) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        bump_instance(&env);
        PausedChanged { paused }.publish(&env);
    }

    pub fn get_return(env: Env, redemption_id: BytesN<32>) -> Option<EscrowedReturn> {
        env.storage()
            .persistent()
            .get(&DataKey::Return(redemption_id))
    }

    /// Total amount of `token` currently held for open returns.
    pub fn locked(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Locked(token))
            .unwrap_or(0)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, EscrowError::NotInitialized))
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }
}

fn require_init(env: &Env) {
    if !env.storage().instance().has(&DataKey::Admin) {
        panic_with_error!(env, EscrowError::NotInitialized);
    }
}

fn load_open(env: &Env, id: &BytesN<32>) -> (DataKey, EscrowedReturn) {
    require_init(env);
    let key = DataKey::Return(id.clone());
    let r: EscrowedReturn = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(env, EscrowError::NotFound));
    if r.status != ReturnStatus::Open {
        panic_with_error!(env, EscrowError::NotOpen);
    }
    (key, r)
}

/// State is written BEFORE the outgoing transfer (checks-effects-interactions).
fn close(
    env: &Env,
    key: &DataKey,
    r: &mut EscrowedReturn,
    status: ReturnStatus,
    to: &Address,
    now: u64,
) {
    r.status = status;
    r.closed_at = now;
    env.storage().persistent().set(key, r);
    bump_record(env, key);
    add_locked(env, &r.token, -r.amount);
    token::TokenClient::new(env, &r.token).transfer(&env.current_contract_address(), to, &r.amount);
    bump_instance(env);
}

fn add_locked(env: &Env, token: &Address, delta: i128) {
    let key = DataKey::Locked(token.clone());
    let cur: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = cur
        .checked_add(delta)
        .unwrap_or_else(|| panic_with_error!(env, EscrowError::InvalidAmount));
    env.storage().persistent().set(&key, &next);
    bump_record(env, &key);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn bump_record(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, RECORD_THRESHOLD, RECORD_BUMP);
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_golden;
