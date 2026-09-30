import type { Tool } from './canvas-controller.js'

const TOOLS: { id: Tool; label: string; glyph: string; available: boolean }[] = [
  { id: 'select', label: 'Select', glyph: '⭢', available: true },
  { id: 'rect', label: 'Rectangle', glyph: '▭', available: true },
  { id: 'ellipse', label: 'Ellipse', glyph: '◯', available: true },
  { id: 'line', label: 'Line', glyph: '╱', available: true },
  { id: 'pen', label: 'Pen', glyph: '✎', available: true },
  { id: 'note', label: 'Note', glyph: '❝', available: true },
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
 * The tool list, in a floating pill on the bottom edge.
 *
 * Hover-revealed, which is the Figma arrangement and the one this component's own design
 * note used to argue against. Two things make it hold up here. The reveal is not hover-only:
 * `:focus-within` raises the pill too, so the keyboard can reach every tool, and a toolbar a
 * mouse can summon but a keyboard cannot is a worse regression than the discoverability tax
 * it trades for. And the pill floats over the board rather than sitting in a lane beside it,
 * so the cost is a 12px hotspot along the bottom edge instead of a 44px column down the
 * whole left side.
 *
 * `aria-pressed` rather than a class, because a toolbar that only looks selected is a
 * toolbar a screen reader cannot use. The `available` flag is kept rather than deleted with
 * the tools it used to disable: a tool that is not built yet is `disabled` and not merely
 * inert, because an enabled button that silently does nothing is worse than a visibly
 * unavailable one, and the next tool to arrive should be one flag rather than a decision
 * about which half of that to give up.
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
