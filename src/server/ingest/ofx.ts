// OFX / QFX (1.x SGML and 2.x XML) bank and credit-card statements.

import { parseFlexibleDate } from '../../shared/dates';
import { parseAmount } from '../../shared/money';
import { ExtractionSchema, type ExtractedAccount, type ExtractedTransaction, type Extraction } from '../../shared/schema';

export const OFX_ENGINE_VERSION = 'ofx-2';

interface Node {
  name: string;
  value?: string;
  children: Node[];
}

/** Tolerant OFX tree parser: handles unclosed SGML leaf tags and XML alike. */
export function parseOfxTree(text: string): Node {
  const body = text.slice(Math.max(0, text.search(/<OFX>/i)));
  const root: Node = { name: 'ROOT', children: [] };
  const stack: Node[] = [root];
  const re = /<(\/?)([A-Za-z0-9._]+)[^>]*>([^<]*)/g;
  let m: RegExpExecArray | null;
  let lastLeaf: Node | null = null;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/';
    const name = m[2]!.toUpperCase();
    const text = decodeEntities(m[3]!.trim());
    const top = stack[stack.length - 1]!;
    if (closing) {
      if (lastLeaf && lastLeaf.name === name) {
        lastLeaf = null;
        continue;
      }
      const idx = stack.map((n) => n.name).lastIndexOf(name);
      if (idx > 0) stack.length = idx;
      lastLeaf = null;
      continue;
    }
    if (text !== '') {
      const leaf: Node = { name, value: text, children: [] };
      top.children.push(leaf);
      lastLeaf = leaf;
    } else {
      const agg: Node = { name, children: [] };
      top.children.push(agg);
      stack.push(agg);
      lastLeaf = null;
    }
  }
  return root;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function find(node: Node, name: string): Node | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return undefined;
}

function findAll(node: Node, name: string, out: Node[] = []): Node[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

function val(node: Node | undefined, name: string): string | undefined {
  if (!node) return undefined;
  return find(node, name)?.value;
}

function leaves(node: Node, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const c of node.children) {
    const key = prefix ? `${prefix}.${c.name}` : c.name;
    if (c.value !== undefined) out[key] = c.value;
    else leaves(c, key, out);
  }
  return out;
}

function joinDesc(a?: string, b?: string): string {
  const x = a?.trim() ?? '';
  const y = b?.trim() ?? '';
  if (!x) return y;
  if (!y || x.toLowerCase().includes(y.toLowerCase())) return x;
  if (y.toLowerCase().includes(x.toLowerCase())) return y;
  return `${x} · ${y}`;
}

export function parseOfx(text: string): Extraction {
  const tree = parseOfxTree(text);
  const org = val(tree, 'ORG') ?? null;
  const statements = [...findAll(tree, 'STMTRS'), ...findAll(tree, 'CCSTMTRS')];
  const accounts: ExtractedAccount[] = [];
  const notes: string[] = [];
  for (const st of statements) {
    const isCard = st.name === 'CCSTMTRS';
    const acct = find(st, isCard ? 'CCACCTFROM' : 'BANKACCTFROM');
    const acctId = val(acct, 'ACCTID') ?? '';
    const acctType = val(acct, 'ACCTTYPE')?.toUpperCase();
    const currency = (val(st, 'CURDEF') ?? 'GBP').toUpperCase();
    const list = find(st, 'BANKTRANLIST');
    const txs: ExtractedTransaction[] = [];
    findAll(list ?? st, 'STMTTRN').forEach((t, i) => {
      const date = parseFlexibleDate(val(t, 'DTPOSTED') ?? val(t, 'DTUSER'), 'YMD');
      const amount = parseAmount(val(t, 'TRNAMT'));
      if (!date || amount === null) {
        notes.push(`Transaction ${i + 1} has no readable date or amount; skipped`);
        return;
      }
      const name = val(t, 'NAME') ?? val(find(t, 'PAYEE') ?? t, 'NAME');
      const memo = val(t, 'MEMO');
      // <ORIGCURRENCY>: TRNAMT is already in the account currency, converted at CURRATE from CURSYM.
      // <CURRENCY>: TRNAMT is in CURSYM; multiply by CURRATE for the account currency (OFX 2.1.1 §5.2).
      const origAgg = find(t, 'ORIGCURRENCY');
      const curAgg = origAgg ? undefined : find(t, 'CURRENCY');
      const orig = origAgg ?? curAgg;
      const rate = parseFloat(val(orig ?? t, 'CURRATE') ?? '');
      const origCur = val(orig ?? t, 'CURSYM');
      const foreign = Boolean(orig && origCur && origCur.toUpperCase() !== currency && Number.isFinite(rate) && rate > 0);
      const accountAmount = foreign && curAgg ? Math.round(amount * rate * 100) / 100 : amount;
      const originalAmount = foreign ? (curAgg ? amount : Math.round((amount / rate) * 100) / 100) : null;
      txs.push({
        date,
        description: joinDesc(name, memo) || val(t, 'TRNTYPE') || '(no description)',
        amount: accountAmount,
        balanceAfter: null,
        category: null,
        payee: name ?? null,
        pending: false,
        currency,
        originalAmount,
        originalCurrency: foreign ? origCur!.toUpperCase() : null,
        transactionDate: parseFlexibleDate(val(t, 'DTUSER'), 'YMD'),
        time: null,
        sourceId: val(t, 'FITID') ?? null,
        type: val(t, 'TRNTYPE') ?? null,
        reference: val(t, 'REFNUM') ?? val(t, 'CHECKNUM') ?? null,
        counterpartyName: null,
        merchantLocation: null,
        cardLast4: null,
        bankCategory: null,
        fee: null,
        exchangeRate: foreign ? rate : null,
        raw: leaves(t),
        attributes: null,
        merchant: null,
        row: i,
      });
    });
    txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const ledger = find(st, 'LEDGERBAL');
    const avail = find(st, 'AVAILBAL');
    accounts.push({
      institutionName: org,
      accountName: null,
      accountType: isCard ? 'credit_card' : acctType === 'SAVINGS' || acctType === 'MONEYMRKT' ? 'savings' : acctType === 'CREDITLINE' ? 'credit_card' : 'current',
      last4: acctId.replace(/\D/g, '').slice(-4) || null,
      currency,
      periodStart: parseFlexibleDate(val(list ?? st, 'DTSTART'), 'YMD'),
      periodEnd: parseFlexibleDate(val(list ?? st, 'DTEND'), 'YMD'),
      openingBalance: null,
      closingBalance: parseAmount(val(ledger, 'BALAMT')),
      balanceDate: parseFlexibleDate(val(ledger, 'DTASOF'), 'YMD'),
      availableBalance: parseAmount(val(avail, 'BALAMT')),
      creditLimit: null,
      contributionsToDate: null,
      gainLoss: null,
      governmentBonusToDate: null,
      taxYearContributions: null,
      cashBalance: null,
      annualIncome: null,
      interestRate: null,
      transactions: txs,
      holdings: [],
    });
  }
  if (!statements.length) notes.push('No bank or credit-card statement found in this OFX file (investment OFX is not supported yet).');
  return ExtractionSchema.parse({
    documentType: accounts.some((a) => a.accountType === 'credit_card') ? 'credit_card_statement' : 'bank_statement',
    institutionName: org,
    accounts,
    notes,
    confidence: statements.length ? 'high' : 'low',
  });
}
