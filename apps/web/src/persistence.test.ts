// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * The storage indicator is only useful if it is honest, and the way it stops being honest
 * is by staying at "local" after IndexedDB has stopped accepting writes. These are the
 * cases a user meets in private browsing, on a blocked origin, or with a corrupt database,
 * and none of them throws anywhere a person would see it.
 *
 * The library is mocked rather than a fake IndexedDB being built: the behaviour under test
 * is the translation from "the store would not open" to "tell the user it is not being
 * saved", and standing up enough of IndexedDB to provoke that would be a browser emulator
 * in a test file. The rejection is injected, which is the actual input to this code.
 */

const whenSynced = { current: Promise.resolve(null) as Promise<unknown> }

vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class extends EventEmitter {
    // Declared rather than assigned through a constructor parameter property: the repo
    // builds with `erasableSyntaxOnly`, which forbids syntax that needs emitting.
    readonly room: string
    readonly doc: unknown
    whenSynced: Promise<unknown>

    constructor(room: string, doc: unknown) {
      super()
      this.room = room
      this.doc = doc
      this.whenSynced = whenSynced.current
    }

    destroy(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

const { Doc } = await import('yjs')
const { useBoardStore } = await import('./store.js')
const { persistLocally } = await import('./persistence.js')

beforeEach(() => {
  whenSynced.current = Promise.resolve(null)
  useBoardStore.getState().setSync('unavailable')
})

afterEach(() => {
  vi.clearAllMocks()
  useBoardStore.getState().setSync('unavailable')
})

describe('persistLocally', () => {
  it('starts out reporting that the copy is local', async () => {
    const persistence = persistLocally(new Doc(), 'room-a')
    await persistence.whenSynced
    expect(useBoardStore.getState().sync).toBe('local')
    await persistence.destroy()
  })

  it('reports the error state when the store cannot be opened', async () => {
    whenSynced.current = Promise.reject(new Error('blocked'))

    const persistence = persistLocally(new Doc(), 'room-b')
    await persistence.whenSynced.catch(() => undefined)

    // The indicator claims "local" optimistically, because IndexedDB is being given a
    // chance. This is the assertion that matters: the claim gets corrected instead of
    // being left standing over a document that is not being kept anywhere.
    await vi.waitFor(() => {
      expect(useBoardStore.getState().sync).toBe('error')
    })
  })

  it('survives a rejection without leaving it unhandled', async () => {
    whenSynced.current = Promise.reject(new Error('blocked'))
    const persistence = persistLocally(new Doc(), 'room-c')
    await vi.waitFor(() => {
      expect(useBoardStore.getState().sync).toBe('error')
    })
    // Reaching here without the process reporting an unhandled rejection is the
    // assertion; `persistLocally` has to catch what it asked for.
    await persistence.destroy()
  })
})
