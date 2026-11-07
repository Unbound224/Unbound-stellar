#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Error, Event as _, IntoVal, Symbol,
};
use std::vec::Vec as StdVec;

const START: u64 = 1_750_000_000;
const DAY: u64 = 86_400;
/// one whole unit of a 7-decimal Stellar asset, in base units
const UNIT: i128 = 10_000_000;

struct Setup<'a> {
    env: Env,
    escrow: RedemptionEscrowClient<'a>,
    escrow_id: Address,
    admin: Address,
    issuer: Address,
    consumer: Address,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
    sac_issuer: soroban_sdk::testutils::StellarAssetIssuer,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.ledger().set_timestamp(START);
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let consumer = Address::generate(&env);
    let sac_contract = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let issuer = sac_contract.issuer().address();
    // the SAC admin is the issuer, exactly like a classic asset wrapped by its issuer
    let sac = StellarAssetClient::new(&env, &sac_contract.address());
    sac.set_admin(&issuer);
    let token = TokenClient::new(&env, &sac_contract.address());
    sac.mint(&consumer, &(1_000 * UNIT));
    let escrow_id = env.register(RedemptionEscrow, ());
    let escrow = RedemptionEscrowClient::new(&env, &escrow_id);
    escrow.init(&admin);
    let sac_issuer = sac_contract.issuer();
    Setup {
        env,
        escrow,
        escrow_id,
        admin,
        issuer,
        consumer,
        token,
        sac,
        sac_issuer,
    }
}

fn rid(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

type TryResult<T> =
    Result<Result<T, soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>>;

fn err<T>(e: EscrowError) -> TryResult<T> {
    Err(Ok(Error::from_contract_error(e as u32)))
}

impl Setup<'_> {
    fn open(&self, n: u8, amount: i128, deadline: u64) {
        self.escrow.open_return(
            &self.consumer,
            &self.issuer,
            &self.token.address,
            &amount,
            &rid(&self.env, n),
            &deadline,
        );
    }
    fn invariant(&self) {
        assert_eq!(
            self.token.balance(&self.escrow_id),
            self.escrow.locked(&self.token.address)
        );
    }
}

#[test]
fn open_then_confirm_moves_credit_to_issuer() {
    let s = setup();
    s.open(1, 80_0000000, START + DAY);
    assert_eq!(s.token.balance(&s.consumer), 920_0000000);
    assert_eq!(s.token.balance(&s.escrow_id), 80_0000000);
    assert_eq!(s.escrow.locked(&s.token.address), 80_0000000);
    let r = s.escrow.get_return(&rid(&s.env, 1)).unwrap();
    assert_eq!(r.status, ReturnStatus::Open);
    assert_eq!(r.amount, 80_0000000);
    assert_eq!(r.opened_at, START);

    s.env.ledger().set_timestamp(START + 60);
    s.escrow.confirm(&rid(&s.env, 1));
    let r = s.escrow.get_return(&rid(&s.env, 1)).unwrap();
    assert_eq!(r.status, ReturnStatus::Confirmed);
    assert_eq!(r.closed_at, START + 60);
    assert_eq!(s.token.balance(&s.escrow_id), 0);
    assert_eq!(s.escrow.locked(&s.token.address), 0);
    assert_eq!(s.token.balance(&s.consumer), 920_0000000);
}

#[test]
fn open_requires_consumer_auth_and_confirm_requires_issuer_auth() {
    let s = setup();
    s.open(1, 10_0000000, START + DAY);
    let auths = s.env.auths();
    assert_eq!(auths[0].0, s.consumer);
    assert_eq!(
        auths[0].1.function,
        AuthorizedFunction::Contract((
            s.escrow_id.clone(),
            Symbol::new(&s.env, "open_return"),
            (
                s.consumer.clone(),
                s.issuer.clone(),
                s.token.address.clone(),
                10_0000000_i128,
                rid(&s.env, 1),
                START + DAY
            )
                .into_val(&s.env),
        ))
    );
    // the transfer into escrow is a sub-invocation covered by the same consumer authorization
    assert_eq!(auths[0].1.sub_invocations.len(), 1);
    s.escrow.confirm(&rid(&s.env, 1));
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.issuer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.escrow_id.clone(),
                    Symbol::new(&s.env, "confirm"),
                    (rid(&s.env, 1),).into_val(&s.env)
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn a_stranger_cannot_confirm_or_reject() {
    let s = setup();
    s.open(1, 10_0000000, START + DAY);
    let stranger = Address::generate(&s.env);
    for f in ["confirm", "reject"] {
        s.env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &s.escrow_id,
                fn_name: f,
                args: (rid(&s.env, 1),).into_val(&s.env),
                sub_invokes: &[],
            },
        }]);
        let res = if f == "confirm" {
            s.escrow.try_confirm(&rid(&s.env, 1))
        } else {
            s.escrow.try_reject(&rid(&s.env, 1))
        };
        assert!(res.is_err(), "{f} by a stranger must fail");
    }
    s.env.mock_all_auths();
    assert_eq!(
        s.escrow.get_return(&rid(&s.env, 1)).unwrap().status,
        ReturnStatus::Open
    );
    s.invariant();
}

#[test]
fn open_without_consumer_auth_fails() {
    let s = setup();
    s.env.set_auths(&[]);
    let res = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert!(res.is_err());
    assert!(s.escrow.get_return(&rid(&s.env, 1)).is_none());
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
}

#[test]
fn reject_refunds_the_consumer() {
    let s = setup();
    s.open(2, 50_0000000, START + DAY);
    s.escrow.reject(&rid(&s.env, 2));
    assert_eq!(
        s.escrow.get_return(&rid(&s.env, 2)).unwrap().status,
        ReturnStatus::Rejected
    );
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
    assert_eq!(s.token.balance(&s.escrow_id), 0);
    s.invariant();
}

#[test]
fn reject_is_still_allowed_after_the_deadline() {
    let s = setup();
    s.open(2, 5_0000000, START + DAY);
    s.env.ledger().set_timestamp(START + 2 * DAY);
    s.escrow.reject(&rid(&s.env, 2));
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
}

#[test]
fn anyone_can_expire_refund_after_the_deadline_without_auth() {
    let s = setup();
    s.open(3, 30_0000000, START + DAY);
    s.env.ledger().set_timestamp(START + DAY);
    s.env.set_auths(&[]); // no authorization at all
    s.escrow.expire_refund(&rid(&s.env, 3));
    assert!(s.env.auths().is_empty());
    let r = s.escrow.get_return(&rid(&s.env, 3)).unwrap();
    assert_eq!(r.status, ReturnStatus::Expired);
    assert_eq!(r.closed_at, START + DAY);
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
    s.invariant();
}

#[test]
fn expire_before_deadline_is_refused() {
    let s = setup();
    s.open(3, 30_0000000, START + DAY);
    s.env.ledger().set_timestamp(START + DAY - 1);
    assert_eq!(
        s.escrow.try_expire_refund(&rid(&s.env, 3)),
        err(EscrowError::DeadlineNotReached)
    );
    s.invariant();
}

#[test]
fn confirm_at_or_after_deadline_is_refused() {
    let s = setup();
    s.open(4, 1_0000000, START + DAY);
    s.env.ledger().set_timestamp(START + DAY);
    assert_eq!(
        s.escrow.try_confirm(&rid(&s.env, 4)),
        err(EscrowError::DeadlinePassed)
    );
    s.escrow.expire_refund(&rid(&s.env, 4));
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
}

#[test]
fn redemption_ids_are_single_use_even_after_closing() {
    let s = setup();
    s.open(5, 1_0000000, START + DAY);
    let again = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 5),
        &(START + DAY),
    );
    assert_eq!(again, err(EscrowError::DuplicateRedemption));
    s.escrow.reject(&rid(&s.env, 5));
    let after_close = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 5),
        &(START + DAY),
    );
    assert_eq!(after_close, err(EscrowError::DuplicateRedemption));
    s.invariant();
}

#[test]
fn closed_returns_cannot_be_closed_again() {
    let s = setup();
    s.open(6, 1_0000000, START + DAY);
    s.escrow.confirm(&rid(&s.env, 6));
    assert_eq!(
        s.escrow.try_confirm(&rid(&s.env, 6)),
        err(EscrowError::NotOpen)
    );
    assert_eq!(
        s.escrow.try_reject(&rid(&s.env, 6)),
        err(EscrowError::NotOpen)
    );
    s.env.ledger().set_timestamp(START + 2 * DAY);
    assert_eq!(
        s.escrow.try_expire_refund(&rid(&s.env, 6)),
        err(EscrowError::NotOpen)
    );
    assert_eq!(s.token.balance(&s.consumer), 999_0000000);
}

#[test]
fn unknown_redemption_is_not_found() {
    let s = setup();
    assert_eq!(
        s.escrow.try_confirm(&rid(&s.env, 9)),
        err(EscrowError::NotFound)
    );
    assert_eq!(
        s.escrow.try_reject(&rid(&s.env, 9)),
        err(EscrowError::NotFound)
    );
    assert_eq!(
        s.escrow.try_expire_refund(&rid(&s.env, 9)),
        err(EscrowError::NotFound)
    );
    assert!(s.escrow.get_return(&rid(&s.env, 9)).is_none());
}

#[test]
fn invalid_amounts_are_refused() {
    let s = setup();
    for a in [0_i128, -1, i128::MIN] {
        let r = s.escrow.try_open_return(
            &s.consumer,
            &s.issuer,
            &s.token.address,
            &a,
            &rid(&s.env, 1),
            &(START + DAY),
        );
        assert_eq!(r, err(EscrowError::InvalidAmount));
    }
}

#[test]
fn deadline_window_is_bounded() {
    let s = setup();
    let open = |d: u64| {
        s.escrow.try_open_return(
            &s.consumer,
            &s.issuer,
            &s.token.address,
            &1,
            &rid(&s.env, 1),
            &d,
        )
    };
    assert_eq!(open(START), err(EscrowError::DeadlineTooSoon));
    assert_eq!(
        open(START + MIN_WINDOW_SECS - 1),
        err(EscrowError::DeadlineTooSoon)
    );
    assert_eq!(
        open(START + MAX_WINDOW_SECS + 1),
        err(EscrowError::DeadlineTooFar)
    );
    assert!(open(START + MIN_WINDOW_SECS).is_ok());
    let r2 = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1,
        &rid(&s.env, 2),
        &(START + MAX_WINDOW_SECS),
    );
    assert!(r2.is_ok());
}

#[test]
fn returns_only_go_to_the_assets_own_issuer() {
    let s = setup();
    let impostor = Address::generate(&s.env);
    let r = s.escrow.try_open_return(
        &s.consumer,
        &impostor,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert_eq!(r, err(EscrowError::IssuerMismatch));
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
}

#[test]
fn consumer_cannot_be_the_issuer() {
    let s = setup();
    let r = s.escrow.try_open_return(
        &s.issuer,
        &s.issuer,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert_eq!(r, err(EscrowError::SameParty));
}

#[test]
fn insufficient_balance_leaves_no_record() {
    let s = setup();
    let r = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &(1_001 * UNIT),
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert!(r.is_err());
    assert!(s.escrow.get_return(&rid(&s.env, 1)).is_none());
    assert_eq!(s.escrow.locked(&s.token.address), 0);
}

#[test]
fn auth_required_assets_need_the_issuer_to_authorize_the_escrow() {
    let s = setup();
    s.sac_issuer
        .set_flag(soroban_sdk::testutils::IssuerFlags::RequiredFlag);
    // new holders of an AUTH_REQUIRED credit start unauthorized; refuse rather than strand funds
    let r = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1_0000000,
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert!(r.is_err());
    assert!(s.escrow.get_return(&rid(&s.env, 1)).is_none());
    s.sac.set_authorized(&s.escrow_id, &true);
    s.open(1, 1_0000000, START + DAY);
    s.escrow.reject(&rid(&s.env, 1));
    assert_eq!(s.token.balance(&s.consumer), 1_000 * UNIT);
}

#[test]
fn init_is_one_time_and_required() {
    let s = setup();
    assert_eq!(
        s.escrow.try_init(&Address::generate(&s.env)),
        err(EscrowError::AlreadyInitialized)
    );
    assert_eq!(s.escrow.admin(), s.admin);

    let fresh = RedemptionEscrowClient::new(&s.env, &s.env.register(RedemptionEscrow, ()));
    let r = fresh.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1,
        &rid(&s.env, 1),
        &(START + DAY),
    );
    assert_eq!(r, err(EscrowError::NotInitialized));
    assert_eq!(
        fresh.try_confirm(&rid(&s.env, 1)),
        err(EscrowError::NotInitialized)
    );
    assert_eq!(fresh.try_admin(), err(EscrowError::NotInitialized));
    assert!(!fresh.is_paused());
}

#[test]
fn pause_blocks_new_returns_but_never_refunds_or_confirmations() {
    let s = setup();
    s.open(1, 2_0000000, START + DAY);
    s.open(2, 3_0000000, START + DAY);
    s.escrow.set_paused(&true);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert!(s.escrow.is_paused());
    let r = s.escrow.try_open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1,
        &rid(&s.env, 3),
        &(START + DAY),
    );
    assert_eq!(r, err(EscrowError::Paused));
    s.escrow.confirm(&rid(&s.env, 1));
    s.env.ledger().set_timestamp(START + DAY);
    s.escrow.expire_refund(&rid(&s.env, 2));
    s.escrow.set_paused(&false);
    s.env.ledger().set_timestamp(START + 2 * DAY);
    s.escrow.open_return(
        &s.consumer,
        &s.issuer,
        &s.token.address,
        &1,
        &rid(&s.env, 3),
        &(START + 3 * DAY),
    );
    s.invariant();
}

#[test]
fn only_the_admin_can_pause() {
    let s = setup();
    s.env.set_auths(&[]);
    assert!(s.escrow.try_set_paused(&true).is_err());
    assert!(!s.escrow.is_paused());
}

#[test]
fn lifecycle_events_are_published() {
    let s = setup();
    s.open(1, 7_0000000, START + DAY);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.escrow_id),
        std::vec![ReturnOpened {
            redemption_id: rid(&s.env, 1),
            consumer: s.consumer.clone(),
            issuer: s.issuer.clone(),
            token: s.token.address.clone(),
            amount: 7_0000000,
            deadline: START + DAY,
        }
        .to_xdr(&s.env, &s.escrow_id)]
    );
    s.escrow.confirm(&rid(&s.env, 1));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.escrow_id),
        std::vec![ReturnConfirmed {
            redemption_id: rid(&s.env, 1),
            issuer: s.issuer.clone(),
            amount: 7_0000000
        }
        .to_xdr(&s.env, &s.escrow_id)]
    );
    s.open(2, 1, START + DAY);
    s.escrow.reject(&rid(&s.env, 2));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.escrow_id),
        std::vec![ReturnRejected {
            redemption_id: rid(&s.env, 2),
            consumer: s.consumer.clone(),
            amount: 1
        }
        .to_xdr(&s.env, &s.escrow_id)]
    );
    s.open(3, 1, START + DAY);
    s.env.ledger().set_timestamp(START + DAY);
    s.escrow.expire_refund(&rid(&s.env, 3));
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.escrow_id),
        std::vec![ReturnExpired {
            redemption_id: rid(&s.env, 3),
            consumer: s.consumer.clone(),
            amount: 1
        }
        .to_xdr(&s.env, &s.escrow_id)]
    );
}

/// Small deterministic PRNG (xorshift64*) so the invariant run is reproducible without extra crates.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Property: across random interleavings of open / confirm / reject / expire / time travel, with
/// several consumers and two independent credits, for every token
///   escrow balance == locked(token) == sum(amount of Open returns for token),
/// and value is conserved: consumers + issuer burns + escrow == minted supply.
#[test]
fn invariant_escrow_balance_equals_sum_of_open_returns() {
    let (mut opened, mut closed) = (0_u32, 0_u32);
    for seed in 1..=24_u64 {
        let env = Env::default();
        env.ledger().set_timestamp(START);
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let escrow_id = env.register(RedemptionEscrow, ());
        let escrow = RedemptionEscrowClient::new(&env, &escrow_id);
        escrow.init(&Address::generate(&env));

        let mut tokens = StdVec::new();
        for _ in 0..2 {
            let c = env.register_stellar_asset_contract_v2(Address::generate(&env));
            let issuer = c.issuer().address();
            StellarAssetClient::new(&env, &c.address()).set_admin(&issuer);
            tokens.push((
                issuer,
                TokenClient::new(&env, &c.address()),
                StellarAssetClient::new(&env, &c.address()),
            ));
        }
        let consumers: StdVec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
        const MINT: i128 = 500_0000000;
        for (_, _, sac) in &tokens {
            for c in &consumers {
                sac.mint(c, &MINT);
            }
        }

        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        // model: (id, token index, amount, deadline, open?)
        let mut model: StdVec<(u8, usize, i128, u64, bool)> = StdVec::new();
        let mut burned = [0_i128; 2];
        let mut next_id: u8 = 0;

        for _step in 0..60 {
            let now = env.ledger().timestamp();
            match rng.below(6) {
                0 | 1 if next_id < 250 => {
                    let t = rng.below(2) as usize;
                    let c = &consumers[rng.below(3) as usize];
                    let amount = 1 + rng.below(40_0000000) as i128;
                    let deadline = now + MIN_WINDOW_SECS + rng.below(3 * DAY);
                    let id = next_id;
                    next_id += 1;
                    let (issuer, tok, _) = &tokens[t];
                    let res = escrow.try_open_return(
                        c,
                        issuer,
                        &tok.address,
                        &amount,
                        &rid(&env, id),
                        &deadline,
                    );
                    if res.is_ok() {
                        model.push((id, t, amount, deadline, true));
                        opened += 1;
                    } else {
                        assert!(
                            escrow.get_return(&rid(&env, id)).is_none(),
                            "failed open must leave no record"
                        );
                    }
                }
                2..=4 if !model.is_empty() => {
                    let i = rng.below(model.len() as u64) as usize;
                    let (id, t, amount, deadline, open) = model[i];
                    let key = rid(&env, id);
                    let res = match rng.below(3) {
                        0 => escrow.try_confirm(&key).map(|_| 0_u8),
                        1 => escrow.try_reject(&key).map(|_| 1_u8),
                        _ => escrow.try_expire_refund(&key).map(|_| 2_u8),
                    };
                    match res {
                        Ok(kind) => {
                            assert!(open, "a closed return was closed again");
                            if kind == 0 {
                                assert!(now < deadline);
                                burned[t] += amount;
                            }
                            if kind == 2 {
                                assert!(now >= deadline);
                            }
                            model[i].4 = false;
                            closed += 1;
                        }
                        _ => assert_eq!(
                            escrow.get_return(&key).unwrap().status == ReturnStatus::Open,
                            open
                        ),
                    }
                }
                _ => env.ledger().set_timestamp(now + rng.below(DAY)),
            }

            for (t, (_, tok, _)) in tokens.iter().enumerate() {
                let open_sum: i128 = model.iter().filter(|m| m.1 == t && m.4).map(|m| m.2).sum();
                assert_eq!(
                    tok.balance(&escrow_id),
                    open_sum,
                    "seed {seed}: escrow balance != open returns"
                );
                assert_eq!(
                    escrow.locked(&tok.address),
                    open_sum,
                    "seed {seed}: locked != open returns"
                );
                let held: i128 = consumers.iter().map(|c| tok.balance(c)).sum();
                assert_eq!(
                    held + open_sum + burned[t],
                    MINT * consumers.len() as i128,
                    "seed {seed}: value not conserved"
                );
            }
        }
    }
    // the run must actually exercise both sides of the lifecycle
    assert!(
        opened > 200 && closed > 100,
        "opened={opened} closed={closed}"
    );
}
