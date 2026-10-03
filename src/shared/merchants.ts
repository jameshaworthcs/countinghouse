// Built-in UK merchant recognition: turns "CARD PAYMENT TO TESCO STORES 2231 ON 12/09" into payee
// "Tesco" and category "groceries". Your own rules (data/rules.json) always run first and win.
//
// Each entry: [regex (case-insensitive, matched against the description), payee, category,
// direction?]. Order matters: specific patterns sit above general ones (TESCO BANK before TESCO).

export type Direction = 'in' | 'out';
export type MerchantDef = [pattern: string, payee: string, category: string, direction?: Direction];

export const MERCHANTS: MerchantDef[] = [
  // ── Transfers, cards and financial plumbing (before anything that could shadow them) ──
  ['THANK ?YOU|PAYMENT RECEIVED.*THANK', 'Card payment', 'credit-card-payment', 'in'],
  ['M ?& ?S BANK', 'M&S Bank', 'credit-card-payment', 'out'],
  ['AMERICAN EXPRESS|\\bAMEX\\b', 'American Express', 'credit-card-payment', 'out'],
  ['BARCLAYCARD', 'Barclaycard', 'credit-card-payment', 'out'],
  ['CAPITAL ONE', 'Capital One', 'credit-card-payment', 'out'],
  ['\\bMBNA\\b', 'MBNA', 'credit-card-payment', 'out'],
  ['VIRGIN MONEY CREDIT CARD|\\bCREDIT CARD\\b.*PAYMENT', 'Credit card', 'credit-card-payment', 'out'],
  // Chase pays its card as "To Credit Card" (statement, app) and "To Revolving Line Account" (export).
  ['\\bTO CREDIT CARD\\b|\\bREVOLVING LINE\\b', 'Credit card', 'credit-card-payment', 'out'],
  // A charge disputed with the card company: its credit is a refund, and a debit that takes it back
  // again reverses that refund, so the two come to nothing.
  ['CREDIT FOR DISPUTED|DISPUTED (CHARGE|TRANSACTION) CREDIT|\\bCHARGEBACK\\b', 'Disputed charge', 'refunds', 'in'],
  ['DEBIT ADJUSTMENT|DISPUTE (REVERSAL|ADJUSTMENT)|CHARGEBACK REVERSAL', 'Disputed charge', 'refunds', 'out'],
  // Investment platforms, as money paid to them. Money in from one is a withdrawal: the categoriser
  // reads these for that too (shared/categorise.ts, step 4a).
  ['VANGUARD', 'Vanguard', 'investment-transfer', 'out'],
  ['HARGREAVES|HARGREAVE LANS', 'Hargreaves Lansdown', 'investment-transfer', 'out'],
  ['\\bAJ BELL\\b|\\bDODL\\b', 'AJ Bell', 'investment-transfer', 'out'],
  ['TRADING ?212', 'Trading 212', 'investment-transfer', 'out'],
  ['FREETRADE', 'Freetrade', 'investment-transfer', 'out'],
  // Santander cuts the name short ("INTERACTIVE INVEST REF …"); its monthly plan fee carries "FEE" in the reference.
  ['INTERACTIVE INVEST.*FEE', 'interactive investor', 'investment-fee', 'out'],
  ['INTERACTIVE INVEST(OR)?\\b', 'interactive investor', 'investment-transfer', 'out'],
  ['\\bETORO\\b', 'eToro', 'investment-transfer', 'out'],
  ['ROBINHOOD', 'Robinhood', 'investment-transfer', 'out'],
  ['MOONPAY', 'MoonPay', 'investment-transfer', 'out'],
  ['COINBASE', 'Coinbase', 'investment-transfer', 'out'],
  // Kraken's company is Payward ("PAYWARD SERVICES LTD").
  ['\\bKRAKEN\\b|\\bPAYWARD\\b', 'Kraken', 'investment-transfer', 'out'],
  ['BINANCE', 'Binance', 'investment-transfer', 'out'],
  ['CRYPTO\\.COM', 'Crypto.com', 'investment-transfer', 'out'],
  ['\\bBITPANDA\\b|\\bBITSTAMP\\b|\\bUPHOLD\\b', 'Crypto exchange', 'investment-transfer', 'out'],
  ['INVESTENGINE|INVEST ENGINE', 'InvestEngine', 'investment-transfer', 'out'],
  ['NUTMEG', 'Nutmeg', 'investment-transfer', 'out'],
  ['MONEYBOX', 'Moneybox', 'investment-transfer', 'out'],
  ['PENSIONBEE', 'PensionBee', 'investment-transfer', 'out'],
  ['FIDELITY', 'Fidelity', 'investment-transfer', 'out'],
  ['LIGHTYEAR', 'Lightyear', 'investment-transfer', 'out'],
  ['WEALTHIFY', 'Wealthify', 'investment-transfer', 'out'],
  ['PREMIUM BONDS? (PURCHASE|DD|BUY)|NS&I.*(PURCHASE|DEPOSIT)|NSANDI', 'NS&I', 'savings-transfer', 'out'],
  ['PREMIUM BOND PRIZE|NS&I.*PRIZE|NSANDI.*PRIZE|AUTO PRIZE REINVEST', 'NS&I Premium Bonds prize', 'other-income', 'in'],
  ['SAVINGS POT|TRANSFER (TO|FROM) POT|\\bPOT TRANSFER|FROM SAVINGS POT|ROUND ?UP|SAVING SPACE|SPACE TRANSFER|\\bTO SAVINGS\\b|\\bFROM SAVINGS\\b', 'Savings', 'savings-transfer'],
  ['CASH WITHDRAWAL|\\bATM\\b|CASH MACHINE|CASHPOINT|\\bLINK\\b.*CASH|^CASH\\b|CASH CD\\b|CSH WDL', 'Cash withdrawal', 'cash-withdrawal', 'out'],
  // Cash paid in is not here: a gift, your own cash back or something sold, it is yours to say
  // (categorise.ts, step 1b).

  // ── Income ──
  // "WAGES" also inside a payroll reference ("WWAGES012345/01"); "PAYE" at a word's end is an
  // employer's payroll ("ExampleCoPAYE"), except HMRC's own PAYE refunds (below).
  ['SALARY|PAYROLL|WAGES|\\bSAL\\b|^(?!.*HMRC).*PAYE\\b', 'Salary', 'salary', 'in'],
  ['HMRC.*(CHILD BENEFIT|TAX CREDIT)|CHILD BENEFIT|UNIVERSAL CREDIT|\\bDWP\\b', 'Benefits', 'benefits', 'in'],
  ['HMRC', 'HMRC', 'tax-refund', 'in'],
  ['HMRC', 'HMRC', 'tax', 'out'],
  ['GROSS INTEREST|INTEREST (PAID|EARNED|CREDIT)|CREDIT INTEREST|\\bINTEREST\\b(?!.*CHARGE)', 'Interest', 'interest', 'in'],
  ['DIVIDEND', 'Dividend', 'dividends', 'in'],
  ['CASHBACK|REWARDS? (CREDIT|PAYOUT)|TOPCASHBACK|QUIDCO', 'Cashback', 'cashback', 'in'],
  ['REFUND', 'Refund', 'refunds', 'in'],

  // ── Bank fees & charges ──
  ['NON[- ]?STERLING|NON-GBP|FOREIGN (TRANSACTION|EXCHANGE|CURRENCY) (FEE|CHARGE)|CURRENCY CONVERSION FEE|FX FEE', 'Foreign transaction fee', 'bank-fees', 'out'],
  ['OVERDRAFT (FEE|INTEREST|CHARGE|USAGE)|ACCOUNT FEE|MONTHLY FEE|ARRANGEMENT FEE|UNPAID ITEM|LATE PAYMENT FEE', 'Bank fee', 'bank-fees', 'out'],
  ['INTEREST CHARGE|PURCHASE INTEREST|CASH INTEREST|INTEREST ON (PURCHASES|CASH)', 'Interest charged', 'interest-charges', 'out'],

  // ── Groceries (specific Tesco/Sainsbury's variants first) ──
  ['TESCO BANK', 'Tesco Bank', 'credit-card-payment', 'out'],
  ['TESCO MOBILE', 'Tesco Mobile', 'mobile'],
  ['TESCO PFS|TESCO PETROL|TESCO FUEL', 'Tesco Petrol', 'fuel'],
  ['SAINSBURY.{0,4}PETROL|SAINSBURYS PFS|JS PETROL', "Sainsbury's Petrol", 'fuel'],
  ['ASDA PETROL|ASDA PFS|ASDA EXPRESS PETROL', 'Asda Petrol', 'fuel'],
  ['MORRISONS? (PETROL|FUEL|PFS)', 'Morrisons Petrol', 'fuel'],
  ['TESCO', 'Tesco', 'groceries'],
  ["SAINSBURY|JS ONLINE|\\bJ SAINSBURY", "Sainsbury's", 'groceries'],
  ['\\bASDA\\b', 'Asda', 'groceries'],
  ['MORRISON', 'Morrisons', 'groceries'],
  ['\\bALDI\\b', 'Aldi', 'groceries'],
  ['\\bLIDL\\b', 'Lidl', 'groceries'],
  ['WAITROSE', 'Waitrose', 'groceries'],
  ['OCADO', 'Ocado', 'groceries'],
  ['M&S SIMPLY FOOD|M & S SIMPLY|M&S FOOD|MARKS & SPENCER FOOD|M&S (MOTO|WELCOME BREAK|BP)|MARKS AND SPENCER.*FOOD', 'M&S Food', 'groceries'],
  ['CO-?OP (GROUP )?FOOD|COOP FOOD|\\bCO-OP\\b(?!.*BANK)|CENTRAL CO-?OP|SOUTHERN CO-?OP|MIDCOUNTIES|EAST OF ENGLAND CO', 'Co-op', 'groceries'],
  ['\\bICELAND\\b', 'Iceland', 'groceries'],
  ['FARMFOODS', 'Farmfoods', 'groceries'],
  ['\\bSPAR\\b', 'Spar', 'groceries'],
  ['BUDGENS', 'Budgens', 'groceries'],
  ['LONDIS', 'Londis', 'groceries'],
  ['COSTCUTTER', 'Costcutter', 'groceries'],
  ['\\bNISA\\b', 'Nisa', 'groceries'],
  ['ONE STOP', 'One Stop', 'groceries'],
  ['BOOTHS', 'Booths', 'groceries'],
  ['WHOLE ?FOODS', 'Whole Foods', 'groceries'],
  ['PLANET ORGANIC', 'Planet Organic', 'groceries'],
  ['AMAZON FRESH', 'Amazon Fresh', 'groceries'],
  ['\\bGETIR\\b|\\bZAPP\\b', 'Rapid grocery', 'groceries'],
  ['MILK ?& ?MORE', 'Milk & More', 'groceries'],
  ['ABEL ?& ?COLE|RIVERFORD', 'Veg box', 'groceries'],
  ['HELLO ?FRESH|GOUSTO|MINDFUL CHEF', 'Meal kit', 'groceries'],
  ['COSTCO', 'Costco', 'groceries'],

  // ── Takeaway & delivery ──
  ['UBER\\s?\\*?\\s?EATS|UBEREATS', 'Uber Eats', 'takeaway'],
  ['DELIVEROO', 'Deliveroo', 'takeaway'],
  ['JUST ?EAT', 'Just Eat', 'takeaway'],
  ['DOMINO', "Domino's", 'takeaway'],
  ['PAPA ?JOHN', "Papa John's", 'takeaway'],

  // ── Coffee & snacks ──
  ['PRET A MANGER|\\bPRET\\b', 'Pret A Manger', 'coffee'],
  ['COSTA', 'Costa', 'coffee'],
  ['STARBUCKS', 'Starbucks', 'coffee'],
  ['CAFFE? NERO', 'Caffè Nero', 'coffee'],
  ['GREGGS', 'Greggs', 'coffee'],
  ['BLACK SHEEP COFFEE', 'Black Sheep Coffee', 'coffee'],
  ['JOE ?& ?THE ?JUICE', 'Joe & The Juice', 'coffee'],
  ["GAIL'?S|\\bGAILS\\b", "GAIL's", 'coffee'],
  ['BLANK STREET', 'Blank Street', 'coffee'],
  ['PATISSERIE VALERIE', 'Patisserie Valerie', 'coffee'],
  
  // ── Pubs & bars ──
  ['WETHERSPOON|J D WETHERSPOON|JDW\\b', 'Wetherspoon', 'pubs-bars'],
  ['GREENE KING', 'Greene King', 'pubs-bars'],
  ['BREWDOG', 'BrewDog', 'pubs-bars'],
  ['NICHOLSONS|STONEGATE|YOUNGS PUB|FULLERS|SAMUEL SMITH|MITCHELLS ?& ?BUTLERS|\\bPUB\\b|\\bTAVERN\\b|\\bFREE ?HOUSE\\b|\\bTAPROOM\\b|\\bBAR\\b(?! ?(CLAYS|CLAYCARD))', 'Pub', 'pubs-bars'],

  // ── Eating out ──
  ["MCDONALD", "McDonald's", 'eating-out'],
  ['BURGER KING', 'Burger King', 'eating-out'],
  ['\\bKFC\\b', 'KFC', 'eating-out'],
  ['SUBWAY', 'Subway', 'eating-out'],
  ["NANDO", "Nando's", 'eating-out'],
  ['WAGAMAMA', 'wagamama', 'eating-out'],
  ['PIZZA EXPRESS|PIZZAEXPRESS', 'PizzaExpress', 'eating-out'],
  ['PIZZA HUT', 'Pizza Hut', 'eating-out'],
  ['FIVE GUYS', 'Five Guys', 'eating-out'],
  ['\\bLEON\\b', 'LEON', 'eating-out'],
  ['\\bITSU\\b', 'itsu', 'eating-out'],
  ['WASABI', 'Wasabi', 'eating-out'],
  ['TORTILLA', 'Tortilla', 'eating-out'],
  ['CHIPOTLE', 'Chipotle', 'eating-out'],
  ['DISHOOM', 'Dishoom', 'eating-out'],
  ['FRANCO MANCA', 'Franco Manca', 'eating-out'],
  ['HONEST BURGER', 'Honest Burgers', 'eating-out'],
  ['ZIZZI', 'Zizzi', 'eating-out'],
  ['PREZZO', 'Prezzo', 'eating-out'],
  ['BELLA ITALIA', 'Bella Italia', 'eating-out'],
  ['WAHACA', 'Wahaca', 'eating-out'],
  ['YO! ?SUSHI|YO SUSHI', 'YO!', 'eating-out'],
  ['TOBY CARVERY', 'Toby Carvery', 'eating-out'],
  ['HARVESTER', 'Harvester', 'eating-out'],
  ['FRANKIE ?& ?BENNY', "Frankie & Benny's", 'eating-out'],
  ['GOURMET BURGER|\\bGBK\\b', 'GBK', 'eating-out'],
  ['\\bCOTE\\b|CÔTE', 'Côte', 'eating-out'],
  ['LAS ?IGUANAS', 'Las Iguanas', 'eating-out'],
  ['MILLER ?& ?CARTER', 'Miller & Carter', 'eating-out'],
  ['\\bPOPEYES\\b', 'Popeyes', 'eating-out'],
  ['\\bTACO BELL\\b', 'Taco Bell', 'eating-out'],
  ['\\bWINGSTOP\\b', 'Wingstop', 'eating-out'],
  ['RESTAURANT|\\bBRASSERIE\\b|\\bTRATTORIA\\b|\\bBISTRO\\b', 'Restaurant', 'eating-out'],

  // ── Transport ──
  ['UBER\\s?\\*?\\s?TRIP|UBER BV|UBER \\*|\\bUBER\\b', 'Uber', 'taxis'],
  ['\\bBOLT\\b', 'Bolt', 'taxis'],
  ['ADDISON LEE', 'Addison Lee', 'taxis'],
  ['FREE ?NOW', 'FREENOW', 'taxis'],
  ['TFL ROAD|ROAD USER CHARG|CONGESTION CHARGE|\\bULEZ\\b|DART ?CHARGE|M6 ?TOLL', 'Road charge', 'parking'],
  ['\\bTFL\\b|TRANSPORT FOR LONDON|TFL\\.GOV|OYSTER|\\bLUL\\b|LONDON UNDERGROUND', 'TfL', 'public-transport'],
  ['TRAINLINE', 'Trainline', 'trains'],
  ['\\bLNER\\b|AVANTI|\\bGWR\\b|GREAT WESTERN RAIL|SOUTHERN RAIL|SOUTHEASTERN|THAMESLINK|NORTHERN TRAINS|NORTHERN RAIL|TRANSPENNINE|CROSSCOUNTRY|SCOTRAIL|CHILTERN RAIL|\\bC2C\\b|GREATER ANGLIA|WEST MIDLANDS TRAINS|SOUTH WESTERN RAIL|\\bSWR\\b|MERSEYRAIL|TRANSPORT FOR WALES|GRAND CENTRAL|HULL TRAINS|LUMO|NATIONAL RAIL|RAIL ?CARD', 'Rail', 'trains'],
  ['EUROSTAR', 'Eurostar', 'trains'],
  ['STAGECOACH|\\bARRIVA\\b|FIRST BUS|FIRSTBUS|GO AHEAD|NATIONAL EXPRESS|MEGABUS|METROLINK|NEXUS|BUS FARE', 'Bus & coach', 'public-transport'],
  ['\\bLIME\\b|SANTANDER CYCLES|HUMAN FORESTS|\\bVOI\\b|\\bTIER\\b', 'Bike & scooter hire', 'public-transport'],
  ['\\bSHELL\\b(?! ENERGY)', 'Shell', 'fuel'],
  // Not a "BP" that ends the description: HSBC ends its rows with the payment's type, "BP" for a
  // bill payment ("EXAMPLE LETTINGS 12 FLAT BP").
  ['\\bBP\\b(?! PULSE)(?!\\s*$)|BP CONNECT', 'BP', 'fuel'],
  ['\\bESSO\\b', 'Esso', 'fuel'],
  ['TEXACO', 'Texaco', 'fuel'],
  ['\\bJET\\b.*(SERVICE|PETROL|FILLING)', 'JET', 'fuel'],
  ['\\bMFG\\b|MOTOR FUEL|EG GROUP|EUROGARAGES', 'Fuel', 'fuel'],
  ['POD ?POINT|IONITY|INSTAVOLT|BP PULSE|GRIDSERVE|OSPREY|TESLA SUPERCHARG|ZAPMAP|CHARGEPOINT|SHELL RECHARGE|FASTNED', 'EV charging', 'fuel'],
  ['\\bNCP\\b|RINGGO|PAYBYPHONE|JUSTPARK|JUST PARK|\\bAPCOA\\b|Q-PARK|EURO CAR PARKS|PARKING|\\bCAR PARKS?\\b', 'Parking', 'parking'],
  ['DVLA', 'DVLA', 'vehicle-tax'],
  ['KWIK ?FIT|HALFORDS AUTOCENTRE|ATS EUROMASTER|NATIONAL TYRES|FORMULA ONE AUTO|\\bMOT\\b', 'Car maintenance', 'car-maintenance'],
  ['\\bRAC\\b|\\bAA MEMBERSHIP|AUTOMOBILE ASSOC|GREEN FLAG', 'Breakdown cover', 'car-insurance'],

  // ── Bills & utilities ──
  ['OCTOPUS ?ENERGY', 'Octopus Energy', 'energy'],
  ['BRITISH GAS', 'British Gas', 'energy'],
  ['\\bEDF\\b', 'EDF', 'energy'],
  ['\\bE\\.?ON\\b|EON NEXT', 'E.ON Next', 'energy'],
  ['\\bOVO\\b', 'OVO', 'energy'],
  ['SCOTTISH ?POWER', 'ScottishPower', 'energy'],
  ['\\bSSE\\b', 'SSE', 'energy'],
  ['UTILITA|SO ENERGY|SHELL ENERGY|GOOD ENERGY|ECOTRICITY|OUTFOX THE MARKET|BULB ENERGY', 'Energy', 'energy'],
  ['THAMES WATER|SEVERN TRENT|UNITED UTILITIES|ANGLIAN WATER|YORKSHIRE WATER|SOUTHERN WATER|SOUTH WEST WATER|WELSH WATER|DWR CYMRU|NORTHUMBRIAN WATER|AFFINITY WATER|WESSEX WATER|SES WATER|BRISTOL WATER|PORTSMOUTH WATER|SOUTH EAST WATER|SOUTH STAFFS WATER|ESSEX ?& ?SUFFOLK WATER|\\bWATER\\b.*(PLC|LTD|BILL|RATES)', 'Water', 'water'],
  ['TV LICEN|\\bTVL\\b', 'TV Licensing', 'tv-licence'],
  ['VIRGIN MEDIA', 'Virgin Media', 'broadband'],
  ['\\bSKY (DIGITAL|UK|BROADBAND|TV|SUBSCRIPTION)|SKY\\.COM|\\bSKY\\b(?! ?(MOBILE|SCANNER))', 'Sky', 'broadband'],
  ['TALKTALK|PLUSNET|HYPEROPTIC|COMMUNITY FIBRE|ZEN INTERNET|GIGACLEAR|\\bTROOLI\\b|YOUFIBRE|CUCKOO|NOW BROADBAND|VODAFONE BROADBAND|\\bBT\\b(?! ?(SPORT|MOBILE))|BT GROUP|BRITISH TELECOM', 'Broadband', 'broadband'],
  ['\\bEE\\b|EE LIMITED|EE LTD', 'EE', 'mobile'],
  ['\\bO2\\b(?! ?(ARENA|ACADEMY|INSTITUTE))|TELEFONICA', 'O2', 'mobile'],
  ['VODAFONE', 'Vodafone', 'mobile'],
  ['\\bTHREE\\b|HUTCHISON ?3G|THREE\\.CO', 'Three', 'mobile'],
  ['GIFFGAFF', 'giffgaff', 'mobile'],
  ['SKY MOBILE|\\bID MOBILE|LEBARA|LYCAMOBILE|SMARTY|\\bVOXI\\b|HONEST MOBILE|BT MOBILE', 'Mobile', 'mobile'],
  ['COUNCIL TAX|\\bC\\/TAX\\b|\\bCTAX\\b|\\bCOUNCIL\\b|LONDON BOROUGH|\\bLB OF\\b|\\bRB OF\\b', 'Council tax', 'council-tax', 'out'],
  ['MORTGAGE', 'Mortgage', 'mortgage-payment', 'out'],
  ['\\bRENT\\b(?!AL)|OPENRENT|LETTING', 'Rent', 'rent', 'out'],
  ['STUDENT LOANS? CO|\\bSLC\\b', 'Student Loans Company', 'loan-repayment', 'out'],
  ['BLACK HORSE|MOTONOVO|CLOSE BROTHERS|SANTANDER CONSUMER|\\bLOAN\\b', 'Loan', 'loan-repayment', 'out'],

  // ── Subscriptions ──
  ['NETFLIX', 'Netflix', 'streaming'],
  ['SPOTIFY', 'Spotify', 'streaming'],
  ['DISNEY ?(PLUS|\\+)', 'Disney+', 'streaming'],
  ['PRIME VIDEO', 'Prime Video', 'streaming'],
  ['AMAZON PRIME|AMZN PRIME|PRIME MEMBER', 'Amazon Prime', 'memberships'],
  ['YOUTUBE|GOOGLE \\*YOUTUBE', 'YouTube', 'streaming'],
  ['NOW TV|NOWTV|\\bNOW\\b.*(ENTERTAINMENT|CINEMA|MEMBERSHIP)', 'NOW', 'streaming'],
  ['BRITBOX|PARAMOUNT|APPLE TV|DAZN|DISCOVERY ?\\+|TNT SPORTS|CRUNCHYROLL|MUBI', 'Streaming', 'streaming'],
  ['AUDIBLE', 'Audible', 'books'],
  ['KINDLE', 'Kindle', 'books'],
  ['APPLE\\.COM\\/BILL|APPLE\\.COM BILL|ITUNES|APP STORE', 'Apple', 'software'],
  ['APPLE STORE|APPLE RETAIL|\\bAPPLE R\\d+', 'Apple Store', 'electronics'],
  ['GOOGLE (STORAGE|ONE|\\*GOOGLE ONE|PLAY|WORKSPACE|CLOUD)|GOOGLE \\*', 'Google', 'software'],
  ['MICROSOFT|MSFT|XBOX', 'Microsoft', 'software'],
  ['ADOBE', 'Adobe', 'software'],
  ['DROPBOX|1PASSWORD|LASTPASS|NORDVPN|EXPRESSVPN|PROTON|GITHUB|\\bNOTION\\b|CANVA|ZOOM\\.US|SLACK|FIGMA|JETBRAINS|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\\.AI|MIDJOURNEY|CURSOR|VERCEL|DIGITALOCEAN|HETZNER|CLOUDFLARE|\\bAWS\\b|AMAZON WEB SERVICES|NAMECHEAP|GODADDY|SQUARESPACE|WIX\\.COM', 'Software', 'software'],
  ['DUOLINGO|HEADSPACE|CALM\\.COM|\\bCALM\\b', 'App subscription', 'software'],
  ['PLAYSTATION|\\bPSN\\b|SONY INTERACTIVE', 'PlayStation', 'games'],
  ['NINTENDO', 'Nintendo', 'games'],
  ['STEAM(GAMES| PURCHASE|POWERED)|VALVE', 'Steam', 'games'],
  ['EPIC GAMES|ROBLOX|RIOT GAMES|BLIZZARD|EA \\*|ELECTRONIC ARTS', 'Games', 'games'],
  ['PATREON|SUBSTACK|ONLYFANS|BUY ?ME ?A ?COFFEE', 'Creator membership', 'memberships'],
  ['NATIONAL TRUST|ENGLISH HERITAGE|\\bRSPB\\b|HISTORIC ROYAL PALACES|\\bCADW\\b', 'Membership', 'memberships'],
  ['THE TIMES|TIMES NEWSPAPERS|GUARDIAN|FINANCIAL TIMES|\\bFT\\.COM|ECONOMIST|TELEGRAPH|NEW YORK TIMES|NYTIMES|THE ATHLETIC|PRIVATE EYE|SPECTATOR|MEDIUM\\.COM', 'News', 'news-magazines'],

  // ── Health & fitness ──
  ['PURE ?GYM', 'PureGym', 'gym'],
  ['THE GYM GROUP|GYM GROUP', 'The Gym Group', 'gym'],
  ['DAVID LLOYD', 'David Lloyd', 'gym'],
  ['VIRGIN ACTIVE', 'Virgin Active', 'gym'],
  ['NUFFIELD HEALTH', 'Nuffield Health', 'gym'],
  ['ANYTIME FITNESS|FITNESS FIRST|EVERYONE ACTIVE|\\bBETTER\\b.*(GYM|LEISURE)|\\bGLL\\b|1REBEL|BARRYS|\\bF45\\b|THIRD SPACE|CLASSPASS|PELOTON|STRAVA|LEISURE CENTRE|\\bGYM\\b', 'Gym', 'gym'],
  ['BOOTS OPTICIANS|SPECSAVERS|VISION EXPRESS|OPTICAL EXPRESS|OPTICIAN', 'Opticians', 'optical'],
  ['\\bBOOTS\\b', 'Boots', 'pharmacy'],
  ['SUPERDRUG', 'Superdrug', 'pharmacy'],
  ['PHARMACY|CHEMIST|WELL PHARMACY|ROWLANDS|NHS ?BSA|PRESCRIPTION', 'Pharmacy', 'pharmacy'],
  ['DENTAL|DENTIST|MYDENTIST|ORTHODONT', 'Dentist', 'dental'],
  ['\\bBUPA\\b|VITALITY|AXA HEALTH|PUSH DOCTOR|PHYSIO|OSTEOPATH|CHIROPRACT|\\bCLINIC\\b|HOSPITAL', 'Healthcare', 'healthcare'],

  // ── Personal care ──
  ['BARBER|HAIRDRESS|\\bHAIR\\b|\\bSALON\\b|TONI ?& ?GUY|TREATWELL|\\bNAILS?\\b|\\bSPA\\b|BEAUTY', 'Hair & beauty', 'hair-beauty'],

  // ── Shopping ──
  ['AMAZON|AMZN|AMZ\\*|AMZNMKTPLACE', 'Amazon', 'online-marketplace'],
  ['\\bEBAY\\b', 'eBay', 'online-marketplace'],
  ['\\bETSY\\b', 'Etsy', 'online-marketplace'],
  ['TEMU|SHEIN|ALIEXPRESS|ALIBABA|WISH\\.COM', 'Marketplace', 'online-marketplace'],
  ['VINTED|DEPOP', 'Second-hand fashion', 'clothing'],
  ['\\bARGOS\\b', 'Argos', 'general-shopping'],
  ['JOHN LEWIS', 'John Lewis', 'general-shopping'],
  ['CURRYS|PC WORLD', 'Currys', 'electronics'],
  ['\\bIKEA\\b', 'IKEA', 'home-garden'],
  ['B ?& ?Q\\b|\\bB AND Q\\b', 'B&Q', 'home-garden'],
  ['WICKES|HOMEBASE|SCREWFIX|TOOLSTATION|DUNELM|THE RANGE|WAYFAIR|HABITAT|ROBERT DYAS|LAKELAND|DOBBIES|WYEVALE|GARDEN CENTRE|HOBBYCRAFT', 'Home & garden', 'home-garden'],
  ['\\bB ?& ?M\\b|HOME BARGAINS|POUNDLAND|THE WORKS|\\bWILKO\\b|TK ?MAXX|\\bHOMESENSE\\b', 'Discount store', 'general-shopping'],
  ['PRIMARK|\\bNEXT\\b(?! ?DAY)|NEXT RETAIL|H ?& ?M\\b|HENNES|\\bZARA\\b|UNIQLO|\\bASOS\\b|BOOHOO|JD SPORTS|SPORTS ?DIRECT|RIVER ISLAND|NEW LOOK|SUPERDRY|\\bSCHUH\\b|CLARKS|\\bOFFICE\\b.*SHOES|MATALAN|\\bMANGO\\b|\\bCOS\\b|ARKET|SELFRIDGES|HARRODS|LIBERTY|FAT FACE|WHITE STUFF|SEASALT|JOULES|MONSOON|ACCESSORIZE|\\bGAP\\b|\\bMUJI\\b|NIKE|ADIDAS|DECATHLON|GO OUTDOORS|MOUNTAIN WAREHOUSE|BLACKS|CRAGHOPPERS|GYMSHARK|END\\. ?CLOTHING|MR ?PORTER|NET-A-PORTER|ALLSAINTS|TED BAKER|REISS|HOBBS|WHISTLES|JIGSAW|BODEN|TOPSHOP|PRETTYLITTLETHING|MISSGUIDED', 'Clothing', 'clothing'],
  ['MARKS ?(&|AND) ?SPENCER|\\bM ?& ?S\\b', 'M&S', 'general-shopping'],
  ['WATERSTONES|FOYLES|BLACKWELL|WH ?SMITH|\\bBOOKS?\\b(?!ING)', 'Books', 'books'],
  ['SMYTHS|THE ENTERTAINER|MOTHERCARE|JOJO MAMAN|HAMLEYS|LEGO', 'Kids', 'kids'],
  ['MOONPIG|CARD FACTORY|FUNKY PIGEON|INTERFLORA|NOT ?ON ?THE ?HIGH ?STREET|NOTONTHEHIGHSTREET|THORNTONS|HOTEL CHOCOLAT|\\bFLORIST\\b|BLOOM ?& ?WILD|APPLEYARD', 'Gifts', 'gifts'],
  ['PETS AT HOME|JOLLYES|ZOOPLUS|VETS ?4 ?PETS|MEDIVET|\\bVETS?\\b|VETERINARY|TAILS\\.COM|BUTTERNUT BOX|PURINA|LILY.?S KITCHEN', 'Pets', 'pets'],

  // ── Entertainment ──
  ['TICKETMASTER|SEE TICKETS|\\bAXS\\b|EVENTBRITE|DICE\\.FM|\\bDICE\\b|SKIDDLE|STUBHUB|VIAGOGO|TWICKETS|ATG TICKETS|LW THEATRES|NATIONAL THEATRE|BARBICAN|SOUTHBANK CENTRE|ROYAL ALBERT HALL|O2 ARENA|WEMBLEY|TICKET', 'Tickets', 'events'],
  ['ODEON|\\bVUE\\b|CINEWORLD|PICTUREHOUSE|EVERYMAN|CURZON|SHOWCASE CINEMA|CINEMA', 'Cinema', 'cinema'],
  ['HOLLYWOOD BOWL|TENPIN|FLIGHT CLUB|PUTTSHACK|BOXPARK|MERLIN|MADAME TUSSAUDS|LEGOLAND|ALTON TOWERS|THORPE PARK|CHESSINGTON|LONDON EYE|\\bZOO\\b|MUSEUM|GALLERY', 'Days out', 'hobbies'],

  // ── Travel ──
  ['BRITISH A(IR)?W(AYS)?|\\bBA\\.COM\\b', 'British Airways', 'flights'],
  ['EASYJET', 'easyJet', 'flights'],
  ['RYANAIR', 'Ryanair', 'flights'],
  ['\\bJET2\\b', 'Jet2', 'flights'],
  ['WIZZ ?AIR|VIRGIN ATLANTIC|LOGANAIR|AER LINGUS|\\bKLM\\b|LUFTHANSA|EMIRATES|QATAR AIRWAYS|AIR FRANCE|\\bIBERIA\\b|NORWEGIAN AIR|VUELING|TAP AIR|TURKISH AIRLINES|UNITED AIRLINES|DELTA AIR|AMERICAN AIR|ETIHAD|SINGAPORE AIR|CATHAY|AIRLINE', 'Flights', 'flights'],
  ['BOOKING\\.COM', 'Booking.com', 'accommodation'],
  ['AIRBNB', 'Airbnb', 'accommodation'],
  ['HOTELS\\.COM|EXPEDIA|\\bVRBO\\b|AGODA|TRIVAGO', 'Travel booking', 'accommodation'],
  ['PREMIER INN|TRAVELODGE|HILTON|MARRIOTT|\\bIHG\\b|HOLIDAY INN|HYATT|ACCOR|\\bIBIS\\b|NOVOTEL|RADISSON|BEST WESTERN|MERCURE|CROWNE PLAZA|HOTEL', 'Hotel', 'accommodation'],
  ['JET2HOLIDAYS|\\bTUI\\b|LOVEHOLIDAYS|ON THE BEACH|SUNVIL|KUONI|CENTER PARCS|HAVEN|BUTLINS|PARKDEAN|HOSEASONS', 'Holiday', 'holidays'],

  // ── Childcare, charity, education ──
  ['NURSERY|CHILDMINDER|CHILDCARE|AFTER SCHOOL CLUB|TAX-?FREE CHILDCARE', 'Childcare', 'childcare'],
  ['JUSTGIVING|GOFUNDME|CHARITIES AID|\\bCAF (DONATE|BANK|CHARITY)|CANCER RESEARCH|BRITISH HEART|\\bOXFAM\\b|\\bRNLI\\b|MACMILLAN|RED CROSS|SAVE THE CHILDREN|NSPCC|UNICEF|SHELTER|\\bMIND\\b|WATERAID|AMNESTY|GREENPEACE|\\bWWF\\b|DONATION|CHARITY', 'Charity', 'charity'],
  // A university's name alone is not a course: it is paid rent, printing and cafés as well as fees
  // (an accommodation offer, as an agreement, files its rent: agreements.json).
  ['UDEMY|COURSERA|OPEN UNIVERSITY|SKILLSHARE|MASTERCLASS|LINKEDIN LEARNING|EDX|TUITION', 'Education', 'courses'],

  // ── Insurance & professional ──
  ['INSURANCE|\\bINSURE\\b|ADMIRAL|DIRECT LINE|CHURCHILL|HASTINGS DIRECT|\\bLV=|\\bESURE\\b|SHEILAS.? WHEELS|\\bZURICH\\b|SIMPLY BUSINESS|\\bPOLICY\\b', 'Insurance', 'insurance'],
  ['SOLICITOR|ACCOUNTANT|\\bLAW\\b.*(LLP|LTD)|NOTARY|CONVEYANC', 'Professional fees', 'professional-fees'],
];

interface CompiledMerchant {
  re: RegExp;
  payee: string;
  category: string;
  direction?: Direction;
}

const COMPILED: CompiledMerchant[] = MERCHANTS.map(([pattern, payee, category, direction]) => ({
  re: new RegExp(pattern, 'i'),
  payee,
  category,
  ...(direction ? { direction } : {}),
}));

export interface MerchantMatch {
  payee: string;
  category: string;
  index: number;
}

/** First built-in merchant matching the description and the direction of the amount. */
export function matchMerchant(description: string, amount: number): MerchantMatch | undefined {
  const text = normaliseDescription(description);
  const dir: Direction = amount >= 0 ? 'in' : 'out';
  for (let i = 0; i < COMPILED.length; i++) {
    const m = COMPILED[i]!;
    if (m.direction && m.direction !== dir) continue;
    if (m.re.test(text)) return { payee: m.payee, category: m.category, index: i };
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** The HTML entities some exports leave in their text ("RI&amp;C"), as the characters they stand for. */
export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Upper-case, accent-folded, single-spaced, trimmed. Used for matching and dedup keys. */
export function normaliseDescription(description: string): string {
  return decodeEntities(description)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00a0\s]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Built-in payees that describe a kind of payment rather than a brand. For these the name the source
 * gives (e.g. the employer on a salary credit) is more useful, so it is kept when available.
 */
export const GENERIC_PAYEES = new Set([
  'Salary', 'Interest', 'Refund', 'Dividend', 'Cashback', 'Card payment', 'Savings', 'Cash withdrawal',
  'Bank fee', 'Benefits', 'Loan', 'Rent', 'Mortgage', 'Council tax', 'Restaurant', 'Pub', 'Hotel',
  'Parking', 'Rail', 'Bus & coach', 'Fuel', 'Energy', 'Water', 'Broadband', 'Mobile', 'Streaming',
  'Software', 'Membership', 'News', 'Gym', 'Pharmacy', 'Dentist', 'Healthcare', 'Hair & beauty',
  'Clothing', 'Home & garden', 'Discount store', 'Books', 'Kids', 'Gifts', 'Pets', 'Tickets', 'Cinema',
  'Days out', 'Flights', 'Travel booking', 'Holiday', 'Childcare', 'Charity', 'Education', 'Insurance',
  'Professional fees', 'Credit card', 'Marketplace', 'Rapid grocery', 'Veg box', 'Meal kit',
  'EV charging', 'Car maintenance', 'Breakdown cover', 'Road charge', 'Bike & scooter hire',
  'Interest charged', 'Foreign transaction fee', 'App subscription', 'Creator membership',
  'Second-hand fashion', 'Games', 'Opticians', 'Disputed charge', 'Crypto exchange',
]);

/** Aggressively simplified description for fuzzy duplicate detection. */
export function descriptionKey(description: string): string {
  return normaliseDescription(description)
    .replace(/\b(CARD PAYMENT TO|CARD PAYMENT|PAYMENT TO|DIRECT DEBIT( PAYMENT)? TO|DIRECT DEBIT|STANDING ORDER( TO)?|FASTER PAYMENTS?( RECEIVED)?( FROM)?|BILL PAYMENT( TO)?|CONTACTLESS|VIS|POS|DEB|DD|SO|FPI|FPO|BGC|BP|TFR|CR|DR|ON \d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?)\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ACRONYMS = new Set([
  'TFL', 'BP', 'EE', 'O2', 'UK', 'GB', 'HMRC', 'DVLA', 'NHS', 'BT', 'RAC', 'AA', 'NCP', 'JD', 'HSBC', 'TSB',
  'RBS', 'M&S', 'B&Q', 'H&M', 'IKEA', 'ASOS', 'KFC', 'USA', 'EU', 'ATM', 'DWP', 'SLC', 'NS&I', 'ISA', 'LISA',
  'SIPP', 'GWR', 'LNER', 'SWR', 'EDF', 'SSE', 'OVO', 'TV', 'DD', 'SO', 'PAYE', 'VAT', 'ID', 'AJ', 'HL', 'II',
]);

const PAYEE_PREFIXES =
  /^(CARD PAYMENT TO|CARD PAYMENT|PAYMENT TO|DIRECT DEBIT PAYMENT TO|DIRECT DEBIT TO|DIRECT DEBIT|STANDING ORDER TO|STANDING ORDER|FASTER PAYMENTS? (RECEIVED )?(FROM|TO)?|BILL PAYMENT (TO|FROM)?|TRANSFER (TO|FROM)|CONTACTLESS|VIS|POS|DEB|DD|SO|FPI|FPO|BGC|BP|TFR|CHQ|ATM|CPT)\s+/i;
const PAYMENT_PROCESSORS = /^(SQ|SUMUP|SUMUP \*|ZETTLE_?|IZ|CRV|PAYPAL|PP|STRIPE|SP|TST|DNH|WWW|GOOGLE|APPLE PAY|CURVE|LSP|SMP|YOYO)\s*\*\s*/i;

/** How a payment was made: between two people's accounts, by giro credit, by direct debit, or by card. */
export type PaymentVia = 'transfer' | 'giro' | 'direct-debit' | 'card';
/** The ways banks word a payment that put the other party's name inside other words (`paymentParts`). */
const PAYMENT_SHAPES: { re: RegExp; name: number; reference?: number; via: PaymentVia }[] = [
  // Santander: "BILL PAYMENT VIA FASTER PAYMENT TO SAM TAYLOR REFERENCE Dinner , MANDATE NO 12", and
  // the same after "STANDING ORDER" or "THIRD PARTY PAYMENT MADE"; cut short, the reference is lost.
  { re: /^(?:STANDING ORDER|BILL PAYMENT|THIRD PARTY PAYMENT MADE) VIA FASTER PAYMENT TO (.+?) REFERENCE\b ?(.*?) ?(?:, ?MANDATE\b.*)?$/i, name: 1, reference: 2, via: 'transfer' },
  { re: /^(?:STANDING ORDER|BILL PAYMENT|THIRD PARTY PAYMENT MADE) VIA FASTER PAYMENT TO (.+?)(?: ?, ?MANDATE\b.*)?$/i, name: 1, via: 'transfer' },
  // "FASTER PAYMENTS RECEIPT REF.Holiday FROM S TAYLOR": the last FROM, as a reference can hold one.
  { re: /^FASTER PAYMENTS? RECEIPT REF\.? ?(.*) FROM (.+)$/i, name: 2, reference: 1, via: 'transfer' },
  // "BANK GIRO CREDIT REF ACME WIDGETS, 0420 1234 K": the payer, then its reference.
  { re: /^BANK GIRO CREDIT REF (.+?) ?(?:, ?(.*))?$/i, name: 1, reference: 2, via: 'giro' },
  // "DIRECT DEBIT PAYMENT TO EXAMPLE GYM REF GYM123, MANDATE NO 0004".
  { re: /^DIRECT DEBIT PAYMENT TO (.+?) REF\b ?([^,]*?) ?(?:, ?MANDATE\b.*)?$/i, name: 1, reference: 2, via: 'direct-debit' },
  // "EXAMPLE CAFE (VIA APPLE PAY), ON 08-01-2024".
  { re: /^(.+?) ?\(VIA (?:APPLE|GOOGLE) PAY\),?(?: ON \d.*)?$/i, name: 1, via: 'card' },
  // Chase: "Example Hosting Purchase | EUR 24.50 | FX rate £1 = EUR 1.1440", "Example Cafe Purchase".
  { re: /^(.+?) (?:Purchase|Refund)(?: ?\|.*)?$/i, name: 1, via: 'card' },
  { re: /^(.+?) ?\| ?[A-Z]{3} [\d.,]+ ?\| ?FX rate\b.*$/i, name: 1, via: 'card' },
  // Chase: "From Sam's Account - RENT-APRIL", "To Sam Taylor - Savings".
  { re: /^(?:From|To) ([A-Za-z][^|]*?)(?: - (.+))?$/, name: 1, reference: 2, via: 'transfer' },
];

/**
 * The other party and the reference in a payment worded as one of `PAYMENT_SHAPES` (docs/FORMULAS.md
 * §10, "Payees"), or undefined for any other wording. The name is as printed, before tidying.
 */
export function paymentParts(description: string): { name: string; reference?: string; via: PaymentVia } | undefined {
  const text = decodeEntities(description).replace(/[\u00a0\s]+/g, ' ').trim();
  for (const shape of PAYMENT_SHAPES) {
    const m = shape.re.exec(text);
    const name = m?.[shape.name]?.replace(/[\s,.;:-]+$/, '').trim();
    if (!m || !name) continue;
    const reference = shape.reference !== undefined ? m[shape.reference]?.replace(/[\s,.;:]+$/, '').trim() : undefined;
    return { name, ...(reference ? { reference } : {}), via: shape.via };
  }
  return undefined;
}

/** Brands whose name ends in a number, which the tidying below would take for a store number or reference. */
const NUMBERED_BRANDS = /^(TRADING ?212|FOREVER ?21)\b/i;

/**
 * Best-effort merchant name from a raw description when no rule knows it:
 * "CARD PAYMENT TO SQ *THE COFFEE ROOM ON 12/09 LONDON GB" -> "The Coffee Room". A payment worded
 * with the other party inside other words (`paymentParts`) gives that party.
 */
/**
 * A description that says no more than that money went or came: Chase's statement prints some card
 * payments as "Outgoing transaction", where its app names them. It names no one.
 */
export const saysNothing = (description: string) => /^\s*(outgoing|incoming) (transaction|payment)s?\s*$/i.test(description);

/** A card reader's name after the merchant's ("Example Cafe - Zettle / Paypal POS"): who took the card, not who was paid. */
const PROCESSOR_SUFFIX = /\s+-\s+(?:i?Zettle|SumUp|Square|Mollie|CCV Payments)(?:\s*\/\s*Paypal POS)?\s*$|\s+-\s+Paypal POS\s*$/i;

export function cleanPayee(description: string): string {
  let s = decodeEntities(description).replace(/[\u00a0\s]+/g, ' ').trim();
  const parts = paymentParts(s);
  if (parts) s = parts.name;
  const brand = NUMBERED_BRANDS.exec(s.replace(PAYEE_PREFIXES, ''));
  if (brand) return brand[1]!.replace(/([A-Za-z])(\d)/, '$1 $2').replace(/^[A-Za-z]+/, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(PAYEE_PREFIXES, '').replace(PAYMENT_PROCESSORS, '').replace(PROCESSOR_SUFFIX, '');
    if (s === before) break;
  }
  s = s
    .replace(/\s*\([^()]*\bRate:[^()]*\)\s*$/i, '') // Starling's "($3.75, Rate: 1.2810)"
    .replace(/\bON \d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b.*$/i, '') // "ON 12/09 …"
    .replace(/\s+ON \d{1,2} (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b.*$/i, '') // Capital One's "on 01 Sep"
    .replace(/\b\d{1,2}[A-Z]{3}\d{2,4}\b.*$/i, '') // "12SEP26 …"
    .replace(/\s+(GB|GBR|UK|IE|IRL|US|USA|FR|DE|NL|ES|IT|LU)$/i, '') // trailing country
    .replace(/\s+(LONDON|MANCHESTER|BIRMINGHAM|LEEDS|GLASGOW|EDINBURGH|BRISTOL|LIVERPOOL|CARDIFF|BELFAST|INTERNET|WWW\.[A-Z.]+)$/i, '')
    .replace(/\s+\d{3,}.*$/, '') // store numbers / refs
    .replace(/[*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\s+(REF|REFERENCE)\.?$/i, '').trim();
  if (!s) return description.trim();
  // Title-case shouty text, keeping well-known acronyms as they are.
  if (s === s.toUpperCase()) {
    s = s
      .toLowerCase()
      .split(' ')
      .map((w) => {
        const upper = w.toUpperCase();
        if (ACRONYMS.has(upper)) return upper;
        if (upper === 'LTD') return 'Ltd';
        if (upper === 'PLC') return 'plc';
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
  }
  return s.slice(0, 60);
}
