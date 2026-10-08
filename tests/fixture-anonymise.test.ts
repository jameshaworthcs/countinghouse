// Making a synthetic fixture from a real import's document (scripts/fixture-anonymise.ts). The
// "real" values here are invented, and shapes that look personal are put together at run time.

import { describe, expect, it } from 'vitest';
import { anonymise, headerWords, type AnonymiseOptions } from '../scripts/fixture-anonymise/anonymise';

const postcode = ['YO10', '5DD'].join(' ');
const email = ['orla.penhallow', 'mail.co.uk'].join('@');
const sortCode = ['20', '31', '55'].join('-');
const account = '4123' + '4567';

const CSV = [
  'Date,Description,Amount,Balance',
  `03/09/2026,CARD PAYMENT TO MOORGATE FISHERY ${postcode},-12.34,"1,000.00"`,
  `05/09/2026,FASTER PAYMENT FROM TAMSIN KERRIDGE REF ${account} ${sortCode},250.00,"1,250.00"`,
  '17 September 2026,TESCO STORES 3297,-45.10,"1,204.90"',
  `2026-09-30,Statement sent to ${email},0.00,"1,204.90"`,
].join('\n');

const OFX = '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903120000[0:GMT]<TRNAMT>-12.34<FITID>9876543210<NAME>MOORGATE FISHERY</STMTTRN>';

const options = (extra: Partial<AnonymiseOptions> = {}): AnonymiseOptions => ({
  seed: 42,
  shiftDays: 70,
  scale: 1.5,
  keep: headerWords(CSV),
  generic: new Set(['card', 'payment', 'to', 'faster', 'from', 'ref', 'tesco', 'stores', 'statement', 'sent', 'debit']),
  dictionary: new Set(['fishery']),
  given: new Set(['tamsin']),
  ...extra,
});

describe('a fixture from a real document', () => {
  it('moves dates, scales amounts and replaces identifiers, keeping the shape of each', () => {
    const { text, counts } = anonymise(CSV, options());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Date,Description,Amount,Balance');
    // 70 days on: the same weekday, each date written as before.
    expect(lines[1]).toMatch(/^12\/11\/2026,/);
    expect(lines[3]).toMatch(/^26 November 2026,/);
    expect(lines[4]).toMatch(/^2026-12-09,/);
    // One factor for every amount, so a running balance still adds up.
    expect(lines[1]).toMatch(/,-18\.51,"1,500\.00"$/);
    expect(lines[2]).toMatch(/,375\.00,"1,875\.00"$/);
    expect(lines[3]).toMatch(/,-67\.65,"1,807\.35"$/);
    // Identifiers, an email and a postcode are replaced.
    expect(text).not.toContain(account);
    expect(text).not.toContain(sortCode);
    expect(text).not.toContain(postcode);
    expect(text).not.toContain(email);
    expect(text).toContain('person1@example.com');
    expect(counts).toMatchObject({ dates: 4, amounts: 8, emails: 1, postcodes: 1 });
  });

  it('swaps names and places for invented words, the same each time, and keeps public and common words', () => {
    const { text } = anonymise(CSV, options());
    expect(text).not.toMatch(/MOORGATE|KERRIDGE|TAMSIN/);
    expect(text).toMatch(/CARD PAYMENT TO [A-Z]+ FISHERY/);
    expect(text).toContain('TESCO STORES');
    const name = /TO ([A-Z]+) FISHERY/.exec(text)![1]!;
    expect(anonymise(`payment ${'Moorgate'}`, options()).text).toBe(`payment ${name[0]}${name.slice(1).toLowerCase()}`);
    // A denylisted word goes even when it is a common word.
    expect(anonymise('CARD PAYMENT', options({ deny: new Set(['card']) })).text).not.toContain('CARD');
    // The same seed gives the same fixture; another seed another.
    expect(anonymise(CSV, options()).text).toBe(text);
    expect(anonymise(CSV, options({ seed: 7 })).text).not.toBe(text);
  });

  it('leaves markup alone in an OFX file', () => {
    const { text } = anonymise(OFX, options({ keep: new Set() }));
    expect(text).toMatch(/^<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261112120000\[0:GMT\]<TRNAMT>-18\.51<FITID>\d{10}<NAME>[A-Z]+ FISHERY<\/STMTTRN>$/);
    expect(text).not.toContain('9876543210');
  });
});
