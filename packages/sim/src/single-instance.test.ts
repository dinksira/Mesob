/**
 * The one-yjs-instance check.
 *
 * The root `pnpm.overrides` entry pins Yjs to a single version across the workspace,
 * because the schema hands out Yjs types and `SimWorld` constructs `Y.Doc`s, and two
 * copies of Yjs in one store means two private registries of document state. Each copy
 * would maintain its own notion of which client IDs it has seen, so an update produced by
 * one would look like an update from an unknown client to the other, and would be dropped
 * without an error. That failure is silent, intermittent, and close to impossible to
 * diagnose from a stack trace, so a cheap guard is worth having.
 *
 * Comparing types would not catch it, because the failure needs two *runtime* module
 * instances reached through different specifiers. So this compares constructors, and then
 * checks the consequence.
 */

import { describe, expect, it } from 'vitest'
import { applyUpdate, encodeStateAsUpdate, Doc as SimDoc } from 'yjs'
import { Doc as SchemaDoc, readBoard, shapesMap } from '@mesob/schema'
import { SimWorld } from './sim-world.js'

describe('a single yjs instance', () => {
  it('resolves the same Doc constructor through the schema barrel and through yjs', () => {
    expect(SchemaDoc).toBe(SimDoc)
  })

  it('carries an update from one entry point to the other', () => {
    // The consequence, not the mechanism. With two copies, this document would accept an
    // update and then report itself unchanged, which is precisely the silent failure.
    const writer = new SchemaDoc()
    writer.getMap('probe').set('k', 'v')

    const reader = new SimDoc()
    applyUpdate(reader, encodeStateAsUpdate(writer))

    expect(reader.getMap('probe').get('k')).toBe('v')
  })

  it('gives the schema readers a document the sim built', () => {
    // Schema and sim agree on the Doc they are talking about, not just on the class.
    const world = new SimWorld({ replicas: 1 })
    const doc = world.replicas[0]!.doc
    doc.getMap('probe').set('k', 'v')

    expect(doc).toBeInstanceOf(SchemaDoc)
    expect(readBoard(doc)).toEqual([])
    expect(shapesMap(doc).get('anything')).toBeUndefined()
    world.destroy()
  })
})
