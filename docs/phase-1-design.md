# Phase 1 design

> **Status: draft** · Sibling of [03 - Frontend](./03-frontend.md) · Feeds gate G1

## What this document is

[03](./03-frontend.md) specifies the frontend by subsystem: state ownership, the render loop,
interaction, document blocks, offline behaviour. It is phase-independent, and it stays that way.

This document is the **Phase 1 slice**: the visual language, the chrome layout, and the component
list for the first gate. Two different lifecycles, deliberately kept apart:

| Content | Lifecycle | Where it ends up |
|---|---|---|
| Colour tokens, chrome layout, the design constraints | Phase-independent. These survive to production. | Folded back into [03](./03-frontend.md) when G1 passes |
| Component list, Phase 1 scope, G1 criteria | Phase-scoped. Superseded by Phase 2 | Deleted, or kept as a record |

Unlike an ADR, this document is **revised when the implementation proves the design wrong**. That is
the expected case, not an exception. Sibling files are named `phase-N-design.md` and sit at the top
level of `docs/`, rather than as a numbered supplement to 03, because this is a phase slice and not
a supplement.

## Scope

Phase 1 is the G1 gate: a local-first canvas with no server. It is not a Milova clone with the
network removed, and it does not attempt the features that need infrastructure Phase 1 does not have.

**In:** infinite pan/zoom · shape primitives · selection, drag, resize, rotation · fractional-index
z-order ([ADR-0002](./adr/0002-shape-representation-and-z-order.md)) · `Y.UndoManager` ·
IndexedDB persistence · 5,000 shapes at 60fps with a zero-allocation draw loop.

**Out, and why:**

| Excluded | Reason | Lands |
|---|---|---|
| `image` tool | Needs the R2 presigned-upload path | G2 |
| Realtime server, REST API, Postgres | Phase 1 is single-user | G2 |
| Presence, collaborator cursors | Needs a second client to be visible | G3 |
| Sharing, auth, comments | Needs the enforcement point ([ADR-0004](./adr/0004-authorization-before-apply.md)) | G4 |
| Version timeline, restore | Restore depends on a persisted log ([ADR-0003](./adr/0003-restore-is-a-forward-update.md)) | G5 |
| Document blocks | Tiptap mount is Phase 3; 50 live ProseMirror instances is a cliff | G3 |
| Merge-summary toast | Needs a server to count remote changes against | G2 |
| Anchored `arrow` connectors | Shape-anchor snapping and orphan-on-target-delete need a ref-bearing shape type | G2 |
| Separate `text` tool | A second text-bearing primitive over the same note storage, with nothing to distinguish it yet | G3 |

**One connector primitive, not two.** The original wording of this constraint was "no `line`
primitive: a line is an `arrow` with no arrowhead". That is honoured, with one naming change that
needs recording rather than hiding.

The shipped primitive is `line`, carrying `x1/y1/x2/y2` and an optional `head` flag. Still one
type, one factory, one fuzz case, no new user capability — which was the whole point of the
constraint. What changed is the name: the toolbar's tool is *Line*, the doc has no anchor
snapping, and calling the stored type `arrow` would make the schema, the renderer and the button
the user presses all disagree about what they are. A type named for a capability that is not
implemented (`arrow` implying shape-anchored connectors) is worse than a type named for what the
tool does.

The consequence to keep in mind: if anchored connectors arrive in Phase 2 as a *different*
behaviour — snapping to shape edges, tracking their target, orphaning rather than deleting — that
is a new type with `srcId`/`targetId` refs, not a flag on this one. The flag stays.

## Design constraints

These are **constraints, not guidelines**. Implementation may not violate them without a decision
record, because each one exists to prevent a specific failure that is easy to walk into.

**C1. The canvas is the hero; chrome is recessive.**
No fixed sidebar, no fixed top bar, no panel that permanently occupies canvas area. The viewport
belongs to the user's content.

**C2. The pattern marks transitions only.**
The woven-texture pattern appears **only** in transient states — empty, loading, reconnecting. It
never appears on the working surface. A pattern on the canvas competes with shape fills for
attention and makes the content look like part of the brand. If a pattern is added anywhere because
"it fits the identity" rather than "this state is transient", that is the costume failure mode and
the change is wrong.

**C3. Colour comes from a cited source.**
Accent and substrate values are drawn from documented mesob dye pigments, cited in the token table.
Warm brown chosen by taste is not a palette, it is a story attached to an arbitrary hex value, and
it will not survive review. Where a value is interpreted rather than measured, it says so in its
own row.

**C4. The canvas is a neutral substrate.**
Shape content is the only thing on screen that should carry colour. Chrome is desaturated, and the
accent appears in exactly four places: selection ring, focus ring, active tool, offline banner. The
8-colour collaborator palette is a separate system for a separate constraint and is never merged
with these tokens.

**C5. Offline is a visible state, not a hidden one.**
The product thesis is that the network is optional, so connection state is always on screen. A
hidden connection indicator argues against the thesis.

**C6. The focus ring is never removed.**
2px, always present, and visible against both the substrate and every shape fill. The shape list
panel is the accessible mirror of the canvas and must be fully keyboard-operable.

**C7. `prefers-reduced-motion` disables all easing.**
Camera lerp, merge animations, and toast transitions become instant. Not "shorter" — disabled.

## Colour tokens

Three accents and a substrate, no more, plus one non-pigment chrome surface that exists for a
contrast reason rather than a palette one (below). Every value traces to a documented source; the
ones that involve a judgement call say so explicitly.

| Token | Value | Role | Source |
|---|---|---|---|
| `--substrate` | `#FAF7F2` | Canvas background | Undyed natural straw. **Interpreted**, see note 1 |
| `--madder` | `#B8463A` | Selection ring, focus ring, active tool, offline banner | Madder lake, darker end. **Interpreted**, see note 2 |
| `--charcoal` | `#2A2622` | All text, toolbar icons at rest, shape outlines at rest | Warm carbon black, not `#000000` |
| `--indigo-overlay` | `#5B3A52` | Reserved: G2 version-scrubber "viewing history" | Purple of the museum piece. **Unused in Phase 1** |
| `--chrome-surface` | `#FFFFFF` | The floating toolbar pill's own material | Not a pigment and not one of the four. Chrome needs a surface lighter than the substrate, or a cream pill on a cream board has no edge |

Derived from `--charcoal` at reduced alpha: secondary text, panel edges, the dot grid. No derived
token gets its own hex. `--chrome-surface` is not derived: a shadow cannot stand in for a fill.

### Why these values

**The substrate is natural straw, not white.** Every source documents the basketry as dyed *partially*
— natural straw is the substrate and the dominant surface, and dye is selective, used for pattern.
`#FAF7F2` sits lighter than dried grass (which reads nearer `#E8D5A8`) because the canvas is a
surface for user content, not a reproduction of the material. The warmth is the cultural signal; the
lightness is the legibility signal, and the second is a design requirement rather than a historical
one.

**Madder lake is the red.** Natural Red 9, C.I. 75330/75420, from *Rubia tinctorum* root, documented
across the region from Egyptian textile archaeology through the Horn. The named-colour reference
`#CC3336` is the modern standard; the design system uses a darkened derivative because madder applied
to fibre saturation reads deeper than madder ground in oil paint. **This is the one interpretive
choice in the palette.** The pure cited value `#CC3336` is defensible and differs by 0.14:1 of
contrast ratio against the substrate — imperceptible. If anyone prefers the cited value on principle,
swapping it is a one-line change with no other consequence.

**Charcoal, not black.** `#000000` is a screen colour, not a pigment colour. Warm black from organic
combustion carries a brown undertone that sits with the straw substrate; pure black reads as a hole
in the palette.

**Three accents, not five.** The temptation is the Ethiopian flag palette (green, yellow, red, blue).
That palette belongs to the flag, not to the mesob, and reaching for it would be the costume failure
mode C2 exists to prevent — "it fits the identity" with nothing behind it. The mesob's documented
palette is straw, red, and one secondary. Three is the honest number.

**Purple or black as the secondary?** Genuinely ambiguous, and this is a real evolution rather than
a contradiction in the sources: the early 20th-century museum piece is red and purple, modern
authenticated Harari pieces are red and black. Purple is the more defensible choice because it is the
documented museum-piece colour, and `charcoal` already covers the black read as a text colour.

### Contrast

Measured against `--substrate` `#FAF7F2` (WCAG 2.1 relative luminance):

| Pair | Ratio | Use |
|---|---|---|
| `charcoal` on `substrate` | 14.05:1 | Body text — passes AAA |
| `indigo-overlay` on `substrate` | 9.05:1 | Reserved accent |
| `madder` on `substrate` | 4.94:1 | Focus ring (needs 3:1), and body text (needs 4.5:1) |
| `charcoal` on `madder` | 3.05:1 | Icon on a filled active-tool button — **UI only, never text** |

`madder` is used as a text colour nowhere in Phase 1. If a later surface needs madder text, the next
darker step `#A83F34` reaches 5.74:1 and should be used instead; the sequence is already
computed rather than left to whoever hits the problem.

The 8-colour collaborator palette ([03 §7](./03-frontend.md#7-presence-rendering)) is specified in
03 and is **not** touched here. It is optimised for colourblind separability, which is a different
constraint from brand palette. The two must not be merged, and the focus ring must not be
recoloured to match a collaborator's cursor.

**Phase 1 ships one theme: light.** Dark mode is deferred deliberately, and the reason is a cost,
not a difficulty: a dark substrate changes the contrast math for every shape fill, which is a visual
test matrix expansion for a feature with no bearing on G1. When it lands it goes behind
`prefers-color-scheme` with the shape palette **re-derived, not inverted** — inverted colours fail
contrast on a dark substrate.

### Sources

1. Kingsland, Madeleine. *Mesob* [StoryMap]. Stanford University Archaeology Collection, December
   2022. Object IDs 95.1021 and 95.1008, early 20th c. (1900–1950 CE), Ethiopia. Describes a fibre
   coil-work basket with lid, "red and purple bonds", plant fibre over a core of grasses or straw,
   and notes natural dye from berries, roots, barks, leaves and clay.
2. Tarsitani, Belle Asante. "Revered Vessels: Custom and Innovation in Harari Basketry." *African
   Arts* 42, no. 1 (Spring 2009): 68–81. MIT Press. — cited in Wikipedia, *Mesob*.
3. *Encyclopaedia Aethiopica*, s.v. "Basketry." — cited in Wikipedia, *Mesob*. Source of "partially
   dyed grass and palm leaves".
4. Kremer Pigmente. "Madder Lake, genuine" (product 37202). Natural Red 9, C.I. 75330/75420,
   *Rubia tinctorum*. The pigment-chemistry reference for the red family.
5. Webexhibits. "Pigments through the Ages: Madder Lake." Museum-grade pigment history.
6. "Madder Lake" named colour, `#CC3336`. color-hex.com. The modern named-colour standard this
   palette darkens.

**A distinction worth keeping.** Sources 2 and 3 describe the *traditional* palette, reconstructed
from documented natural-dye methods and the pigment chemistry of the plants in that set. The
20th-century museum piece in source 1 may already use commercial dyes. So this palette is honest
about what it is: a reconstruction of the traditional palette from documented dye methods, **not** a
swatch lifted from a specific museum object. Anyone citing it later should say so rather than
implying the hex values are sampled from an artefact.

## Chrome layout

**Horizontal bottom-centre pill, hover-revealed.** A rounded container floating over the canvas on
the bottom edge, one item per tool plus separator plus undo/redo, revealed when the pointer reaches the
bottom edge. The reveal band is the **full 64px** of the bottom edge, not a hairline: the point of a
hover-revealed toolbar is that nobody has to aim at it. A visible grip is parked at the bottom centre
permanently, and it widens on hover — a hotspot with nothing to aim at is undiscoverable rather than
tidy, and "the tools are down there somewhere" is exactly the failure mode this arrangement invites.

The pill **floats over the board rather than occupying a lane**, so the infinite surface reaches all
four edges. The earlier 44px left column is superseded.

Three properties are not negotiable, because they are the cost of the arrangement:

1. **The reveal is not hover-only.** `:focus-within` raises the pill as well. A toolbar a mouse can
   summon but a keyboard cannot is a worse regression than the discoverability tax it trades for, and
   this document's objection to the bottom pill was always about hover-revealed chrome, not about
   placement. The collapsed state is therefore `opacity: 0` + `pointer-events: none` and **not**
   `display: none` or `visibility: hidden`: both of those remove the buttons from the tab order, the
   pill becomes unreachable by keyboard, and `:focus-within` can never fire — the exact regression the
   rule exists to prevent. Nor is the pill slid below the viewport, because a focused element inside
   an `overflow: hidden` container gets scrolled into view and the first Tab would shift the board.
2. **The band is a real cost.** 64px of the bottom edge, full width, cannot be drawn into. It is
   generous on purpose, and the trade is made knowingly: the 44px column it replaced was unavailable
   at every height, but that column was at least visible. If drawing near the bottom edge turns out
   to matter more than not having to aim, the band is one number.
3. **The handle is not a control.** It carries no role and no label because it does nothing on click.
   It is a target, not a button; making it focusable would add a keyboard stop that goes nowhere.

Not a top bar: it puts persistent chrome where the top of the viewport should be. Not a hover-revealed
*left* column, which is the same trade with a worse hit target — the bottom edge is where a pointer
already travels on the way to a zoom control, and a pill centred there covers the least canvas.

**Top-right cluster:** board name, sync indicator, and nothing else. Version history, settings, and
the shape list are keyboard-driven and slide in as overlays.

**Sync indicator states**, each with a text label available to assistive tech, never colour alone:

| State | Indicator | Text |
|---|---|---|
| Persisted locally | Neutral dot | `saved to this device · N shapes` |
| Offline | Amber | `offline — edits are stored locally` |
| Error | Red | `could not save locally` |

Phase 1 has no server, so the indicator reports **local** persistence only. There is deliberately no
merge-summary toast here: it needs a server to count remote changes against, and a shell built now
for G2 data is exactly the drift this project has been correcting.

**Offline banner:** thin amber line at the top of the canvas, below the toolbar cluster, shown only
when offline. C2 applies — it may use the pattern.

## Empty state

Not blank, and not a watermark alone: a watermark does not say what to do.

1. One faint starter `note`, `opacity: 0.35`, carrying the hint in Amharic and English. (`note` is the
   primitive's name in [03 §3](./03-frontend.md#3-interaction-and-tools), and the only text-bearing
   shape in Phase 1)
2. A woven watermark behind it, per C2 — this state is transient, so the pattern is correct here.
3. **The cursor carries the active tool.** On an empty canvas, the pointer is replaced by the active
   tool's icon, and moving it previews the shape outline at the pointer before any drag begins.

Mechanism 3 is what makes an empty canvas feel alive rather than disabled, and it costs nothing in
the draw loop: the preview is a draw-time transform of a shape that does not exist yet, which is the
same mechanism as the live-drag override below.

**First interaction is the first shape.** No modal, no tour, no "create your first board".

## Interaction notes

Recorded here where the design or the tool behaviour is non-obvious. Most interaction is already
specified in [03 §3](./03-frontend.md#3-interaction-and-tools) and is not restated.

**Live drag is a pure render transform.** Already specified in 03: Yjs is untouched until
pointer-up. Restated because it is the single rule most likely to be violated by a well-meaning
"let's make dragging feel more responsive" change, and the reason is two-fold: 60 writes/second
floods the update log, and CRDT operations during a drag make the Conflict Visualizer meaningless.

**Pen is the exception to live drag, and deliberately so.**
Every other tool's in-progress state is a transform of an existing shape. A pen stroke is a
continuous stream of points that must be **buffered locally and previewed from the buffer**, then
committed as one shape on pointer-up. Same end behaviour (single authoritative write on
pointer-up), different intermediate path. The buffer is a preallocated `Float32Array` that grows by
doubling; it is reused across strokes and never allocated per pointer-move event, or the
zero-allocation draw-loop budget is dead.

**Arrow with no arrowhead is a line.** A property on the existing primitive, not a new shape type.

## Component list

React components, Phase 1 only. Canvas-drawing code is not React and is called from the render
loop directly.

| Component | Responsibility | Notes |
|---|---|---|
| `<App>` | Shell, layout, keyboard routing | Owns the command table |
| `<Board>` | The three-canvas stack | See [03 §2](./03-frontend.md#2-the-render-loop) |
| `<Toolbar>` | Bottom-centre tool pill | Rounded, floats over the board, hover- or focus-revealed |
| `<ToolButton>` | One tool, icon + tooltip | `aria-pressed`, not `aria-selected` |
| `<SyncIndicator>` | Local persistence state | Dot plus accessible text |
| `<OfflineBanner>` | Amber banner when offline | C2 applies |
| `<EmptyState>` | Starter `note` + watermark | Hidden on first shape |
| `<ShapeListPanel>` | Focusable ARIA listbox mirror | **G2 deliverable.** See accessibility below |
| `<CommandPalette>` | `Ctrl/Cmd+K`, generated from the command table | **In Phase 1.** 12 shapes × 4 operations is exactly the size where a palette earns its keep. Shipping shortcuts without it means hand-maintaining a shortcut map, then retrofitting the command table later — a refactor in the module everything imports |
| `<ShortcutSheet>` | `?` opens | Generated from the same table |

## Accessibility

**The G1 accessibility story is the keyboard path, not the shape list.** A focusable ARIA listbox
mirroring the canvas is the right end state, and it is a **G2 deliverable** — it lands with the
keyboard-navigable shape list that [03 §10](./03-frontend.md#10-accessibility) prescribes. Deferring
it is sequencing, not a scope cut: a listbox with no shapes to list is an empty widget.

What G1 ships instead is full keyboard operation of the canvas:

| Keys | Action |
|---|---|
| `Tab` | Move focus to the canvas |
| `V` `R` `E` `N` `T` `A` `P` | select, rect, ellipse, note, text, arrow, pen |
| Arrow keys | Nudge selection 1 world unit |
| `Shift` + arrows | Nudge 10 units |
| `Delete` | Delete selection |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `Ctrl/Cmd+A` | Select all |
| `Ctrl/Cmd+0` / `Ctrl/Cmd+1` | Reset zoom / fit to content |
| `Ctrl/Cmd+D` | Duplicate |
| `Space` + drag | Temporary pan |
| `Ctrl/Cmd+K` | Command palette |
| `?` | Shortcut sheet |

Every command is in the one command table, so the palette, the shortcut handler, and the sheet are
generated from the same list. A command whose predicate fails is shown disabled rather than hidden,
so the muscle memory is learnable.

Two requirements that are easy to lose in a canvas implementation: focus must be visible at all
times (C6), and the canvas must expose an accessible name and role so a screen reader announces it
as an application surface rather than as an empty graphic.

## G1 acceptance

Machine-checkable, and each line names where it is measured. A gate is passed by evidence in the PR.

| Criterion | Measured by | Gate |
|---|---|---|
| p95 frame < 16 ms at 5,000 shapes | CI perf harness, not a laptop | G1 |
| Zero allocation in the draw loop | Harness assertion, sampled across a pan and a zoom | G1 |
| Pan/zoom/select/move/resize/rotate correct at 0.1x and 8x | Property tests against the viewport maths | G1 |
| Undo is local-only, and a word is one entry | `Y.UndoManager` with `captureTimeout` 300ms | G1 |
| Reload restores the board from IndexedDB | E2E | G1 |
| **TTI from IndexedDB < 1 s, no network in path** | E2E, network disabled at the browser | **G1** |
| **Merge converges: P1 at 200 runs, P2 at 1,000** | Fuzz, per-push | **G1** |
| Focus ring present, canvas keyboard-operable | Axe + keyboard walk | G1 |
| Amharic renders without tofu | Visual test, Windows and Linux | G1 |
| *TTI < 1 s with the WS endpoint unreachable* | *E2E, WS blackholed* | **G2** |
| *Merge summary after a partitioned session* | *E2E + Visualizer* | **G2** |
| *`<ShapeListPanel>` operable by keyboard and screen reader* | *Axe + keyboard walk* | **G2** |

Two G1 accessibility rows are in the table above: focus ring present, and canvas keyboard-operable
end to end. The shape list panel is the third accessibility item in [03 §10](./03-frontend.md#10-accessibility)
and it is a G2 deliverable, for the sequencing reason given in the accessibility section.

**The TTI split.** The G1 criterion is TTI with no network in the path, because that is what Phase 1
can actually test — there is no server. The blackholed-WebSocket case is a real and stronger
guarantee, and it is a G2 criterion. Stating the G1 line as the blackholed one would have G1
claiming a guarantee it does not test, which is the doc/code drift this project is built to avoid.

## References

- [03 - Frontend](./03-frontend.md) — the phase-independent spec this slices; §2 render loop,
  §3 interaction, §7 collaborator palette, §10 accessibility
- [01 §5](./01-system-design.md#5-key-design-decisions) — D3, D5 (shape representation, z-order)
- [ADR-0002](./adr/0002-shape-representation-and-z-order.md) — shape representation and z-order
- [ADR-0003](./adr/0003-restore-is-a-forward-update.md) — why versions are deferred
- [ADR-0004](./adr/0004-authorization-before-apply.md) — why sharing is deferred
- [13 - Testing](./13-testing.md) — the suites the acceptance table draws from
