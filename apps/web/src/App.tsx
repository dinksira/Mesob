// Phase 1 renders nothing. The canvas lands in the next commit, and an empty
// return is honest about that rather than a placeholder card that has to be
// torn out. See docs/phase-1-design.md.
export function App() {
  return null
}
