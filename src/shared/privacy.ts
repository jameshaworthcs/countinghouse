// Personal identifiers the data keeps out (CLAUDE.md, "Privacy"). National Insurance numbers are
// printed on payslips, P60s and pension statements, and a reader can copy one into a field meant for
// something else (a pension statement's "Reference" read as the payer's reference). The documents
// themselves keep it, and so do bank descriptions, which are source facts; nothing the app derives
// does.

/**
 * Anything shaped like a National Insurance number, with or without the usual spaces: two letters,
 * six digits, and A to D ("QQ 12 34 56 C" is HMRC's own example). HMRC's rules for the letters are
 * not checked: keeping a number out matters more than telling a real one from an example.
 */
const NI_NUMBER = /\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g;

/** Is the whole of `text` a National Insurance number? */
export function isNiNumber(text: string | undefined): boolean {
  return Boolean(text && new RegExp(`^\\s*(?:${NI_NUMBER.source})\\s*$`).test(text.toUpperCase()));
}

/** Does `text` have a National Insurance number anywhere in it? */
export function hasNiNumber(text: string): boolean {
  return new RegExp(NI_NUMBER.source, 'i').test(text);
}

/** `text` with any National Insurance number in it replaced by "[NI number]". */
export function withoutNiNumbers(text: string): string {
  return text.replace(new RegExp(NI_NUMBER.source, 'gi'), (m) => (isNiNumber(m) ? '[NI number]' : m));
}
