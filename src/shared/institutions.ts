// A catalogue of common UK banks, building societies, platforms and pension providers. It is used
// to recognise institutions in documents and to suggest names; only institutions you actually use
// are written to data/institutions.json.
//
// fscsGroup: brands that share one banking licence share one FSCS limit. Only well-established
// shared licences are encoded here; check https://www.fscs.org.uk/check/check-your-money-is-protected/
// and edit the group in Settings if yours differs.

import type { Institution } from './schema';

export interface CatalogInstitution extends Institution {
  /** Case-insensitive regex source used to recognise the institution in text. */
  match: string;
}

const I = (
  id: string,
  name: string,
  kind: Institution['kind'],
  match: string,
  fscsGroup?: string,
): CatalogInstitution => ({ id, name, kind, match, ...(fscsGroup ? { fscsGroup } : {}) });

export const INSTITUTION_CATALOG: CatalogInstitution[] = [
  // Banks
  I('monzo', 'Monzo', 'bank', '\\bmonzo\\b'),
  I('starling', 'Starling Bank', 'bank', '\\bstarling\\b'),
  I('revolut', 'Revolut', 'bank', '\\brevolut\\b'),
  I('chase', 'Chase UK', 'bank', '\\bchase\\b(?!\\s*de\\b)', 'jpmorgan-europe'),
  I('barclays', 'Barclays', 'bank', '\\bbarclays\\b(?!\\s*card)', 'barclays-bank-uk'),
  I('barclaycard', 'Barclaycard', 'card_issuer', '\\bbarclaycard\\b', 'barclays-bank-uk'),
  I('hsbc', 'HSBC UK', 'bank', '\\bhsbc\\b', 'hsbc-uk'),
  I('first-direct', 'first direct', 'bank', '\\bfirst\\s*direct\\b', 'hsbc-uk'),
  I('ms-bank', 'M&S Bank', 'bank', '\\bm\\s*&\\s*s\\s*bank\\b|marks\\s*(and|&)\\s*spencer\\s*bank', 'hsbc-uk'),
  I('lloyds', 'Lloyds Bank', 'bank', '\\blloyds\\b', 'lloyds-bank'),
  I('halifax', 'Halifax', 'bank', '\\bhalifax\\b', 'bank-of-scotland'),
  I('bank-of-scotland', 'Bank of Scotland', 'bank', '\\bbank\\s*of\\s*scotland\\b', 'bank-of-scotland'),
  I('natwest', 'NatWest', 'bank', '\\bnat\\s*west\\b|national\\s*westminster', 'natwest'),
  I('rbs', 'Royal Bank of Scotland', 'bank', '\\brbs\\b|royal\\s*bank\\s*of\\s*scotland', 'rbs'),
  I('ulster-bank', 'Ulster Bank', 'bank', '\\bulster\\s*bank\\b'),
  I('santander', 'Santander UK', 'bank', '\\bsantander\\b', 'santander-uk'),
  I('cater-allen', 'Cater Allen', 'bank', '\\bcater\\s*allen\\b'),
  I('tsb', 'TSB', 'bank', '\\btsb\\b'),
  I('virgin-money', 'Virgin Money', 'bank', '\\bvirgin\\s*money\\b', 'clydesdale'),
  I('co-op-bank', 'The Co-operative Bank', 'bank', 'co-?operative\\s*bank|\\bco-op\\s*bank\\b', 'co-operative-bank'),
  I('smile', 'smile', 'bank', '\\bsmile\\.co\\.uk\\b|\\bsmile\\s*bank\\b', 'co-operative-bank'),
  I('metro-bank', 'Metro Bank', 'bank', '\\bmetro\\s*bank\\b'),
  I('tesco-bank', 'Tesco Bank', 'bank', '\\btesco\\s*bank\\b'),
  I('marcus', 'Marcus by Goldman Sachs', 'bank', '\\bmarcus\\b', 'goldman-sachs-intl-bank'),
  I('kroo', 'Kroo', 'bank', '\\bkroo\\b'),
  I('atom', 'Atom bank', 'bank', '\\batom\\s*bank\\b'),
  I('zopa', 'Zopa', 'bank', '\\bzopa\\b'),
  I('allica', 'Allica Bank', 'bank', '\\ballica\\b'),
  I('paragon', 'Paragon Bank', 'bank', '\\bparagon\\b'),
  I('shawbrook', 'Shawbrook Bank', 'bank', '\\bshawbrook\\b'),
  I('amex', 'American Express', 'card_issuer', 'american\\s*express|\\bamex\\b'),
  I('capital-one', 'Capital One', 'card_issuer', '\\bcapital\\s*one\\b'),
  I('ns-and-i', 'NS&I', 'government', '\\bns\\s*&\\s*i\\b|national\\s*savings'),
  // Building societies
  I('nationwide', 'Nationwide', 'building_society', '\\bnationwide\\b'),
  I('yorkshire-bs', 'Yorkshire Building Society', 'building_society', '\\byorkshire\\s*building', 'yorkshire-bs'),
  I('chelsea-bs', 'Chelsea Building Society', 'building_society', '\\bchelsea\\s*building', 'yorkshire-bs'),
  I('coventry-bs', 'Coventry Building Society', 'building_society', '\\bcoventry\\s*building'),
  I('skipton-bs', 'Skipton Building Society', 'building_society', '\\bskipton\\b'),
  I('leeds-bs', 'Leeds Building Society', 'building_society', '\\bleeds\\s*building'),
  I('principality-bs', 'Principality Building Society', 'building_society', '\\bprincipality\\b'),
  // Platforms & apps
  I('vanguard', 'Vanguard Investor', 'investment_platform', '\\bvanguard\\b'),
  I('hargreaves-lansdown', 'Hargreaves Lansdown', 'investment_platform', 'hargreaves\\s*lansdown|\\bhl\\b'),
  I('aj-bell', 'AJ Bell', 'investment_platform', '\\baj\\s*bell\\b|\\bdodl\\b'),
  I('interactive-investor', 'interactive investor', 'investment_platform', 'interactive\\s*investor|\\bii\\.co\\.uk\\b'),
  I('fidelity', 'Fidelity', 'investment_platform', '\\bfidelity\\b'),
  I('trading-212', 'Trading 212', 'investment_platform', 'trading\\s*212|\\bt212\\b'),
  I('freetrade', 'Freetrade', 'investment_platform', '\\bfreetrade\\b'),
  I('invest-engine', 'InvestEngine', 'investment_platform', '\\binvest\\s*engine\\b'),
  I('nutmeg', 'Nutmeg', 'investment_platform', '\\bnutmeg\\b'),
  I('moneybox', 'Moneybox', 'investment_platform', '\\bmoney\\s*box\\b'),
  I('plum', 'Plum', 'investment_platform', '\\bplum\\b'),
  I('chip', 'Chip', 'investment_platform', '\\bchip\\b'),
  I('wealthify', 'Wealthify', 'investment_platform', '\\bwealthify\\b'),
  I('lightyear', 'Lightyear', 'investment_platform', '\\blightyear\\b'),
  I('coinbase', 'Coinbase', 'crypto_exchange', '\\bcoinbase\\b'),
  I('kraken', 'Kraken', 'crypto_exchange', '\\bkraken\\b'),
  // Pensions
  I('pensionbee', 'PensionBee', 'pension_provider', '\\bpension\\s*bee\\b'),
  I('nest', 'Nest', 'pension_provider', '\\bnest\\b(?!\\s*egg)'),
  I('peoples-pension', "The People's Pension", 'pension_provider', "people'?s\\s*pension"),
  I('aviva', 'Aviva', 'pension_provider', '\\baviva\\b'),
  I('scottish-widows', 'Scottish Widows', 'pension_provider', '\\bscottish\\s*widows\\b'),
  I('legal-and-general', 'Legal & General', 'pension_provider', 'legal\\s*(&|and)\\s*general|\\bl&g\\b'),
  I('standard-life', 'Standard Life', 'pension_provider', '\\bstandard\\s*life\\b'),
  I('royal-london', 'Royal London', 'pension_provider', '\\broyal\\s*london\\b'),
  I('aegon', 'Aegon', 'pension_provider', '\\baegon\\b|\\bcofunds\\b'),
  I('now-pensions', 'NOW: Pensions', 'pension_provider', '\\bnow:?\\s*pensions\\b'),
  I('smart-pension', 'Smart Pension', 'pension_provider', '\\bsmart\\s*pension\\b'),
  I('uss', 'USS', 'pension_provider', '\\buss\\b|universities\\s*superannuation'),
  I('nhs-pensions', 'NHS Pensions', 'pension_provider', '\\bnhs\\s*pension'),
  I('civil-service-pensions', 'Civil Service Pensions', 'pension_provider', 'civil\\s*service\\s*pension|\\balpha\\s*scheme\\b'),
  I('teachers-pensions', "Teachers' Pensions", 'pension_provider', "teachers'?\\s*pension"),
  I('lgps', 'Local Government Pension Scheme', 'pension_provider', '\\blgps\\b|local\\s*government\\s*pension'),
  I('dwp', 'DWP (State Pension)', 'government', '\\bdwp\\b|state\\s*pension|check\\s*your\\s*state\\s*pension'),
  I('slc', 'Student Loans Company', 'government', 'student\\s*loans?\\s*company|\\bslc\\b'),
  I('hmrc', 'HMRC', 'government', '\\bhmrc\\b'),
];

const compiled = INSTITUTION_CATALOG.map((i) => ({ inst: i, re: new RegExp(i.match, 'i') }));

/** Best catalogue match for a name or free text, preferring longer (more specific) names. */
export function findInstitution(text: string | null | undefined): CatalogInstitution | undefined {
  if (!text) return undefined;
  const hits = compiled.filter(({ re }) => re.test(text)).map(({ inst }) => inst);
  hits.sort((a, b) => b.name.length - a.name.length);
  return hits[0];
}

export function catalogInstitution(id: string): CatalogInstitution | undefined {
  return INSTITUTION_CATALOG.find((i) => i.id === id);
}
