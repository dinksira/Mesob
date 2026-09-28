/**
 * Fractional z-order keys.
 *
 * Shape ordering is a z-index on a canvas, but written to a document that merges
 * without a server arbitrating it, so it cannot be a plain integer: two people
 * reordering the same pair of shapes offline would produce the same integer twice and
 * merge to one of them. Fractional keys avoid that by leaving gaps.
 *
 * The invariant everything else depends on is that **lexicographic order is z-order**,
 * so the renderer's sorted view uses native `<` on strings with no comparator and no
 * allocation. That is why the alphabet is passed explicitly as base 62 in ascending
 * character-code order ('0'-'9', 'A'-'Z', 'a'-'z'); the library's ordering is
 * character order over whatever alphabet it is given.
 *
 * Key length is the property that decides whether this is viable at 5,000 shapes, so
 * it is measured rather than assumed: appending and prepending 5,000 keys both stay
 * within 4 characters, because an append spends one *position* rather than one
 * *character*. The alternative, extending the string on every insert, reaches roughly
 * 313 characters at 10,000 keys. The tests below assert the bound so the regression
 * cannot come back silently.
 *
 * The algorithm itself is `fractional-indexing` (CC0, zero dependencies), which is the
 * maintained implementation from the authors of the original. It is wrapped rather
 * than reimplemented because the ordering has subtle cases, and an earlier attempt to
 * hand-roll it here produced two real ordering bugs: a no-leading-zero key is *not*
 * order-equivalent to its numeric value, and fixed-width keys leave no gap for
 * `between`. This module is the only place in the codebase that imports the library,
 * so the four-function API below is the contract the rest of the app sees.
 *
 * See docs/03-frontend.md (Z-order) and docs/adr/0002-shape-representation-and-z-order.md.
 */

import { BASE_62_DIGITS, generateKeyBetween } from 'fractional-indexing'

/** A z-order key. Opaque: build these with these functions, never as literals. */
export type Key = string

/** The alphabet, fixed for the process. Part of the persisted format. */
const DIGITS = BASE_62_DIGITS

/** The first key on an empty board. */
export function first(): Key {
  return generateKeyBetween(null, null, DIGITS)
}

/**
 * A key above `prev`, for appending to the end of the z-order.
 */
export function after(prev: Key): Key {
  return generateKeyBetween(prev, null, DIGITS)
}

/**
 * A key below `next`, for prepending to the start of the z-order.
 *
 * Always succeeds. The library's key space grows the integer part outward without
 * bound in practice, and prepending 5,000 keys in a test does not approach the limit.
 */
export function before(next: Key): Key {
  return generateKeyBetween(null, next, DIGITS)
}

/**
 * A key strictly between `prev` and `next`, for inserting into a known gap.
 *
 * Either end may be null to mean "open", so this is a separate function from `after`
 * and `before` rather than a nullable parameter on one of them: the nullable case is
 * the rare one and does not belong in the common call's signature.
 *
 * Throws if both ends are given and `prev >= next`. The library tolerates that by
 * quietly sorting the pair, which would turn a caller's wrong argument into a key in
 * the wrong gap; the check here is what makes the mistake loud. It is unconditional
 * rather than dev-only because the failure it prevents is a silently wrong key
 * corrupting a live board's z-order, and finding that in production is worse than a
 * throw during a reorder action. Never called from the render loop.
 */
export function between(prev: Key | null, next: Key | null): Key {
  if (prev !== null && next !== null && !(prev < next)) {
    throw new Error(
      `between() requires prev < next, got ${JSON.stringify(prev)} and ${JSON.stringify(next)}`,
    )
  }
  return generateKeyBetween(prev, next, DIGITS)
}
