// Choosing rows with Shift and Ctrl/⌘ in React: the rules are in ./selection.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nextSelection, type Modifiers, type SelectionState } from './selection';

/**
 * The holds of Shift so far, counted from key presses (each press, not its repeats, starts one), for
 * `nextSelection`: call it with a click's modifiers to get that click's hold.
 */
export function useShiftHold(): (mods: Modifiers) => number {
  const hold = useRef(0);
  const down = useRef(false);
  useEffect(() => {
    const press = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !e.repeat && !down.current) {
        down.current = true;
        hold.current++;
      }
    };
    const release = (e: KeyboardEvent) => {
      if (e.key === 'Shift') down.current = false;
    };
    // Shift let go in another window never comes back as a keyup here.
    const blur = () => (down.current = false);
    window.addEventListener('keydown', press);
    window.addEventListener('keyup', release);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', press);
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return useCallback((mods: Modifiers) => {
    // A Shift-click with no keydown seen (Shift held since before the page had focus) is a hold of its own.
    if (mods.shiftKey && !down.current) {
      down.current = true;
      hold.current++;
    }
    return hold.current;
  }, []);
}

/** Rows chosen from `order` (the rows on screen, in order), with Shift and Ctrl/⌘ (see above). */
export function useRowSelection(order: readonly string[]) {
  const [state, setState] = useState<SelectionState>({ selected: new Set() });
  const holdOf = useShiftHold();
  const orderRef = useRef(order);
  orderRef.current = order;

  const click = useCallback(
    (id: string, mods: Modifiers) => {
      const hold = holdOf(mods);
      setState((s) => nextSelection(s, orderRef.current, id, mods, hold));
    },
    [holdOf],
  );
  const set = useCallback((ids: Iterable<string>) => setState({ selected: new Set(ids) }), []);
  const clear = useCallback(() => setState({ selected: new Set() }), []);
  // Rows that left the list (an edit took them out of its filter) are no longer chosen.
  const selected = useMemo(() => {
    const shown = new Set(order);
    return [...state.selected].every((id) => shown.has(id)) ? state.selected : new Set([...state.selected].filter((id) => shown.has(id)));
  }, [state.selected, order]);
  return { selected, click, set, clear };
}
