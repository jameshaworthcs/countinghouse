// What you add to a transaction yourself: tags and notes (docs/DATA_FORMAT.md, "Transactions").
//
// - Tags are short labels for grouping and filtering ("holiday-2026", "gift-aid"). The list filters
//   by them, and some carry meaning (Self Assessment reads "gift-aid").
// - Notes are free text for you. Search finds them; nothing else reads them.

/** A tag as kept: trimmed, spaces collapsed, at most 40 characters. Empty when nothing is left. */
export function cleanTag(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Tags with more added, each once (ignoring case: the one already there keeps its spelling). */
export function addTags(existing: readonly string[] | undefined, add: readonly string[]): string[] {
  const out = [...(existing ?? [])];
  for (const raw of add) {
    const tag = cleanTag(raw);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** Tags without those named (ignoring case). */
export function removeTags(existing: readonly string[] | undefined, remove: readonly string[]): string[] {
  const gone = new Set(remove.map((t) => cleanTag(t).toLowerCase()));
  return (existing ?? []).filter((t) => !gone.has(t.toLowerCase()));
}

/**
 * A note added to the notes already there, on a line of its own. A note they already hold, as a
 * line of its own, is not added twice. Empty when there is nothing either way.
 */
export function appendNote(existing: string | undefined, add: string): string {
  const note = add.trim();
  const now = (existing ?? '').trim();
  if (!note) return now;
  if (!now) return note;
  if (now.split('\n').some((line) => line.trim() === note)) return now;
  return `${now}\n${note}`;
}
