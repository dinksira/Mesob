import { IndexeddbPersistence } from 'y-indexeddb'
import type { Doc } from 'yjs'
import { useBoardStore } from './store.js'

/**
 * Local persistence.
 *
 * y-indexeddb writes the document to IndexedDB on every transaction, so a reload is a
 * restore rather than a loss. That is the whole of Phase 1 sync: there is no server in
 * this phase, and a green "saved" dot has to mean a copy the browser will actually give
 * back.
 *
 * Restoration is asynchronous and the board is not usable until it finishes, so the app
 * is told which of the three states it is in rather than guessing. The distinction
 * matters: "unavailable" means nothing will be kept and the user may lose work, and that
 * has to be visible, whereas "loading" is a moment.
 */
export interface Persistence {
  destroy(): Promise<void>
  /**
   * Resolves once IndexedDB has applied whatever it had stored.
   *
   * Typed as the promise the library hands back rather than `Promise<void>`: it resolves
   * to the persistence instance, and the value is not interesting, but re-declaring the
   * type as void means casting the resolution, which is worse than an honest type.
   */
  whenSynced: Promise<unknown>
}

export function persistLocally(doc: Doc, room = 'mesob-board'): Persistence {
  const persistence = new IndexeddbPersistence(room, doc)
  const setSync = useBoardStore.getState().setSync

  setSync('local')

  void persistence.whenSynced
    .then(() => {
      setSync('local')
    })
    .catch(() => {
      // A rejected `whenSynced` is a store that could not be opened at all: private
      // browsing, a blocked origin, or a corrupt database. The document still works, it
      // just will not survive a reload, and the indicator has to say so rather than
      // continuing to claim the work is saved.
      setSync('error')
    })

  // IndexedDB can fail *after* the first sync, when a write is rejected. The indicator
  // is the only place a user would learn their last few edits are not being kept, so the
  // failure is worth surfacing rather than logging.
  persistence.on('synced', () => {
    setSync('local')
  })

  return {
    whenSynced: persistence.whenSynced,
    destroy: () => persistence.destroy(),
  }
}
