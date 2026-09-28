import type { Tool } from './canvas-controller.js'

const TOOLS: { id: Tool; label: string; glyph: string; available: boolean }[] = [
  { id: 'select', label: 'Select', glyph: '⭢', available: true },
  { id: 'rect', label: 'Rectangle', glyph: '▭', available: true },
  { id: 'ellipse', label: 'Ellipse', glyph: '◯', available: true },
  { id: 'line', label: 'Line', glyph: '╱', available: false },
  { id: 'pen', label: 'Pen', glyph: '✎', available: false },
  { id: 'note', label: 'Note', glyph: '❝', available: false },
]

const SHORTCUTS: Record<Tool, string> = {
  select: 'V',
  rect: 'R',
  ellipse: 'O',
  line: 'L',
  pen: 'P',
  note: 'N',
}

/**
 * The same table keyed the other way, for the keyboard handler.
 *
 * Derived rather than written out again because the two facts have to agree: the key
 * printed on a tool's button and the key that selects it are the same shortcut, and two
 * literals would eventually differ with nothing to notice. Only the available tools are
 * included, so a shortcut cannot select a tool whose button is disabled.
 */
export const TOOL_FOR_KEY: ReadonlyMap<string, Tool> = new Map(
  TOOLS.filter((t) => t.available).map((t) => [SHORTCUTS[t.id].toLowerCase(), t.id]),
)

export interface ToolbarProps {
  tool: Tool
  onToolChange: (tool: Tool) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

/**
 * The left-edge tool list.
 *
 * 44px, always visible, icon-only. A hover-revealed toolbar is a discoverability tax and
 * Phase 1 has no command palette to teach the shortcuts, so it stays put.
 *
 * `aria-pressed` rather than a class, because a toolbar that only looks selected is a
 * toolbar a screen reader cannot use. The tools that Phase 1 has not built are `disabled`
 * and not merely inert: an enabled button that silently does nothing is worse than a
 * visibly unavailable one.
 */
export function Toolbar({ tool, onToolChange, canUndo, canRedo, onUndo, onRedo }: ToolbarProps) {
  return (
    <nav className="toolbar" aria-label="Tools">
      {TOOLS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="tool"
          aria-pressed={tool === item.id}
          disabled={!item.available}
          title={`${item.label} (${SHORTCUTS[item.id]})`}
          onClick={() => {
            onToolChange(item.id)
          }}
        >
          <span aria-hidden="true">{item.glyph}</span>
          <span className="visually-hidden">{item.label}</span>
        </button>
      ))}
      <span className="toolbar-separator" role="separator" />
      <button
        type="button"
        className="tool"
        aria-label="Undo"
        disabled={!canUndo}
        title="Undo (Z)"
        onClick={onUndo}
      >
        <span aria-hidden="true">↺</span>
      </button>
      <button
        type="button"
        className="tool"
        aria-label="Redo"
        disabled={!canRedo}
        title="Redo (Shift Z)"
        onClick={onRedo}
      >
        <span aria-hidden="true">↻</span>
      </button>
    </nav>
  )
}
