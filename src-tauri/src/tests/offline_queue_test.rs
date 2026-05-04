#[cfg(test)]
mod tests {
    use crate::ws::encrypt_or_drop_for_test as encrypt_or_drop;

    #[test]
    fn drops_clip_when_no_key() {
        assert!(encrypt_or_drop(None, b"plain").is_none());
    }

    #[test]
    fn encrypts_when_key_present() {
        let key = [9u8; 32];
        let result = encrypt_or_drop(Some(&key), b"plain").unwrap();
        assert!(result.encrypted);
        assert_ne!(result.body, "plain");
    }
}
