// People: money to and from a person rather than a business (docs/FORMULAS.md §10, "People").
//
// A payment is with a person when the bank words it as a payment between two people's accounts
// (`paymentParts` says `via: 'transfer'`, or the source names the other party of a transfer) and the
// name is shaped like a person's: a title, initials, a joint "R & C", or a common first name, with
// no word a business uses. You are not a person here, nor are your accounts; someone you saved
// (people.json) is, whatever their name looks like.
//
// What each payment was is yours to decide on the To categorise page: a gift, your share paid back,
// your own money, or anything else. `suggestFor` says what a payment's own words or amount point to,
// and why; nothing is categorised from it without you, and a person's usual treatment only fills in
// the choice (docs/DECISIONS.md, 2026-10-03).

import { addDays, formatDate } from './dates';
import { decodeEntities, matchMerchant, paymentParts } from './merchants';
import { formatMoney, toMinor } from './money';
import type { Person, PERSON_IN, PERSON_OUT, Transaction } from './schema';

/** Words a business's name carries and a person's doesn't. */
const ORGANISATION = new RegExp(
  `^(?:${[
    'ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'corp', 'co', 'company', 'group', 'holdings', 'trust', 'trustees', 'bank', 'society',
    'council', 'university', 'uni', 'college', 'school', 'academy', 'nhs', 'hmrc', 'dvla', 'gov', 'government', 'services', 'service',
    'solutions', 'systems', 'consulting', 'partners', 'associates', 'agency', 'international', 'global', 'uk', 'gb', 'europe', 'trading',
    'enterprises', 'ventures', 'capital', 'finance', 'financial', 'investments', 'invest', 'investor', 'insurance', 'assurance', 'pension',
    'pensions', 'mortgage', 'mortgages', 'loan', 'loans', 'credit', 'card', 'cards', 'pay', 'payment', 'payments', 'cash', 'money',
    'wallet', 'exchange', 'crypto', 'saver', 'savings', 'isa', 'account', 'pot', 'vault', 'energy', 'power', 'electric', 'water',
    'telecom', 'mobile', 'broadband', 'media', 'digital', 'tech', 'technology', 'technologies', 'software', 'labs', 'studio', 'studios',
    'design', 'print', 'properties', 'property', 'estates', 'estate', 'lettings', 'letting', 'homes', 'housing', 'rentals', 'construction',
    'builders', 'motors', 'motor', 'cars', 'garage', 'auto', 'taxis', 'travel', 'tours', 'airways', 'airlines', 'rail', 'railway',
    'coaches', 'transport', 'logistics', 'delivery', 'foods', 'food', 'wines', 'wine', 'brewery', 'bar', 'pub', 'cafe', 'coffee',
    'restaurant', 'bakery', 'takeaway', 'pizza', 'store', 'stores', 'shop', 'shops', 'supermarket', 'market', 'retail', 'outlet', 'outdoor',
    'outdoors', 'sports', 'sport', 'fitness', 'gym', 'club', 'leisure', 'centre', 'center', 'health', 'healthcare', 'medical', 'dental',
    'pharmacy', 'clinic', 'care', 'salon', 'beauty', 'events', 'tickets', 'productions', 'entertainment', 'games', 'foundation', 'charity',
    'church', 'association', 'federation', 'union', 'league', 'fund', 'rewards', 'cashback', 'interest', 'refund', 'sec', 'nv', 'bv', 'sa',
    'gmbh', 'ag', 'pty', 'cic',
  ].join('|')})$`,
  'i',
);

const TITLES = /^(?:mr|mrs|ms|miss|mx|dr|prof|sir|lady|rev|master)\.?$/i;

/**
 * Common given names, for telling "Hannah Whitlock" from "Copper Kettle" and "WHITLOCK HANNAH" from
 * "Hannah Whitlock" when no initial or title says. A name not on it is still a person once you save it.
 */
const FIRST_NAMES = new Set(
  (
    'aaron abbie abdul abigail adam adrian aidan aiden aisha alan albert albie alex alexander alexandra alfie alfred ali alice alicia ' +
    'alison alistair alasdair amanda amber amelia amir amit amy andrea andrew andy angela angus anil anita ann anna anne annie anthony ' +
    'archie aria arjun arlo arthur ashley aurora austin ava ayesha barbara barry beatrice bella ben benjamin bernard beth bethany betty ' +
    'beverley bilal bill billy bob bobby bonnie brandon brenda brendan brian bridget bruce caitlin callum cameron carl carla carly ' +
    'carol caroline carolyn catherine cerys charles charlie charlotte chelsea cheryl chloe chris christian christina christine ' +
    'christopher ciara cian ciaran claire clara clare clive colin connor conor craig daisy dale damian dan daniel danielle danny darren ' +
    'dave david dawn dean debbie deborah declan deepak denise dennis derek dermot diana diane dominic donna doris dorothy douglas duncan ' +
    'dylan eddie edith edward eileen elaine eleanor elena eli elijah elizabeth ella ellen ellie elliot elliott eloise elsie emily emma ' +
    'eoin eric erin esme ethan eugene euan eva eve evelyn evie ewan faisal farah fatima felix finlay finley fiona florence frances ' +
    'francesca francis frank frankie fraser freddie frederick freya gabriel gail gareth gary gavin gemma geoffrey george georgia ' +
    'georgina gerald gillian gina glen glenn gloria gordon grace graham grant greg gregory hamish hamza hannah harley harper harriet harry ' +
    'harvey hassan hayley hazel heather heidi helen henry hollie holly hugh hugo hunter hussain ian ibrahim idris imogen imran iris isaac ' +
    'isabel isabella isabelle isla ivy jack jackie jackson jacob jade jake james jamie jan jane janet janice jasmine jason jay jayden ' +
    'jean jeff jeffrey jemma jenna jennifer jenny jeremy jessica jill jim jimmy jo joan joanna joanne jodie joe joel john johnny jon ' +
    'jonathan jordan joseph josh joshua joy joyce jude judith judy julia julian julie justin kai karen kate katherine kathleen kathryn ' +
    'katie kayla keith kelly kenneth kerry kevin kieran kim kirsty kyle laura lauren layla leah lee leo leon lewis liam lily linda lindsay ' +
    'lisa lola lorraine louis louise lucas lucia lucy luis luke lydia lynn lynne mackenzie madison maisie malcolm mandy margaret maria ' +
    'mariam marie marion mark martha martin mary maryam mason matilda matt matthew maureen max maya megan melanie melissa mia michael ' +
    'michelle mike millie mohammad mohammed molly muhammad murray nadia nancy naomi natalie natasha nathan neil niall nicholas nicky ' +
    'nicola nicole nigel niamh noah noor nora norman oliver olivia omar oscar owen paige pamela patricia patrick paul paula pauline ' +
    'pawel penny peter philip phillip phoebe piotr pippa poppy priya rachel rahul raj ravi ray raymond rebecca reece reuben rhys ' +
    'richard rick ricky riley rob robert robin robyn roger rohan ronald ronnie rory rosa rose rosie ross roy ruby russell ruth ryan ' +
    'sadie sally sam samantha samuel sandra sara sarah scarlett scott sean seb sebastian shane shannon sharon shaun sheila shirley ' +
    'sian sienna simon sofia sonia sophia sophie stacey stanley stella stephanie stephen steve steven stewart stuart sue susan suzanne ' +
    'tanya tara taylor teresa terry theo theodore thomas tim timothy tina toby todd tom tommy tony tracey tracy trevor tyler valerie ' +
    'vanessa victoria vincent violet wayne wendy will william willow yasmin yusuf yvonne zac zach zachary zain zainab zara zoe'
  ).split(' '),
);

/** A person's name taken apart: the surname, the given names' initials, and the key its variants share. */
export interface PersonName {
  surname: string;
  /** The given names' initials, in order ("hcw" for "FENWICK H C W"). */
  initials: string;
  /** Two people paying from one account ("ASHBY R&C", "Sam Taylor & Alex Reed"). */
  joint: boolean;
  /**
   * What every way of writing the name shares: surname and first initial ("whitlock|h" for "Hannah
   * Whitlock", "H WHITLOCK" and "WHITLOCK H"); for a joint name, every first initial.
   */
  key: string;
  /**
   * The key the other way round, when both words are first names and nothing says which is the
   * surname ("TAYLOR SAM" may be Sam Taylor): the people you saved are found by either.
   */
  altKey?: string;
  /** For a joint name of two whole names, each of them. */
  members?: PersonName[];
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const isInitials = (token: string) => /^[A-Za-z]\.?$/.test(token) || (/^[A-Z]{2,3}$/.test(token) && !FIRST_NAMES.has(token.toLowerCase()));

/**
 * The parts of a name shaped like a person's, or undefined. `known`: you saved it as a person, so its
 * shape needn't show it ("Tamsin Kerridge" without a title).
 */
export function parsePersonName(raw: string, known = false): PersonName | undefined {
  const s = decodeEntities(raw)
    .replace(/[\u00a0\s]+/g, ' ')
    .replace(/[\s,.;:-]+$/, '')
    .trim();
  if (!s || s.length > 60 || /[0-9@/\\()*#|:;_+=$£%!?"]/.test(s)) return undefined;
  const joint = s.split(/\s*&\s*|\s+and\s+/i).filter(Boolean);
  if (joint.length === 2) {
    // Two whole names ("Sam Taylor & Alex Reed"), or one surname shared ("R & C ASHBY", "ASHBY RI&C").
    const [a, b] = joint.map((p) => parsePersonName(p, known)) as [PersonName | undefined, PersonName | undefined];
    if (a && b && a.surname && b.surname && a.initials && b.initials) {
      const members = [a, b].sort((x, y) => x.key.localeCompare(y.key));
      return { surname: members[0]!.surname, initials: members[0]!.initials, joint: true, key: members.map((m) => m.key).join('+'), members };
    }
    const tokens = s
      .replace(/\s*&\s*|\s+and\s+/gi, ' & ')
      .split(' ')
      .filter((t) => t !== '&' && !TITLES.test(t));
    if (tokens.some((t) => ORGANISATION.test(t))) return undefined;
    // The surname: the one word that isn't initials; of several, the one that isn't a first name
    // ("John & Jane Smith"); when all are, the last ("TAYLOR R&J" and "John & Jane Taylor" are the
    // Taylors, though Taylor is a first name too).
    const words = tokens.filter((t) => !isInitials(t));
    let long = words.length === 1 ? words : words.filter((t) => !FIRST_NAMES.has(t.toLowerCase()));
    if (!long.length && words.length) long = [words[words.length - 1]!];
    if (long.length !== 1) return undefined;
    const surname = letters(long[0]!);
    const firsts = tokens.filter((t) => t !== long[0]).map((t) => letters(t)[0]!).filter(Boolean);
    // "RI&C": the first of each run of initials, either side of the "&".
    const runs = s.replace(long[0]!, ' ').split(/\s*&\s*|\s+and\s+/i).map((p) => letters(p.split(' ').filter((t) => t && !TITLES.test(t)).join(' '))[0]).filter((x): x is string => Boolean(x));
    const initials = (runs.length ? runs : firsts).sort().join('&');
    return surname.length >= 2 ? { surname, initials: firsts.join(''), joint: true, key: `${surname}|${initials || '&'}` } : undefined;
  }
  if (joint.length > 2) return undefined;
  const all = s.split(' ');
  const titled = all.some((t) => TITLES.test(t));
  const tokens = all.filter((t) => !TITLES.test(t));
  if (!tokens.length || tokens.length > 4 || tokens.some((t) => !/^[A-Za-z][A-Za-z'’-]*\.?$/.test(t))) return undefined;
  if (tokens.some((t) => ORGANISATION.test(t.replace(/\.$/, '')))) return undefined;
  if (tokens.length === 1) {
    // "MRS TAYLOR": a surname with a title is someone; a single word alone ("Aqua") isn't.
    if (!(titled || known) || isInitials(tokens[0]!)) return undefined;
    const surname = letters(tokens[0]!);
    return surname.length >= 2 ? { surname, initials: '', joint: false, key: `${surname}|` } : undefined;
  }
  const initialAt = tokens.map(isInitials);
  if (initialAt.every(Boolean)) {
    // "COX SJ": all short, so the longest is the surname.
    const longest = tokens.reduce((best, t, i) => (t.replace(/\.$/, '').length > tokens[best]!.replace(/\.$/, '').length ? i : best), 0);
    if (tokens[longest]!.replace(/\.$/, '').length < 3) return undefined;
    initialAt[longest] = false;
  }
  const single = (t: string) => /^[A-Za-z]\.?$/.test(t);
  let surname: string;
  let given: string[];
  if (!initialAt[0] && initialAt.slice(1).every(Boolean) && (tokens.slice(1).every(single) || !FIRST_NAMES.has(letters(tokens[0]!)))) {
    // "FENWICK H C W", "ASHBY JW", "TAYLOR M": the surname first, as banks print a payer ("SAM COX"
    // is a first name and a surname).
    surname = tokens[0]!;
    given = tokens.slice(1);
  } else if (initialAt[0]) {
    // "H WHITLOCK", "H J WHITLOCK", "J Hartley-Moss".
    const at = initialAt.findIndex((x) => !x);
    if (at < 0) return undefined;
    surname = tokens[tokens.length - 1]!;
    given = tokens.slice(0, -1);
    if (at !== tokens.length - 1 && initialAt.slice(at).some(Boolean)) return undefined;
  } else if (FIRST_NAMES.has(letters(tokens[0]!))) {
    surname = tokens[tokens.length - 1]!;
    given = tokens.slice(0, -1);
    if (tokens.length === 2 && !titled && FIRST_NAMES.has(letters(surname))) {
      const parsed = finish(surname, given);
      return parsed ? { ...parsed, altKey: `${letters(tokens[0]!)}|${letters(surname)[0]}` } : undefined;
    }
  } else if (FIRST_NAMES.has(letters(tokens[tokens.length - 1]!))) {
    // "WHITLOCK HANNAH": the surname first.
    surname = tokens[0]!;
    given = tokens.slice(1);
  } else if (titled || known) {
    surname = tokens[tokens.length - 1]!;
    given = tokens.slice(0, -1);
  } else {
    return undefined;
  }
  return finish(surname, given);
}

/** The parts of a name from its surname and given names (or their initials). */
function finish(surname: string, given: string[]): PersonName | undefined {
  const last = letters(surname);
  if (last.length < 2) return undefined;
  const initials = given
    .flatMap((g) => (isInitials(g) ? letters(g).split('') : [letters(g)[0] ?? '']))
    .filter(Boolean)
    .join('');
  return { surname: last, initials, joint: false, key: `${last}|${initials[0] ?? ''}` };
}

/**
 * A name as a page shows it: one printed in capitals written as a name ("PRIYA SHAH" is "Priya
 * Shah"), its initials kept ("TAYLOR R&J" is "Taylor R&J"). Anything else as printed.
 */
export function tidyName(name: string): string {
  if (name !== name.toUpperCase() || !/[A-Z]/.test(name)) return name;
  return name
    .split(' ')
    .map((word) => (word.split('&').every((part) => !part || isInitials(part)) ? word : word.toLowerCase().replace(/(^|[-'’])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase())))
    .join(' ');
}

/**
 * Is it you? The same surname and first initial as the name in your profile, or a joint name you
 * are one of ("Sam Taylor & Alex Reed" is a joint account of yours when you are Sam Taylor).
 */
export function isOwnerName(name: PersonName, owner: PersonName | undefined): boolean {
  if (!owner) return false;
  if (name.members) return name.members.some((m) => m.key === owner.key);
  return name.key === owner.key;
}

/** How a bank's own type for a row words a payment between two people's accounts. */
const TRANSFER_TYPES = /^(?:faster ?payments?(?: (?:in|out|received|sent))?|fps|fpo|fpi|bacs|transfer|bank transfer|p2p payment|standing order|so|payments?|online payment|bill payment|mobile payment)$/i;

/** The fields of a payment that say who it was with. */
export type PartyInput = Pick<Transaction, 'description' | 'type' | 'counterpartyName' | 'reference' | 'seenIn' | 'counterpartyAccountId' | 'transferGroup'>;

/** The person a payment is with: their name as the payment gives it, the key its variants share, and the reference. */
export interface PersonParty {
  name: string;
  key: string;
  /** The payment's reference, when the bank gives one ("xmas", "Train"). */
  reference?: string;
  /** Someone you saved who goes by this name. */
  personId?: string;
}

/** Splits run-together words: "XmasGift2019" -> "xmas gift 2019", "3Bus faresMay23" -> "3 bus fares may 23". */
export function referenceWords(reference: string): string {
  return decodeEntities(reference)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)|(\d)([A-Za-z])/g, (_m, a: string, b: string, c: string, d: string) => (a ? `${a} ${b}` : `${c} ${d}`))
    .replace(/[^A-Za-z0-9&]+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Who your payments are with, when that's a person (see the top of this file): built once from your
 * name, your accounts and the people you saved.
 */
export class PeopleIndex {
  private readonly owner: PersonName | undefined;
  private readonly ownNames: Set<string>;
  private readonly byName = new Map<string, Person>();
  private readonly byKey = new Map<string, Person[]>();

  /**
   * `ownerName`: the name in your profile. `ownNames`: your accounts' names and aliases, and their
   * banks', which are never a person. `people`: those you saved.
   */
  constructor(opts: { ownerName?: string | undefined; ownNames?: readonly string[]; people?: readonly Person[] } = {}) {
    this.owner = opts.ownerName ? parsePersonName(opts.ownerName, true) : undefined;
    this.ownNames = new Set((opts.ownNames ?? []).map(letters).filter((n) => n.length >= 3));
    for (const p of opts.people ?? []) {
      for (const n of [p.name, ...p.names]) {
        this.byName.set(letters(n), p);
        const parsed = parsePersonName(n, true);
        for (const k of parsed ? [parsed.key, parsed.altKey] : []) {
          if (!k) continue;
          const list = this.byKey.get(k) ?? [];
          if (!list.includes(p)) this.byKey.set(k, [...list, p]);
        }
      }
    }
  }

  /** The person someone you saved goes by this name, or whose variants it shares (when only one does). */
  personFor(name: string): Person | undefined {
    const exact = this.byName.get(letters(name));
    if (exact) return exact;
    const parsed = parsePersonName(name, true);
    for (const k of parsed ? [parsed.key, parsed.altKey] : []) {
      const list = k ? this.byKey.get(k) : undefined;
      if (list?.length === 1) return list[0];
    }
    return undefined;
  }

  /** The key a name's variants share, when it is a person's and not yours. */
  keyOf(name: string): string | undefined {
    if (this.ownNames.has(letters(name))) return undefined;
    const saved = this.byName.get(letters(name));
    const parsed = parsePersonName(name, Boolean(saved));
    if (!parsed || isOwnerName(parsed, this.owner)) return undefined;
    if (!saved && !parsed.joint && !/^[A-Za-z]\.?\s/.test(name) && !/\s[A-Za-z]{1,3}$/.test(name.trim())) {
      // A whole name a brand also goes by ("Capital One") is the brand; an initial says it's someone ("J Morrison").
      const brand = matchMerchant(name, -1) ?? matchMerchant(name, 1);
      if (brand && letters(brand.payee).length >= 4 && letters(name).includes(letters(brand.payee))) return undefined;
    }
    return parsed.key;
  }

  /** Is this your own name, as your profile has it? */
  isOwner(name: string): boolean {
    const parsed = parsePersonName(name, true);
    return Boolean(parsed && isOwnerName(parsed, this.owner));
  }

  /** Your surname, from your profile. */
  get ownerSurname(): string | undefined {
    return this.owner?.surname;
  }

  /**
   * The person a payment is with, or undefined: one worded as a payment between two people's accounts
   * (in its description, or another document's), to or from a name shaped like a person's that isn't
   * yours. A transfer between your own accounts is never with a person.
   */
  party(t: PartyInput): PersonParty | undefined {
    if (t.transferGroup || t.counterpartyAccountId) return undefined;
    const texts = [t.description, ...(t.seenIn ?? []).map((s) => s.said?.description).filter((d): d is string => typeof d === 'string')];
    let candidate: { name: string; reference?: string } | undefined;
    for (const d of texts) {
      const parts = paymentParts(d);
      if (parts?.via === 'transfer') {
        candidate = { name: parts.name, ...(parts.reference ? { reference: parts.reference } : {}) };
        break;
      }
    }
    if (!candidate && t.counterpartyName && TRANSFER_TYPES.test((t.type ?? '').trim())) candidate = { name: t.counterpartyName };
    if (!candidate) return undefined;
    const key = this.keyOf(candidate.name);
    if (!key) return undefined;
    const reference = candidate.reference ?? t.reference;
    const person = this.personFor(candidate.name);
    return { name: candidate.name, key, ...(reference && reference.trim() ? { reference: reference.trim() } : {}), ...(person ? { personId: person.id } : {}) };
  }
}

// ─── What a payment with a person was ────────────────────────────────────────────────────────────

export type PersonIn = (typeof PERSON_IN)[number];
export type PersonOut = (typeof PERSON_OUT)[number];
/** Money in: a gift, your share paid back, or your own money. Money out: a gift, your share of something, or your own money. */
export type PersonTreatment = PersonIn | PersonOut;

/** Where each treatment puts a payment; `item` is the category of what was shared (trains, a holiday), when known. */
export function categoryFor(treatment: PersonTreatment, direction: 'in' | 'out', item?: string): string {
  if (treatment === 'own') return 'transfer';
  if (treatment === 'gift') return direction === 'in' ? 'gifts-received' : 'gifts';
  return item ?? (direction === 'in' ? 'repaid' : 'other-expense');
}

/** The treatment a category stands for on a payment with a person, as `categoryFor` would give it. */
export function treatmentOf(category: string | undefined, direction: 'in' | 'out', kindOf: (id: string) => string | undefined): PersonTreatment | undefined {
  if (!category) return undefined;
  if (category === 'gifts-received' || category === 'gifts') return 'gift';
  if (category === 'repaid') return 'repaid';
  const kind = kindOf(category);
  if (kind === 'transfer') return 'own';
  if (kind === 'expense') return direction === 'in' ? 'repaid' : 'shared';
  return undefined;
}

/**
 * A reference that says the money is a gift: an occasion or pocket money, or love and kisses (quoted
 * second, as an occasion says more). Who it's from ("FROM AUNTIE") says nothing of what it is: most
 * money from family is a gift, not all of it.
 */
const GIFT_OCCASION = /\b(?:xmas|chrimbo|bday|gift|gifts|present|presents|pressie|pocket|congrats?|well done|good luck|success|easter|graduation|celebrate)\b|christmas|birthday|birthd|bithd|congrat|pocketmoney|graduat|welldone|goodluck/;
const GIFT_AFFECTION = /\b(?:x{2,}|treat|love|happy)\b/;
/** A reference that says it squares up something one of you paid ("Train back" is a train, not this). */
const REPAY_WORDS = /\b(?:pay back|paying back|paid back|money back|repay|repaid|owe|owed|owing|iou|share|half|halves|split|my bit|your bit|expense|expenses|refund|reimburse|reimbursement)\b|expenses|refund|reimburs|payingback|payback/;
/** A reference that says it's a loan: neither a gift nor a share, so it's yours to say. */
const LOAN_WORDS = /\b(?:loan|lend|lent|borrow|borrowed)\b/;
/** A reference that says the money is yours, moving. */
const OWN_WORDS = /\b(?:top up|topup|top-up|own account|my account|savings|save|isa)\b|topup/;

/** What the money was for, from a reference's words: the category of what was shared. */
const ITEM_WORDS: [RegExp, string][] = [
  [/\b(?:trains?|rail|railcard|lner|avanti|trainline)\b|trainfare/, 'trains'],
  [/\b(?:travel ?card|tfl|tube|oyster|bus|buses|tram|metro)\b|travelcard/, 'public-transport'],
  [/\b(?:uber|taxi|taxis|cab|cabs|lyft|bolt)\b/, 'taxis'],
  [/\b(?:flights?|plane|easyjet|ryanair|jet2|airport)\b/, 'flights'],
  [/\b(?:hotel|airbnb|hostel|accommodation|apartment|cottage|lodge)\b/, 'accommodation'],
  [/\b(?:holiday|hols?|trip|getaway|vacation)\b/, 'holidays'],
  [/\b(?:takeaway|deliveroo|just ?eat)\b/, 'takeaway'],
  [/\b(?:dinner|dinners|lunch|breakfast|brunch|meal|food|nandos|pizza|curry|restaurant|chips)\b/, 'eating-out'],
  [/\b(?:drinks?|pints?|beers?|wine|cocktails?|pub|bar)\b/, 'pubs-bars'],
  [/\b(?:coffee|coffees)\b/, 'coffee'],
  [/\b(?:tickets?|gig|concert|festival|theatre|show)\b/, 'events'],
  [/\b(?:cinema|film|movie|movies)\b/, 'cinema'],
  [/\b(?:petrol|fuel|diesel)\b/, 'fuel'],
  [/\bparking\b/, 'parking'],
  [/\b(?:groceries|grocery|food shop|shopping|supermarket|tesco|asda|aldi|lidl|sainsburys?)\b/, 'groceries'],
  [/\brent\b/, 'rent'],
  [/\b(?:bills?|electric|electricity|gas|energy)\b/, 'energy'],
  [/\b(?:wifi|broadband|internet)\b/, 'broadband'],
  [/phone|mobile/, 'mobile'],
  [/sport|\b(?:gym|bowl|bowling|climbing|golf|football|tennis|squash|swim|swimming)\b/, 'gym'],
  [/\b(?:haircut|hair)\b/, 'hair-beauty'],
  [/\b(?:books?)\b/, 'books'],
  [/\b(?:clothes|clothing|shoes|jacket|dress)\b/, 'clothing'],
  [/\b(?:hoover|furniture|ikea)\b/, 'home-garden'],
];

/** The words in a reference that matched, for the reason: "the reference says “xmas”". */
function said(words: string, re: RegExp): string | undefined {
  return re.exec(words)?.[0];
}

/** The category of what a reference says was shared, when its words (or a brand in it) say; `known` says which categories can be. */
export function itemCategory(reference: string | undefined, known: (id: string) => boolean): { category: string; word: string } | undefined {
  if (!reference) return undefined;
  const words = referenceWords(reference);
  for (const [re, category] of ITEM_WORDS) {
    const word = said(words, re);
    if (word && known(category)) return { category, word };
  }
  const brand = matchMerchant(reference, -1);
  if (brand && known(brand.category)) return { category: brand.category, word: brand.payee };
  return undefined;
}

/** A payment you made that money in may be someone's share of. */
export interface PaidOut {
  id: string;
  date: string;
  amount: number;
  payee: string;
  category?: string | undefined;
}

/** How long after you paid for something a share of it paid back is taken for one. */
export const SHARE_DAYS = 90;
const SHARES: [n: number, label: string][] = [
  [2, 'half'],
  [3, 'a third'],
  [4, 'a quarter'],
  [1, 'all'],
];

/**
 * The payment money in is a share of: half, a third, a quarter or all of a payment you made in the
 * `SHARE_DAYS` before, to the penny (within a penny a part for a split that doesn't divide evenly).
 * The smallest split wins, then the latest payment. Money in under £5 is nobody's share, and "all" of
 * a payment needs £20 or more, not in round pounds. `paid`: your spending payments, any order.
 */
export function shareOf(amount: number, date: string, paid: readonly PaidOut[]): { payment: PaidOut; n: number; label: string } | undefined {
  const m = toMinor(amount);
  if (m < 500) return undefined;
  const from = addDays(date, -SHARE_DAYS);
  const near = paid.filter((p) => p.amount < 0 && p.date <= date && p.date >= from).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  for (const [n, label] of SHARES) {
    if (n === 1 && (m < 2000 || m % 100 === 0)) continue;
    const hit = near.find((p) => Math.abs(-toMinor(p.amount) - m * n) <= n - 1);
    if (hit) return { payment: hit, n, label };
  }
  return undefined;
}

/** A suggestion for a payment with a person, and why. */
export interface PersonSuggestion {
  treatment: PersonTreatment;
  category: string;
  /** In words: "the reference says “xmas”", "half of £236.50 to Example Air on 27 May 2026". */
  reason: string;
  /**
   * The payment says so itself (its reference, or an amount that's a share of one you made, not in
   * round pounds): ticked on the page for you to confirm. Otherwise the choice is only filled in.
   */
  strong: boolean;
}

/** What you decided before about money with this person, by direction: how many of each category. */
export type PersonHistory = Map<string, number>;

/**
 * What a payment with a person looks like it was (top of this file). For money in:
 * 0. a loan: nothing (yours to say);
 * 1. words that square something up: your share paid back, in what was shared when it says (a
 *    share of a present is paid back in gifts);
 * 2. gift words in the reference: a gift;
 * 3. a share of a payment you made: paid back, in that payment's category (one in round pounds
 *    only when the reference doesn't say what was shared);
 * 4. words for your own money: yours moving;
 * 5. what the person usually is, as you said;
 * 6. what you decided for most of their payments before (3 or more, at least 70%);
 * 7. what was shared, from the reference's words alone: paid back;
 * 8. the category it has now from the reader, the bank or the built-in list;
 * 9. your surname: a gift, as most money from family is.
 * Money out goes the same way, a gift or your share of something, without 3 and 9.
 * Only 1–3 come from the payment itself (`strong`).
 */
export function suggestFor(
  t: Pick<Transaction, 'amount' | 'date' | 'category' | 'categorisedBy'>,
  party: PersonParty,
  ctx: {
    known: (id: string) => boolean;
    kindOf: (id: string) => string | undefined;
    person?: Person | undefined;
    personName: string;
    history?: PersonHistory | undefined;
    paid?: readonly PaidOut[] | undefined;
    ownerSurname?: string | undefined;
  },
): PersonSuggestion | undefined {
  const dir = t.amount >= 0 ? 'in' : 'out';
  const words = party.reference ? referenceWords(party.reference) : '';
  const item = itemCategory(party.reference, (id) => ctx.known(id) && ctx.kindOf(id) === 'expense');
  const make = (treatment: PersonTreatment, reason: string, strong: boolean, itemCat?: string): PersonSuggestion | undefined => {
    const category = categoryFor(treatment, dir, itemCat);
    return ctx.known(category) ? { treatment, category, reason, strong } : undefined;
  };
  const quote = (w: string) => `the reference says “${w}”`;
  if (LOAN_WORDS.test(words)) return undefined;
  const repay = said(words, REPAY_WORDS);
  // "Half of mum's present": a share of a gift, paid back in gifts.
  const gift = said(words, GIFT_OCCASION) ?? said(words, GIFT_AFFECTION);
  const sharedGift = gift && ctx.known('gifts') ? 'gifts' : undefined;
  if (repay) return make(dir === 'in' ? 'repaid' : 'shared', item ? `${quote(repay)} and “${item.word}”` : quote(repay), true, item?.category ?? sharedGift);
  if (gift) return make('gift', quote(gift), true);
  if (dir === 'in' && ctx.paid) {
    const share = shareOf(t.amount, t.date, ctx.paid);
    // A share in round pounds is only perhaps one: what the reference says was shared comes first.
    if (share && (toMinor(t.amount) % 100 !== 0 || !item)) {
      const cat = share.payment.category && ctx.kindOf(share.payment.category) === 'expense' ? share.payment.category : item?.category;
      const reason = `${share.label} of ${formatMoney(-share.payment.amount)} to ${share.payment.payee} on ${formatDate(share.payment.date)}`;
      return make('repaid', reason, toMinor(t.amount) % 100 !== 0, cat);
    }
  }
  const own = said(words, OWN_WORDS);
  if (own) return make('own', quote(own), false);
  const usual = dir === 'in' ? ctx.person?.usually.in : ctx.person?.usually.out;
  if (usual) return make(usual, `you said money ${dir === 'in' ? 'from' : 'to'} ${ctx.personName} is usually ${usualWords(usual, dir)}`, false, usual === 'repaid' || usual === 'shared' ? item?.category : undefined);
  if (ctx.history?.size) {
    const total = [...ctx.history.values()].reduce((s, n) => s + n, 0);
    const [top, n] = [...ctx.history.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const treatment = treatmentOf(top, dir, ctx.kindOf);
    if (total >= 3 && n / total >= 0.7 && treatment) {
      return { treatment, category: top, reason: `you chose this for ${n} of ${total} earlier payments ${dir === 'in' ? 'from' : 'to'} ${ctx.personName}`, strong: false };
    }
  }
  if (item) return make(dir === 'in' ? 'repaid' : 'shared', quote(item.word), false, item.category);
  if (t.category && t.categorisedBy !== 'user') {
    const treatment = treatmentOf(t.category, dir, ctx.kindOf);
    const by = t.categorisedBy === 'ai' ? 'as the reader took it' : t.categorisedBy === 'bank' ? 'as the bank has it' : 'from the built-in list';
    if (treatment && ctx.known(t.category)) return { treatment, category: t.category, reason: by, strong: false };
  }
  const surname = party.key.split('|')[0];
  if (dir === 'in' && ctx.ownerSurname && surname === ctx.ownerSurname) return make('gift', 'family (your surname): most money from family is a gift, but check', false);
  return undefined;
}

function usualWords(treatment: PersonTreatment, dir: 'in' | 'out'): string {
  if (treatment === 'gift') return 'a gift';
  if (treatment === 'own') return 'your own money';
  return dir === 'in' ? 'paying you back' : 'your share of something';
}
