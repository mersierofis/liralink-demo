#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Env, Event,
};

/// Fresh env with a USDC-like SAC token (payer pre-funded) and a deployed invoice
/// contract pinned to that token. Returns the pieces each test needs.
fn setup(env: &Env) -> (Address, Address, Address, Address) {
    env.mock_all_auths();
    let merchant = Address::generate(env);
    let payer = Address::generate(env);
    let admin = Address::generate(env);

    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_address = sac.address();
    token::StellarAssetClient::new(env, &token_address).mint(&payer, &1_000);

    let contract_id = env.register(InvoiceContract, (token_address.clone(),));
    (merchant, payer, token_address, contract_id)
}

#[test]
fn test_create() {
    let env = Env::default();
    let (merchant, _payer, _token, contract_id) = setup(&env);
    let client = InvoiceContractClient::new(&env, &contract_id);

    let code = symbol_short!("INV1");
    client.create(&merchant, &code, &100, &1000);

    // Events only cover the most recent invocation, so assert before the next call.
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        [Created {
            code: code.clone(),
            merchant: merchant.clone(),
            amount: 100,
            deadline: 1000,
        }
        .to_xdr(&env, &contract_id)]
    );

    let inv = client.get(&code);
    assert_eq!(inv.merchant, merchant);
    assert_eq!(inv.code, code);
    assert_eq!(inv.amount, 100);
    assert_eq!(inv.deadline, 1000);
    assert_eq!(inv.status, Status::Pending);
    assert_eq!(inv.payer, None);

    // A second create with the same code is rejected.
    assert!(client.try_create(&merchant, &code, &100, &1000).is_err());
    // amount must be positive.
    assert!(client
        .try_create(&merchant, &symbol_short!("BAD"), &0, &1000)
        .is_err());
}

#[test]
fn test_pay() {
    let env = Env::default();
    let (merchant, payer, token_address, contract_id) = setup(&env);
    let client = InvoiceContractClient::new(&env, &contract_id);
    let token = token::Client::new(&env, &token_address);

    let code = symbol_short!("INV2");
    client.create(&merchant, &code, &250, &1000);
    client.pay(&code, &payer);

    // The backend's contract rail matches on this event (the SAC transfer event is filtered out).
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        [Paid {
            code: code.clone(),
            payer: payer.clone(),
            merchant: merchant.clone(),
            amount: 250,
        }
        .to_xdr(&env, &contract_id)]
    );

    // USDC moved payer -> merchant.
    assert_eq!(token.balance(&payer), 750);
    assert_eq!(token.balance(&merchant), 250);

    let inv = client.get(&code);
    assert_eq!(inv.status, Status::Paid);
    assert_eq!(inv.payer, Some(payer.clone()));

    // Cannot pay again once paid.
    assert!(client.try_pay(&code, &payer).is_err());
}

#[test]
fn test_get() {
    let env = Env::default();
    let (merchant, _payer, _token, contract_id) = setup(&env);
    let client = InvoiceContractClient::new(&env, &contract_id);

    let code = symbol_short!("INV3");
    client.create(&merchant, &code, &42, &500);

    // Positive: returns the stored invoice verbatim.
    let inv = client.get(&code);
    assert_eq!(inv.amount, 42);
    assert_eq!(inv.deadline, 500);

    // Negative: an unknown code errors (NotFound).
    assert!(client.try_get(&symbol_short!("NOPE")).is_err());
}

#[test]
fn test_cancel() {
    let env = Env::default();
    let (merchant, payer, _token, contract_id) = setup(&env);
    let client = InvoiceContractClient::new(&env, &contract_id);

    let code = symbol_short!("INV4");
    client.create(&merchant, &code, &50, &1000);
    client.cancel(&code);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        [Cancelled {
            code: code.clone(),
            merchant: merchant.clone(),
        }
        .to_xdr(&env, &contract_id)]
    );

    assert_eq!(client.get(&code).status, Status::Cancelled);
    // A cancelled invoice can no longer be paid.
    assert!(client.try_pay(&code, &payer).is_err());
}
