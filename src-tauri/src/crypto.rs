//! AES-256-GCM encryption and X25519 ECDH key exchange.
//! Wire format: base64url(nonce[12B] || ciphertext || GCM_tag[16B])

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// Encrypt plaintext with AES-256-GCM.
/// Returns base64url(nonce[12] || ciphertext || tag[16]).
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes init: {}", e))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt: {}", e))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(URL_SAFE_NO_PAD.encode(&out))
}

/// Decrypt a base64url-encoded AES-256-GCM payload.
pub fn decrypt(key: &[u8; 32], encoded: &str) -> Result<Vec<u8>, String> {
    let data = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("base64 decode: {}", e))?;
    if data.len() < 12 + 16 {
        return Err(format!("ciphertext too short: {} bytes", data.len()));
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes init: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt: {}", e))
}

/// Derive a 32-byte AES key from X25519 ECDH shared secret via HKDF-SHA256.
/// `local_priv_b64` and `remote_pub_b64` are base64url-encoded.
pub fn derive_shared_key(local_priv_b64: &str, remote_pub_b64: &str) -> Result<[u8; 32], String> {
    let priv_bytes = URL_SAFE_NO_PAD
        .decode(local_priv_b64)
        .map_err(|e| format!("decode private key: {}", e))?;
    let pub_bytes = URL_SAFE_NO_PAD
        .decode(remote_pub_b64)
        .map_err(|e| format!("decode public key: {}", e))?;

    if priv_bytes.len() != 32 {
        return Err(format!(
            "private key must be 32 bytes, got {}",
            priv_bytes.len()
        ));
    }
    if pub_bytes.len() != 32 {
        return Err(format!(
            "public key must be 32 bytes, got {}",
            pub_bytes.len()
        ));
    }

    let secret = StaticSecret::from(<[u8; 32]>::try_from(priv_bytes.as_slice()).unwrap());
    let public = PublicKey::from(<[u8; 32]>::try_from(pub_bytes.as_slice()).unwrap());
    let shared = secret.diffie_hellman(&public);

    let hk = Hkdf::<Sha256>::new(None, shared.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"cinch-key-xfer", &mut okm)
        .map_err(|e| format!("hkdf expand: {}", e))?;
    Ok(okm)
}

/// Generate an ephemeral X25519 keypair for ECDH key exchange.
/// Returns (private_key_b64, public_key_b64).
pub fn generate_ephemeral_keypair() -> (String, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    let priv_b64 = URL_SAFE_NO_PAD.encode(secret.as_bytes());
    let pub_b64 = URL_SAFE_NO_PAD.encode(public.as_bytes());
    (priv_b64, pub_b64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [0x42u8; 32];
        let plaintext = b"hello world";
        let encoded = encrypt(&key, plaintext).unwrap();
        let decrypted = decrypt(&key, &encoded).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_nonce_uniqueness() {
        let key = [0x42u8; 32];
        let a = encrypt(&key, b"same").unwrap();
        let b = encrypt(&key, b"same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_tamper_detection() {
        let key = [0x42u8; 32];
        let encoded = encrypt(&key, b"test").unwrap();
        let mut data = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
        data[15] ^= 0xFF; // flip a byte
        let tampered = URL_SAFE_NO_PAD.encode(&data);
        assert!(decrypt(&key, &tampered).is_err());
    }

    #[test]
    fn test_ecdh_symmetric() {
        let (a_priv, a_pub) = generate_ephemeral_keypair();
        let (b_priv, b_pub) = generate_ephemeral_keypair();
        let key_ab = derive_shared_key(&a_priv, &b_pub).unwrap();
        let key_ba = derive_shared_key(&b_priv, &a_pub).unwrap();
        assert_eq!(key_ab, key_ba);
    }

    #[test]
    fn test_cross_language_wire_format() {
        // Verify wire format: base64url(nonce[12] || ciphertext || tag[16])
        let key = [0x42u8; 32];
        let encoded = encrypt(&key, b"test").unwrap();
        let data = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
        // nonce(12) + ciphertext(4) + tag(16) = 32
        assert_eq!(data.len(), 32);
    }
}
