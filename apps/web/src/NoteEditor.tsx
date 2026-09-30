import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasController } from './canvas-controller.js'

/**
 * The board's frame budget, as a refresh interval.
 *
 * Sixteen milliseconds rather than a `requestAnimationFrame` loop: a rAF that runs forever
 * for a text field the user is not looking at is a thread kept busy for a rect. Polling at
 * the frame rate the board itself draws at is the same responsiveness for a fraction of the
 * work, and it stops the moment the field closes.
 */
const FRAME_MS = 16

/**
 * The text field for a note being edited.
 *
 * A `<textarea>` positioned over the note, not a canvas-drawn caret and not a modal. Three
 * reasons, in order of how much they mattered:
 *
 * 1. Typing must work. A canvas has no text input. Either the browser handles the keystroke
 *    or the app has to implement an editor, and the design puts content editing in a later
 *    phase but does not excuse the tool being unusable now. The native element also means
 *    IME composition, paste, autocorrect and mobile keyboards work without a line of code.
 * 2. The caret has to be where the text is. A DOM box over the note gets that for free and
 *    stays correct through zoom, pan and resize, where a caret drawn into the board canvas
 *    would need the same transform maths everything else on that canvas needs and would
 *    still not blink.
 * 3. It is not a modal. The board stays live: a collaborator's shapes keep arriving, and
 *    clicking away closes the editor rather than blocking the board behind a dialog.
 *
 * The value is the note's text, written through on every change. It is a controlled field
 * over a Yjs map, which for the same reason the drag rule does not apply here: a
 * `defaultValue` field would fight the document the moment two things disagreed, and text
 * has no preview stage.
 */
export function NoteEditor({
  controller,
  noteId,
}: {
  controller: CanvasController
  noteId: string
}) {
  const box = useRef<HTMLTextAreaElement | null>(null)
  // Screen rect, read from the controller rather than derived here. The controller holds the
  // camera and the store; duplicating either in React would be a second source of truth for
  // a value that changes on every wheel event.
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [text, setText] = useState(() => controller.noteText(noteId))

  // Re-read the rect every frame the note is open. The note can be moved by a collaborator,
  // and the camera can move under the caret, and a textarea that stays where it was left is
  // an editor that is typing into a place the text is not.
  useLayoutEffect(() => {
    const out = { x: 0, y: 0, w: 0, h: 0 }
    const measure = () => {
      if (!controller.noteScreenRect(noteId, out)) {
        // The note went away underneath the editor. The controller ends the session on the
        // next refresh; unmounting early would just be a flash of the wrong thing.
        return
      }
      setRect((previous) =>
        previous?.x === out.x &&
        previous.y === out.y &&
        previous.w === out.w &&
        previous.h === out.h
          ? previous
          : { x: out.x, y: out.y, w: out.w, h: out.h },
      )
    }
    measure()
    const id = window.setInterval(measure, FRAME_MS)
    const stop = (): void => {
      window.clearInterval(id)
    }
    return stop
  }, [controller, noteId])

  // Focus once, on open, and only on open. A refocus on every render would fight the
  // document: it would fight a remote update's render, and it would steal the caret back
  // from anywhere the user has clicked, including back into the field they are typing in.
  useEffect(() => {
    box.current?.focus()
    box.current?.select()
  }, [noteId])

  return (
    <textarea
      ref={box}
      className="note-editor"
      // Hidden until the rect is known. A textarea at 0,0 for one frame is a text field
      // visibly jumping across the board, and the jump is the first thing anyone sees.
      hidden={rect === null}
      value={text}
      spellCheck
      aria-label="Note text"
      // The font is scaled by the zoom rather than left at a fixed 14px. The canvas draws
      // note text at 14 * zoom, so a fixed-size field over a zoomed board would wrap at a
      // different width than the text it is editing: two notes that look identical would
      // break their lines in different places, and the caret would sit a line out from the
      // glyphs it belongs to. Line height is 1.4 for the same reason.
      style={
        rect === null
          ? undefined
          : {
              left: `${String(rect.x)}px`,
              top: `${String(rect.y)}px`,
              width: `${String(rect.w)}px`,
              height: `${String(rect.h)}px`,
              fontSize: `${String(14 * controller.zoom)}px`,
              lineHeight: '1.4',
            }
      }
      onChange={(event) => {
        setText(event.target.value)
        controller.setNoteText(event.target.value)
      }}
      onKeyDown={(event) => {
        // Escape and the canvas shortcuts are the browser's here: the canvas's own key
        // handler is on a different element, so it never sees this, and the board shortcuts
        // would otherwise be live while the caret is in this field. Stopping propagation is
        // enough — the global window listener checks the target first, but a shortcut that
        // reached the window would be a shortcut that fired while someone was typing.
        if (event.key === 'Escape') {
          event.stopPropagation()
          controller.endNoteEdit()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.stopPropagation()
          controller.endNoteEdit()
          return
        }
        event.stopPropagation()
      }}
      onBlur={() => {
        controller.endNoteEdit()
      }}
    />
  )
}
