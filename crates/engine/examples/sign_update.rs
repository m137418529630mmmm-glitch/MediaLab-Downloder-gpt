//! Used by the release build: signs a release for the program's updater,
//! derives the public key from `UPDATE_SIGNING_KEY` with `--public-key`,
//! or generates a new Ed25519 signing key pair with `--generate-key`.
//!
//! Sign a release:
//!     UPDATE_SIGNING_KEY=<64 hex> cargo run -p swiftget-engine --example sign_update -- <version> <sha256>
//!
//! Print the public key for `UPDATE_SIGNING_KEY`:
//!     UPDATE_SIGNING_KEY=<64 hex> cargo run -p swiftget-engine --example sign_update -- --public-key
//!
//! Generate a new Ed25519 key pair:
//!     cargo run -p swiftget-engine --example sign_update -- --generate-key
//!
//! prints the signature (hex) for the "sig" field of version.json. The private
//! seed (`UPDATE_SIGNING_KEY`) is stored in GitHub Actions Secrets and never
//! committed to the repository.

use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair};
use swiftget_engine::selfupdate::{from_hex, signature_ok, signed_message, Release, UPDATE_PUBLIC_KEY};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a == "--generate-key").unwrap_or(false) {
        let rng = SystemRandom::new();
        let mut seed = [0u8; 32];
        rng.fill(&mut seed).expect("failed to generate random seed");
        let kp = Ed25519KeyPair::from_seed_unchecked(&seed).expect("bad seed");
        let priv_hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();
        let pub_hex: String = kp.public_key().as_ref().iter().map(|b| format!("{b:02x}")).collect();
        println!("UPDATE_SIGNING_KEY (store in GitHub Actions Secrets, NEVER commit): {priv_hex}");
        println!("UPDATE_PUBLIC_KEY  (set in selfupdate.rs or MEDIALAB_UPDATE_PUBLIC_KEY): {pub_hex}");
        return;
    }
    if args.get(1).map(|a| a == "--public-key").unwrap_or(false) {
        let seed = std::env::var("UPDATE_SIGNING_KEY").ok().and_then(|k| from_hex(&k)).unwrap_or_default();
        if seed.len() != 32 {
            eprintln!("UPDATE_SIGNING_KEY is missing or not 64 hex characters");
            std::process::exit(1);
        }
        let kp = Ed25519KeyPair::from_seed_unchecked(&seed).expect("bad key");
        let public: String = kp.public_key().as_ref().iter().map(|b| format!("{b:02x}")).collect();
        println!("{public}");
        return;
    }
    let (Some(version), Some(sha)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: sign_update <version> <sha256> | sign_update --public-key | sign_update --generate-key");
        std::process::exit(2);
    };
    let seed = std::env::var("UPDATE_SIGNING_KEY").ok().and_then(|k| from_hex(&k)).unwrap_or_default();
    if seed.len() != 32 {
        eprintln!("UPDATE_SIGNING_KEY is missing or not 64 hex characters");
        std::process::exit(1);
    }
    let kp = Ed25519KeyPair::from_seed_unchecked(&seed).expect("bad key");
    let public: String = kp.public_key().as_ref().iter().map(|b| format!("{b:02x}")).collect();
    if public != UPDATE_PUBLIC_KEY {
        eprintln!("UPDATE_SIGNING_KEY does not belong to the public key built into the program (expected {UPDATE_PUBLIC_KEY}, got {public})");
        std::process::exit(1);
    }
    let sig: String = kp.sign(signed_message(version, sha).as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let check = Release { version: version.clone(), url: String::new(), sha256: sha.clone(), sig: sig.clone() };
    assert!(signature_ok(&check, UPDATE_PUBLIC_KEY));
    println!("{sig}");
}
