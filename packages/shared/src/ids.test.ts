import { describe, expect, it } from 'vitest'
import { ID_PREFIXES, newId } from './ids.js'

describe('newId', () => {
  it('emits the requested prefix followed by a separator', () => {
    expect(newId('shp')).toMatch(/^shp_[0-9a-z]+$/)
  })

  it('does not repeat across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1_000; i++) seen.add(newId('blb'))
    expect(seen.size).toBe(1_000)
  })

  it('keeps IDs URL-safe', () => {
    expect(newId('brd')).toMatch(/^[0-9a-z_]+$/)
  })

  it('covers the prefixes documented in docs/README.md', () => {
    // docs/README.md lists these eight. If a prefix is added here without being
    // added to the README, this count is the thing that gets reviewed.
    expect(ID_PREFIXES).toHaveLength(8)
    expect([...ID_PREFIXES].sort()).toEqual([
      'blb',
      'brd',
      'cli',
      'prj',
      'req',
      'shp',
      'shr',
      'vrs',
    ])
  })
})
