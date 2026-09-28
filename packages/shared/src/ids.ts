/**
 * Prefixed CUID2 identifiers.
 *
 * The prefix makes an ID self-describing in a log line, a URL, and a stack trace,
 * which is the entire reason for the format. CUID2 underneath because it is short,
 * collision-free, sortable, and URL-safe.
 *
 * The prefix list is an exhaustive union, not a free-form string, so a typo in a
 * call site is a compile error rather than an ID that is unrecognisable to every
 * reader. It mirrors the table in docs/README.md and the ID format in
 * docs/05-database-and-storage.md; the test below asserts the two lists agree in
 * size so adding an ID to the code without updating the docs is noticed.
 *
 * IDs are never reused and never derived from user input.
 */

import { createId } from '@paralleldrive/cuid2'

export const ID_PREFIXES = [
  'brd', // board
  'shp', // shape
  'vrs', // version
  'shr', // share link
  'cli', // client instance
  'req', // request id
  'prj', // project
  'blb', // block
] as const

export type IdPrefix = (typeof ID_PREFIXES)[number]

/** `${prefix}_${cuid2}`, e.g. `shp_4m1k8...`. */
export type Id<P extends IdPrefix> = `${P}_${string}`

/** A fresh ID for the given resource. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${createId()}`
}
