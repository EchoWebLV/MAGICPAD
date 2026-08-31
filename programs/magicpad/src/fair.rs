//! Fairest-mode flip tax — pure math, zero account/anchor deps, unit-tested
//! in-crate on the host (same discipline as curve.rs). All intermediates
//! u128. Rounds DOWN on the tax (never over-taxes a seller).

use crate::constants::{BPS_DENOM, FLIP_DECAY_SECS, FLIP_TAX_START_BPS};

/// Tokens-weighted average entry timestamp after a buy. A fresh position
/// (or a re-entry after a full exit) starts at `now`; later buys drag the
/// average toward `now` in proportion to their size.
pub fn weighted_entry_ts(
    entry_ts: u64,
    tokens_held: u64,
    now_ts: u64,
    tokens_bought: u64,
) -> Option<u64> {
    let total = (tokens_held as u128).checked_add(tokens_bought as u128)?;
    if total == 0 {
        return None;
    }
    let num = (entry_ts as u128)
        .checked_mul(tokens_held as u128)?
        .checked_add((now_ts as u128).checked_mul(tokens_bought as u128)?)?;
    u64::try_from(num / total).ok()
}

/// Lamports of tax on `sol_out` for a position whose weighted entry is
/// `entry_ts`, sold at `now_ts`. Full rate on an instant flip, linear
/// decay to zero at FLIP_DECAY_SECS. Clock skew (now < entry) counts as
/// age zero — the safe direction.
pub fn flip_tax(sol_out: u64, entry_ts: u64, now_ts: i64) -> Option<u64> {
    let age = (now_ts as i128 - entry_ts as i128).max(0) as u128;
    if age >= FLIP_DECAY_SECS as u128 {
        return Some(0);
    }
    let bps = FLIP_TAX_START_BPS as u128 * (FLIP_DECAY_SECS as u128 - age) / FLIP_DECAY_SECS as u128;
    u64::try_from(sol_out as u128 * bps / BPS_DENOM as u128).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_756_200_000; // arbitrary epoch anchor

    #[test]
    fn first_buy_sets_entry_to_now() {
        assert_eq!(weighted_entry_ts(0, 0, T, 5_000).unwrap(), T);
    }

    #[test]
    fn rebuy_after_full_exit_resets_to_now() {
        // stale entry from a closed position must not age the new one
        assert_eq!(weighted_entry_ts(T - 900, 0, T, 7).unwrap(), T);
    }

    #[test]
    fn equal_buys_average_to_midpoint() {
        assert_eq!(weighted_entry_ts(T, 1_000, T + 100, 1_000).unwrap(), T + 50);
    }

    #[test]
    fn late_big_buy_dominates_the_average() {
        // 10 old vs 990 new → avg lands 99% of the way to now
        assert_eq!(
            weighted_entry_ts(T, 10, T + 100, 990).unwrap(),
            T + 99
        );
    }

    #[test]
    fn instant_flip_pays_start_rate() {
        // age 0 → 2500 bps of 1_000_000 = 250_000
        assert_eq!(flip_tax(1_000_000, T, T as i64).unwrap(), 250_000);
    }

    #[test]
    fn halfway_through_decay_pays_half() {
        // age 900 of 1800 → 1250 bps = 125_000
        assert_eq!(
            flip_tax(1_000_000, T, (T + FLIP_DECAY_SECS / 2) as i64).unwrap(),
            125_000
        );
    }

    #[test]
    fn aged_out_pays_zero() {
        assert_eq!(flip_tax(1_000_000, T, (T + FLIP_DECAY_SECS) as i64).unwrap(), 0);
        assert_eq!(flip_tax(1_000_000, T, (T + FLIP_DECAY_SECS + 1) as i64).unwrap(), 0);
        assert_eq!(flip_tax(1_000_000, T, i64::MAX).unwrap(), 0);
    }

    #[test]
    fn clock_skew_counts_as_instant_flip() {
        // ER clock behind the entry stamp → tax at the full rate, never a panic
        assert_eq!(flip_tax(1_000_000, T, (T - 50) as i64).unwrap(), 250_000);
    }

    #[test]
    fn zero_out_zero_tax() {
        assert_eq!(flip_tax(0, T, T as i64).unwrap(), 0);
    }

    #[test]
    fn tax_decays_monotonically_and_never_exceeds_out() {
        let out = 987_654_321u64;
        let mut prev = u64::MAX;
        for age in (0..=FLIP_DECAY_SECS).step_by(60) {
            let tax = flip_tax(out, T, (T + age) as i64).unwrap();
            assert!(tax <= out, "tax {tax} exceeds out {out}");
            assert!(tax <= prev, "tax not monotone at age {age}");
            prev = tax;
        }
        // start rate exact: floor(out * 2500 / 10000)
        assert_eq!(
            flip_tax(out, T, T as i64).unwrap(),
            (out as u128 * FLIP_TAX_START_BPS as u128 / BPS_DENOM as u128) as u64
        );
    }
}
