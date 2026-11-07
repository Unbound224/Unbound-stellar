#![cfg(test)]
//! Golden cross-language fixtures: the TypeScript adapter in `src/soroban/` decodes exactly these
//! bytes (tests/soroban-escrow.test.ts). Regenerate with `UPDATE_GOLDEN=1 cargo test golden`.
extern crate std;

use super::*;
use soroban_sdk::{
    xdr::{Limits, ToXdr, WriteXdr},
    Address, BytesN, Env, String as SorobanString,
};
use std::{format, string::String, vec::Vec};

// Deterministic throwaway addresses (ed25519 seeds 0x01.. / 0x02.., contract id 0x07..). Not real accounts.
const CONSUMER: &str = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const ISSUER: &str = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";
/// Testnet SAC id of SHOP:ISSUER
const TOKEN: &str = "CA6LKTSR5SVSQ2RV5LRXEZIIGV7MLJSJ5LVP3ROH27HDKPE4VXUEGANI";
const ESCROW: &str = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
/// sha256("red_fixture0001")
const KEY_HEX: &str = "ea0e677721bb757840d5c8befce3ef2052ade43c2a3695a27fc80b7927842259";

fn hex(bytes: impl IntoIterator<Item = u8>) -> String {
    bytes.into_iter().map(|b| format!("{b:02x}")).collect()
}

fn key(env: &Env) -> BytesN<32> {
    let mut a = [0u8; 32];
    for (i, chunk) in KEY_HEX.as_bytes().chunks(2).enumerate() {
        a[i] = u8::from_str_radix(core::str::from_utf8(chunk).unwrap(), 16).unwrap();
    }
    BytesN::from_array(env, &a)
}

fn addr(env: &Env, s: &str) -> Address {
    Address::from_string(&SorobanString::from_str(env, s))
}

fn record_hex(env: &Env, status: ReturnStatus, closed_at: u64) -> String {
    let r = EscrowedReturn {
        consumer: addr(env, CONSUMER),
        issuer: addr(env, ISSUER),
        token: addr(env, TOKEN),
        amount: 80_0000000,
        deadline: 1_767_225_600,
        opened_at: 1_766_620_800,
        status,
        closed_at,
    };
    hex(r.to_xdr(env).iter())
}

fn event_hex(env: &Env, ev: &impl soroban_sdk::Event) -> String {
    let x = ev.to_xdr(env, &addr(env, ESCROW));
    let bytes: Vec<u8> = WriteXdr::to_xdr(&x, Limits::none()).unwrap();
    hex(bytes)
}

#[test]
fn golden_fixtures_match() {
    let env = Env::default();
    let k = key(&env);
    let (c, i, t) = (addr(&env, CONSUMER), addr(&env, ISSUER), addr(&env, TOKEN));
    let body = format!(
        concat!(
            "{{\n",
            "  \"schemaVersion\": \"1.0\",\n",
            "  \"generatedBy\": \"contracts/redemption-escrow/src/test_golden.rs (UPDATE_GOLDEN=1 cargo test golden)\",\n",
            "  \"note\": \"Deterministic throwaway addresses; not real accounts, not Testnet data.\",\n",
            "  \"contractId\": \"{escrow}\",\n",
            "  \"consumer\": \"{consumer}\",\n",
            "  \"issuer\": \"{issuer}\",\n",
            "  \"token\": \"{token}\",\n",
            "  \"redemptionId\": \"red_fixture0001\",\n",
            "  \"redemptionKeyHex\": \"{key}\",\n",
            "  \"amount\": \"80.0000000\",\n",
            "  \"deadline\": 1767225600,\n",
            "  \"openedAt\": 1766620800,\n",
            "  \"returnOpenScValHex\": \"{open}\",\n",
            "  \"returnConfirmedScValHex\": \"{confirmed}\",\n",
            "  \"returnExpiredScValHex\": \"{expired}\",\n",
            "  \"events\": {{\n",
            "    \"opened\": \"{e_open}\",\n",
            "    \"confirmed\": \"{e_conf}\",\n",
            "    \"rejected\": \"{e_rej}\",\n",
            "    \"expired\": \"{e_exp}\"\n",
            "  }}\n",
            "}}\n"
        ),
        escrow = ESCROW,
        consumer = CONSUMER,
        issuer = ISSUER,
        token = TOKEN,
        key = KEY_HEX,
        open = record_hex(&env, ReturnStatus::Open, 0),
        confirmed = record_hex(&env, ReturnStatus::Confirmed, 1_766_707_200),
        expired = record_hex(&env, ReturnStatus::Expired, 1_767_225_600),
        e_open = event_hex(
            &env,
            &ReturnOpened { redemption_id: k.clone(), consumer: c.clone(), issuer: i.clone(), token: t, amount: 80_0000000, deadline: 1_767_225_600 }
        ),
        e_conf = event_hex(&env, &ReturnConfirmed { redemption_id: k.clone(), issuer: i, amount: 80_0000000 }),
        e_rej = event_hex(&env, &ReturnRejected { redemption_id: k.clone(), consumer: c.clone(), amount: 80_0000000 }),
        e_exp = event_hex(&env, &ReturnExpired { redemption_id: k, consumer: c, amount: 80_0000000 }),
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/soroban/redemption-escrow.v1.json");
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &body).unwrap();
    }
    let on_disk = std::fs::read_to_string(&path)
        .expect("fixture missing: run UPDATE_GOLDEN=1 cargo test golden")
        .replace("\r\n", "\n");
    assert_eq!(
        on_disk, body,
        "golden fixture drifted; regenerate and update the TypeScript adapter tests"
    );
}
