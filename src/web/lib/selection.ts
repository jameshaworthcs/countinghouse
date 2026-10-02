// Choosing rows of a list with the mouse and the keyboard's modifiers (docs/ARCHITECTURE.md, "UI"):
//
// - A click (or Ctrl/⌘-click) ticks or unticks one row, and makes it the anchor.
// - A Shift-click ticks every row from the anchor to it, on top of what was ticked before; another
//   Shift-click in the same hold of Shift moves the end of that range.
// - Each new hold of Shift starts a group of its own: its first click is the new anchor, so groups
//   chosen in separate holds never fill the gap between them. A Shift-click right after a plain
//   click extends from that click, as everywhere else.
// - A range takes the anchor's state: from an unticked anchor it unticks.
//
// The rules are pure (`nextSelection`) so they can be tested. In ./useSelection.ts, `useShiftHold`
// counts the holds of Shift, and `useRowSelection` holds a selection of its own (a list whose ticks
// live elsewhere, like an import's rows, keeps just the anchor).

export interface Modifiers {
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface Anchor {
  id: string;
  /** The hold of Shift it belongs to: the holds counted when it was set. */
  hold: number;
  /** Set by a click without Shift: the next hold that clicks may extend from it. */
  plain: boolean;
  /** Ticked (a range from it ticks) or not (a range unticks). */
  on: boolean;
  /** What was ticked before the range from it. */
  base: ReadonlySet<string>;
}

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor?: Anchor | undefined;
}

/**
 * The selection after a click on `id`, given the order of the rows on screen and the holds of Shift
 * counted so far (`hold`: the current one, while Shift is down).
 */
export function nextSelection(state: SelectionState, order: readonly string[], id: string, mods: Modifiers, hold: number): SelectionState {
  const a = state.anchor;
  // An anchor this hold may extend from: one set in it, or the last plain click.
  const usable = a && order.includes(a.id) && (a.hold === hold || a.plain);
  if (mods.shiftKey && a && usable) {
    const [i, j] = [order.indexOf(a.id), order.indexOf(id)];
    const range = order.slice(Math.min(i, j), Math.max(i, j) + 1);
    const next = new Set(a.base);
    for (const r of range) {
      if (a.on) next.add(r);
      else next.delete(r);
    }
    // Extended from a plain click, the anchor now belongs to this hold: the next hold starts afresh.
    return { selected: next, anchor: { ...a, hold, plain: false } };
  }
  const next = new Set(state.selected);
  const on = !next.has(id);
  if (on) next.add(id);
  else next.delete(id);
  return { selected: next, anchor: { id, hold, plain: !mods.shiftKey, on, base: next } };
}
