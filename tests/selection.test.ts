// Choosing rows with Shift and Ctrl/⌘ (src/web/lib/selection.ts), and what you add to transactions
// yourself (src/shared/annotations.ts).

import { describe, expect, it } from 'vitest';
import { addTags, appendNote, removeTags } from '../src/shared/annotations';
import { nextSelection, type Modifiers, type SelectionState } from '../src/web/lib/selection';

const ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const plain: Modifiers = { shiftKey: false };
const shift: Modifiers = { shiftKey: true };
const ctrl: Modifiers = { shiftKey: false, ctrlKey: true };

/** Clicks in turn: `[id, modifiers, hold]`, the hold being the presses of Shift so far. */
function run(clicks: [string, Modifiers, number][], start: SelectionState = { selected: new Set() }): string[] {
  let s = start;
  for (const [id, mods, hold] of clicks) s = nextSelection(s, ROWS, id, mods, hold);
  return [...s.selected].sort();
}

describe('choosing rows', () => {
  it('ticks and unticks one row with a click or Ctrl-click', () => {
    expect(run([['b', plain, 0]])).toEqual(['b']);
    expect(run([['b', plain, 0], ['d', ctrl, 0]])).toEqual(['b', 'd']);
    expect(run([['b', plain, 0], ['b', ctrl, 0]])).toEqual([]);
  });

  it('extends from the last plain click with Shift, as everywhere', () => {
    expect(run([['b', plain, 0], ['e', shift, 1]])).toEqual(['b', 'c', 'd', 'e']);
    // Upwards too.
    expect(run([['e', plain, 0], ['c', shift, 1]])).toEqual(['c', 'd', 'e']);
  });

  it('moves the end of the range within one hold of Shift, rather than piling ranges up', () => {
    expect(run([['b', plain, 0], ['f', shift, 1], ['d', shift, 1]])).toEqual(['b', 'c', 'd']);
  });

  it('starts a group of its own with each new hold of Shift, leaving the gap between groups', () => {
    // Hold Shift: b then d. Let go. Hold again: f then h.
    expect(
      run([
        ['b', shift, 1],
        ['d', shift, 1],
        ['f', shift, 2],
        ['h', shift, 2],
      ]),
    ).toEqual(['b', 'c', 'd', 'f', 'g', 'h']);
  });

  it('does not reach back to a plain click once a hold has extended from it', () => {
    expect(
      run([
        ['a', plain, 0],
        ['b', shift, 1],
        ['e', shift, 2],
        ['f', shift, 2],
      ]),
    ).toEqual(['a', 'b', 'e', 'f']);
  });

  it('keeps what was ticked before the range', () => {
    expect(run([['h', plain, 0], ['b', plain, 0], ['d', shift, 1]])).toEqual(['b', 'c', 'd', 'h']);
  });

  it('unticks a range from an unticked anchor', () => {
    const all: SelectionState = { selected: new Set(ROWS) };
    expect(run([['c', plain, 0], ['f', shift, 1]], all)).toEqual(['a', 'b', 'g', 'h']);
  });

  it('starts afresh when the anchor has left the list', () => {
    const s = nextSelection({ selected: new Set() }, ROWS, 'b', plain, 0);
    expect([...nextSelection(s, ['x', 'y', 'z'], 'z', shift, 1).selected]).toEqual(['b', 'z']);
  });
});

describe('tags and notes', () => {
  it('adds a tag once, keeping the spelling already there', () => {
    expect(addTags(['Holiday'], ['holiday', ' gift-aid ', ''])).toEqual(['Holiday', 'gift-aid']);
    expect(addTags(undefined, ['a  b'])).toEqual(['a b']);
    expect(removeTags(['Holiday', 'gift-aid'], ['HOLIDAY'])).toEqual(['gift-aid']);
  });

  it('adds a note on a line of its own, and not twice', () => {
    expect(appendNote(undefined, ' Paid back ')).toBe('Paid back');
    expect(appendNote('Dinner', 'Paid back')).toBe('Dinner\nPaid back');
    expect(appendNote('Dinner\nPaid back', 'Paid back')).toBe('Dinner\nPaid back');
    expect(appendNote('Dinner', '  ')).toBe('Dinner');
  });
});
