//! Nameplates: the short number at the front of a transfer code.
//!
//! This is *all* the server knows about a code. The two words that follow it are
//! chosen in the browser and never sent here, because they are the password
//! SPAKE2 authenticates the peers with — a server that learned them could stand
//! in the middle of the key exchange.
//!
//! Nameplates are allocated smallest-first, exactly as magic-wormhole does, so
//! codes stay short: the first nine concurrent transfers get a single digit.

use std::collections::HashSet;

/// Finds the lowest number not currently in use.
pub fn allocate(taken: &HashSet<&String>) -> String {
    (1u64..)
        .map(|candidate| candidate.to_string())
        .find(|candidate| !taken.contains(candidate))
        .expect("the range is unbounded")
}

/// Pulls the nameplate out of whatever the user typed. The words are ignored
/// here — the server has no business seeing them, and the client strips them
/// before calling, but a stray full code must not become a lookup miss.
pub fn normalize(input: &str) -> String {
    input
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nameplates_fill_the_lowest_free_slot() {
        let one = "1".to_string();
        let two = "2".to_string();
        let four = "4".to_string();

        assert_eq!(allocate(&HashSet::new()), "1");
        assert_eq!(allocate(&HashSet::from([&one])), "2");
        assert_eq!(allocate(&HashSet::from([&one, &two])), "3");
        // A gap left by a finished transfer is reused before growing.
        assert_eq!(allocate(&HashSet::from([&one, &two, &four])), "3");
    }

    #[test]
    fn normalize_keeps_only_the_nameplate() {
        assert_eq!(normalize("7"), "7");
        assert_eq!(normalize(" 12 "), "12");
        assert_eq!(normalize("7-adroitness-aardvark"), "7");
        assert_eq!(normalize("nonsense"), "");
    }
}
