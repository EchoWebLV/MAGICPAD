//! Constant-product bonding curve with virtual reserves, pump-style.
//! Pure math, zero account/anchor deps — unit-tested in-crate on the host.
//! All intermediates u128. Rounds AGAINST the trader (the curve never leaks).

pub fn buy_quote(virtual_sol: u64, virtual_tok: u64, sol_in: u64) -> Option<u64> {
    if sol_in == 0 {
        return Some(0);
    }
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let k = vs.checked_mul(vt)?;
    let new_vs = vs.checked_add(sol_in as u128)?;
    // ceil the post-trade token reserve → fewer tokens out
    let new_vt = k.checked_div(new_vs)?.checked_add(1)?;
    let out = vt.checked_sub(new_vt)?;
    u64::try_from(out).ok()
}

pub fn sell_quote(virtual_sol: u64, virtual_tok: u64, tok_in: u64) -> Option<u64> {
    if tok_in == 0 {
        return Some(0);
    }
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let k = vs.checked_mul(vt)?;
    let new_vt = vt.checked_add(tok_in as u128)?;
    // ceil the post-trade SOL reserve → fewer lamports out
    let new_vs = k.checked_div(new_vt)?.checked_add(1)?;
    let out = vs.checked_sub(new_vs)?;
    u64::try_from(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const VS: u64 = 30_000_000_000; // 30 SOL virtual
    const VT: u64 = 1_073_000_000_000_000; // 1.073e15 token units

    #[test]
    fn buy_moves_tokens_out() {
        let out = buy_quote(VS, VT, 1_000_000_000).unwrap();
        assert!(out > 0);
        // 1 SOL into 30 virtual → slightly under 1/31 of the token reserve
        assert!(out < VT / 30);
    }

    #[test]
    fn zero_in_zero_out() {
        assert_eq!(buy_quote(VS, VT, 0).unwrap(), 0);
        assert_eq!(sell_quote(VS, VT, 0).unwrap(), 0);
    }

    #[test]
    fn bigger_buy_bigger_out() {
        let a = buy_quote(VS, VT, 1_000_000_000).unwrap();
        let b = buy_quote(VS, VT, 2_000_000_000).unwrap();
        assert!(b > a);
    }

    #[test]
    fn round_trip_never_profits() {
        // buy then immediately sell everything back: trader must not net gain
        for sol_in in [1_000_000u64, 500_000_000, 1_000_000_000, 4_999_999_999] {
            let out = buy_quote(VS, VT, sol_in).unwrap();
            let back = sell_quote(VS + sol_in, VT - out, out).unwrap();
            assert!(back <= sol_in, "round trip profited: in {sol_in} back {back}");
        }
    }

    #[test]
    fn sell_into_deeper_curve_realizes_loss_shape() {
        // buyer A buys, then price rises (B buys), A sells: A profits;
        // inverse: A buys, then price falls is impossible without sells —
        // here just assert sell after own buy at same depth loses to rounding.
        let out = buy_quote(VS, VT, 1_000_000_000).unwrap();
        let back = sell_quote(VS + 1_000_000_000, VT - out, out).unwrap();
        assert!(back < 1_000_000_000);
    }

    #[test]
    fn extremes_do_not_panic() {
        // u64::MAX² = 2¹²⁸−2⁶⁵+1 fits u128, so max inputs are computable —
        // the property is: no panic/wrap, and out never exceeds the reserve.
        match buy_quote(u64::MAX, u64::MAX, u64::MAX) {
            Some(out) => assert!(out < u64::MAX),
            None => {} // rejecting extremes is also acceptable
        }
        match sell_quote(u64::MAX, u64::MAX, u64::MAX) {
            Some(out) => assert!(out < u64::MAX),
            None => {}
        }
        // Selling more than the virtual reserve supports still must not panic
        let r = sell_quote(1, VT, u64::MAX);
        assert!(r.is_none() || r == Some(0));
    }

    #[test]
    fn conservation_across_split_buys() {
        // one 2-SOL buy vs two 1-SOL buys: split path never yields MORE tokens
        let whole = buy_quote(VS, VT, 2_000_000_000).unwrap();
        let a = buy_quote(VS, VT, 1_000_000_000).unwrap();
        let b = buy_quote(VS + 1_000_000_000, VT - a, 1_000_000_000).unwrap();
        assert!(a + b <= whole + 2); // ±rounding, split never beats whole
    }
}
