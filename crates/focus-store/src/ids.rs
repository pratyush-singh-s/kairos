use uuid::Uuid;

/// A new row ID: a UUIDv7, which starts with a timestamp so IDs sort by creation time
/// and two PCs creating rows offline never collide.
pub fn new_id() -> String {
    Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_version_7() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(Uuid::parse_str(&a).unwrap().get_version_num(), 7);
    }
}
