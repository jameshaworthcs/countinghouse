// The leak guard's built-in patterns: shapes of personal data that need no data directory to find,
// so CI can run them too. Documented examples (HMRC's, the card networks' test numbers, the IBAN
// registry's) are allowed, so tests and docs can use them.

export interface PatternHit {
  rule: string;
  index: number;
  value: string;
}

/** HMRC's documented NI number, and the forms of it docs use. */
const NI_EXAMPLES = new Set(['QQ123456C', 'QQ123456A', 'AB123456C', 'AA123456A']);
/** Prefixes HMRC never issues (and so never a real number). */
const NI_INVALID_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

/** Test card numbers published by card networks and payment processors. */
const CARD_EXAMPLES = new Set([
  '4111111111111111',
  '4242424242424242',
  '4012888888881881',
  '4000056655665556',
  '4000000000000002',
  '5555555555554444',
  '5105105105105100',
  '2223003122003222',
  '378282246310005',
  '371449635398431',
  '6011111111111117',
  '3530111333300000',
]);

/** IBANs from the IBAN registry and banks' own documentation. */
const IBAN_EXAMPLES = new Set(['GB82WEST12345698765432', 'GB29NWBK60161331926819', 'GB33BUKB20201555555555', 'DE89370400440532013000']);

/** Sort codes and account numbers that are plainly placeholders. */
const SORT_CODE_EXAMPLES = new Set(['000000', '123456', '112233', '010203', '999999']);
const ACCOUNT_EXAMPLES = new Set(['00000000', '12345678', '87654321', '11111111', '01234567']);

/** Tax office numbers docs use for made-up employer PAYE references (HMRC's own example is 123/AB456). */
const PAYE_EXAMPLE_OFFICES = new Set(['000', '123']);

/** Tailscale's own fixed addresses, documented publicly. */
const CGNAT_EXAMPLES = new Set(['100.100.100.100', '100.64.0.0', '100.64.0.1']);

/** Email domains kept for examples (RFC 2606 and 6761) and GitHub's no-reply addresses. */
function allowedEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    /(^|\.)example\.(com|org|net)$/.test(d) ||
    /\.(test|invalid|example|localhost)$/.test(d) ||
    d === 'example' ||
    d === 'localhost' ||
    d === 'users.noreply.github.com'
  );
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function ibanValid(iban: string): boolean {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Timestamps look like card numbers to Luhn: epoch milli- or microseconds, or YYYYMMDDHHMMSS (OFX). */
function timestampLike(digits: string): boolean {
  const n = Number(digits);
  return (
    (digits.length === 13 && n >= 946_684_800_000 && n < 4_102_444_800_000) ||
    (digits.length === 16 && n >= 946_684_800_000_000 && n < 4_102_444_800_000_000) ||
    /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])[0-5]\d[0-5]\d(\d{3})?$/.test(digits)
  );
}

const NI = /(?<![\p{L}\p{N}])([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z])\s?(\d{2})\s?(\d{2})\s?(\d{2})\s?([A-D])(?![\p{L}\p{N}])/giu;
const CARD = /(?<![\p{N}.])\d(?:[ -]?\d){12,18}(?![\p{N}]|\.\d)/gu;
const IBAN = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![\p{L}\p{N}])/gu;
const SORT_ACCOUNT = /(?<![\p{N}-])(\d{2})([- ])(\d{2})\2(\d{2})(?![\p{N}])[^\n]{0,20}?(?<![\p{N}])(\d{8})(?![\p{N}])/gu;
const EMAIL = /(?<![\p{L}\p{N}._%+-])[a-z0-9][a-z0-9._%+-]*@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![\p{L}\p{N}-])/giu;
const CGNAT = /(?<![\p{N}.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})(?![\p{N}]|\.\d)/gu;
/** A Tailscale address has groups after the prefix; the prefix alone, or as a range (`::/48`), is documentation. */
const TAILSCALE_V6 = /(?<![\p{L}\p{N}:])fd7a:115c:a1e0(?::[0-9a-f]{0,4}){0,4}:[0-9a-f]{1,4}(?![\p{L}\p{N}:/])/giu;
const POSTCODE = /(?<![\p{L}\p{N}])(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})(?![\p{L}\p{N}])/gu;
const PAYE = /(?<![\p{L}\p{N}/])(\d{3}) ?\/ ?([A-Z][A-Z0-9]{2,9})(?![\p{L}\p{N}/])/gu;

/** Every built-in pattern that matches the text (as written, not normalised). */
export function scanPatterns(text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const m of text.matchAll(NI)) {
    const prefix = m[1]!.toUpperCase();
    const compact = m[0].replace(/\s/g, '').toUpperCase();
    if (NI_INVALID_PREFIXES.has(prefix) || NI_EXAMPLES.has(compact)) continue;
    hits.push({ rule: 'ni-number', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
    if (CARD_EXAMPLES.has(digits) || /^(\d)\1+$/.test(digits) || timestampLike(digits)) continue;
    hits.push({ rule: 'card-number', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(IBAN)) {
    const iban = m[0].replace(/ /g, '');
    if (iban.length < 15 || iban.length > 34 || IBAN_EXAMPLES.has(iban) || !ibanValid(iban)) continue;
    hits.push({ rule: 'iban', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(SORT_ACCOUNT)) {
    const sortCode = m[1]! + m[3]! + m[4]!;
    if (SORT_CODE_EXAMPLES.has(sortCode) || ACCOUNT_EXAMPLES.has(m[5]!)) continue;
    hits.push({ rule: 'sort-code-account', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(EMAIL)) {
    if (allowedEmailDomain(m[1]!)) continue;
    hits.push({ rule: 'email', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(CGNAT)) {
    if (Number(m[2]) > 255 || Number(m[3]) > 255 || CGNAT_EXAMPLES.has(m[0])) continue;
    hits.push({ rule: 'tailnet-address', index: m.index, value: m[0] });
  }
  for (const m of text.matchAll(TAILSCALE_V6)) hits.push({ rule: 'tailnet-address', index: m.index, value: m[0] });
  for (const m of text.matchAll(POSTCODE)) hits.push({ rule: 'postcode', index: m.index, value: m[0] });
  for (const m of text.matchAll(PAYE)) {
    if (!/\d/.test(m[2]!) || PAYE_EXAMPLE_OFFICES.has(m[1]!)) continue;
    hits.push({ rule: 'paye-reference', index: m.index, value: m[0] });
  }
  return hits;
}

// ─── Files ─────────────────────────────────────────────────────────────────────────────────────

/** Documents, scans, screenshots and exports: what statements arrive as. */
const DOCUMENT_TYPES = /\.(pdf|heic|heif|jpe?g|png|webp|gif|tiff?|bmp|xlsx|xlsm|xls|ods|numbers|csv|tsv|ofx|qfx|qif|docx?)$/i;
/** Where synthetic documents are kept on purpose. */
const DOCUMENT_DIRS = ['tests/fixtures/', 'eval/', 'docs/images/', 'src/web/public/'];
const IMAGE_TYPES = /\.(jpe?g|png|heic|heif|tiff?|webp)$/i;
export const LARGE_FILE = 1024 * 1024;

export interface FileRuleHit {
  rule: string;
  message: string;
  /** A warning is reported but does not fail the scan. */
  warning?: boolean;
}

/** Rules for a file that is new (or every file, for a tree or history scan). */
export async function fileRules(filePath: string, bytes: Uint8Array): Promise<FileRuleHit[]> {
  const hits: FileRuleHit[] = [];
  if (DOCUMENT_TYPES.test(filePath) && !DOCUMENT_DIRS.some((d) => filePath.startsWith(d))) {
    hits.push({ rule: 'document-file', message: `a ${filePath.split('.').pop()} file outside ${DOCUMENT_DIRS.join(', ')}` });
  }
  if (IMAGE_TYPES.test(filePath)) {
    const meta = await imageMetadata(bytes);
    if (meta) hits.push({ rule: meta, message: meta === 'image-gps' ? 'an image with GPS metadata' : 'an image with camera (EXIF) metadata' });
  }
  if (bytes.length > LARGE_FILE) hits.push({ rule: 'large-file', message: `${(bytes.length / LARGE_FILE).toFixed(1)} MB`, warning: true });
  return hits;
}

async function imageMetadata(bytes: Uint8Array): Promise<'image-gps' | 'image-exif' | undefined> {
  try {
    const exifr = (await import('exifr')).default;
    const tags = (await exifr.parse(Buffer.from(bytes), { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false })) as Record<string, unknown> | undefined;
    if (!tags) return undefined;
    if ('latitude' in tags || 'GPSLatitude' in tags || 'GPSLongitude' in tags) return 'image-gps';
    if (['Make', 'Model', 'DateTimeOriginal', 'SerialNumber', 'LensModel'].some((k) => k in tags)) return 'image-exif';
  } catch {
    // Not an image exifr can read: nothing to report.
  }
  return undefined;
}
