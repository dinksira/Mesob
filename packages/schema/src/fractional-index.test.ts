import { describe, expect, it } from 'vitest'
import { after, before, between, first } from './fractional-index.js'
import type { Key } from './fractional-index.js'

/**
 * Every key must consist only of base-62 characters, and the library throws on
 * anything else, so the shape check here is deliberately weak: it guards against a
 * key that is merely valid-looking but came from the wrong alphabet.
 */
function assertWellFormed(key: Key) {
  expect(key).toMatch(/^[0-9A-Za-z]+$/)
}

describe('first', () => {
  it('produces a usable key', () => {
    assertWellFormed(first())
  })
})

describe('after', () => {
  it('produces a key strictly above its input', () => {
    let key = first()
    for (let i = 0; i < 1_000; i++) {
      const next = after(key)
      assertWellFormed(next)
      expect(key < next).toBe(true)
      key = next
    }
  })

  it('keeps 5,000 sequential appends within 4 characters', () => {
    // An append spends one position, not one character. Extending the string on every
    // insert instead reaches ~313 characters at 10,000 keys, so this bound is the
    // regression guard for that.
    let key = first()
    let longest = key.length
    for (let i = 0; i < 5_000; i++) {
      key = after(key)
      longest = Math.max(longest, key.length)
    }
    expect(longest).toBeLessThanOrEqual(4)
  })

  it('keeps 10,000 sequential appends within 4 characters', () => {
    let key = first()
    let longest = key.length
    for (let i = 0; i < 10_000; i++) {
      key = after(key)
      longest = Math.max(longest, key.length)
    }
    expect(longest).toBeLessThanOrEqual(4)
  })
})

describe('before', () => {
  it('produces a key strictly below its input', () => {
    // Unshifted, so the list ends up in ascending order.
    const keys: Key[] = [first()]
    for (let i = 0; i < 1_000; i++) {
      const lower = before(keys[0]!)
      assertWellFormed(lower)
      keys.unshift(lower)
    }
    expect(keys.every((k, i) => i === 0 || keys[i - 1]! < k)).toBe(true)
  })

  it('keeps 5,000 prepends within 4 characters', () => {
    let head = first()
    let longest = head.length
    for (let i = 0; i < 5_000; i++) {
      head = before(head)
      longest = Math.max(longest, head.length)
    }
    expect(longest).toBeLessThanOrEqual(4)
  })
})

describe('between', () => {
  it('fills the gap between two appended keys', () => {
    const low = first()
    const high = after(after(low))
    const mid = between(low, high)
    assertWellFormed(mid)
    expect(low < mid).toBe(true)
    expect(mid < high).toBe(true)
  })

  it('fills the gap between adjacent keys', () => {
    // 'V0' and 'V1' are consecutive, so no single digit fits and the answer must
    // borrow a position.
    const low = first()
    const high = after(low)
    const mid = between(low, high)
    expect(low < mid).toBe(true)
    expect(mid < high).toBe(true)
  })

  it('stays ordered when one gap is halved repeatedly', () => {
    const low = first()
    let high = after(after(low))
    for (let i = 0; i < 100; i++) {
      const mid = between(low, high)
      expect(low < mid).toBe(true)
      expect(mid < high).toBe(true)
      high = mid
    }
  })

  it('treats a null end as the open end of the list', () => {
    // Two nulls is the same request as an empty board.
    expect(between(null, null)).toBe(first())

    const second = after(first())
    const head = between(null, second)
    assertWellFormed(head)
    expect(head < second).toBe(true)

    const tail = between(second, null)
    assertWellFormed(tail)
    expect(second < tail).toBe(true)
  })

  it('throws when prev is not below next', () => {
    const low = first()
    const high = after(low)
    expect(() => between(high, low)).toThrow(/requires prev < next/)
    expect(() => between(low, low)).toThrow(/requires prev < next/)
  })
})

describe('ordering contract', () => {
  it('lets native sort reproduce append order without a comparator', () => {
    // This is the property the renderer's sorted view depends on, so it is asserted
    // through the runtime's own sort rather than a hand-written comparator.
    const appended: Key[] = [first()]
    for (let i = 0; i < 500; i++) appended.push(after(appended[i]!))

    const permuted = appended.filter((_, i) => i % 2).concat(appended.filter((_, i) => i % 2 === 0))
    expect(permuted).not.toEqual(appended)
    expect([...permuted].sort()).toEqual(appended)
  })

  it('lets native sort reproduce prepend order without a comparator', () => {
    const prepended: Key[] = [first()]
    for (let i = 0; i < 500; i++) prepended.unshift(before(prepended[0]!))

    const permuted = prepended
      .filter((_, i) => i % 2)
      .concat(prepended.filter((_, i) => i % 2 === 0))
    expect([...permuted].sort()).toEqual(prepended)
  })

  it('interleaving both ends still yields one total order', () => {
    // A board that grows at both ends at once, which is what interleaved edits look
    // like. The risk being guarded is a key collision or a key landing outside the
    // range the two cursors have established.
    let low = first()
    let high = first()
    const keys: Key[] = [low]
    const lowers: Key[] = []

    for (let i = 1; i <= 500; i++) {
      if (i % 2) {
        low = before(low)
        lowers.push(low)
        keys.push(low)
      } else {
        high = after(high)
        keys.push(high)
      }
    }

    expect(new Set(keys).size).toBe(keys.length)
    expect(lowers.every((k) => k < first())).toBe(true)
    for (const k of keys) expect(k < after(high)).toBe(true)
  })
})
