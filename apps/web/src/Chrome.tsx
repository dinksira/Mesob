export type SyncState = 'local' | 'offline' | 'error' | 'unavailable'

const TEXT: Record<SyncState, string> = {
  local: 'saved to this device',
  offline: 'offline — edits are stored locally',
  error: 'could not save locally',
  unavailable: 'local storage unavailable — edits last only for this session',
}

export interface SyncIndicatorProps {
  state: SyncState
  shapeCount: number
}

/**
 * The top-right cluster's storage indicator.
 *
 * Each state carries a text label, never colour alone. A dot that is red for an error and
 * amber for offline is a dot that means nothing to anyone who cannot see the hue, and the
 * label is what makes the state legible at all.
 */
export function SyncIndicator({ state, shapeCount }: SyncIndicatorProps) {
  return (
    <div className="sync" data-state={state} role="status" aria-live="polite">
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-text">
        {state === 'local' ? `${TEXT.local} · ${String(shapeCount)} shapes` : TEXT[state]}
      </span>
    </div>
  )
}

export interface EmptyStateProps {
  toolLabel: string
}

/**
 * The empty board.
 *
 * Not blank, and not a watermark alone: a watermark does not say what to do. One faint
 * starter note carrying the hint in both languages, over a woven pattern. The pattern is
 * allowed here and only here, because this is a transient state; C2 keeps it off the
 * working surface, where it would compete with shape fills.
 */
export function EmptyState({ toolLabel }: EmptyStateProps) {
  return (
    <div className="empty" aria-hidden="true">
      <div className="empty-woven" />
      <p className="empty-note">
        <span lang="am">በካንቫስ ጠርክ፣ ማጣቀሻ ሰጥንት</span>
        <span className="empty-note-sep">·</span>
        <span>Drag on the canvas to draw. Press R for the rectangle tool.</span>
      </p>
      <p className="empty-tool">
        Current tool: <strong>{toolLabel}</strong>
      </p>
    </div>
  )
}
