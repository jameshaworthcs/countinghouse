// Merchant addresses tidied into one line (src/shared/places.ts). The shapes are those card exports
// give; the places are invented.

import { describe, expect, it } from 'vitest';
import { tidyPlace, tidyPostcode, titleCase } from '../src/shared/places';

const UK = 'UNITED KINGDOM OF GB AND NI';
const place = (address: string | undefined, city: string | undefined, postcode: string | undefined, country = UK) => tidyPlace({ ...(address ? { address } : {}), ...(city ? { city } : {}), ...(postcode ? { postcode } : {}), country });

describe('tidy merchant addresses', () => {
  it('joins the lines, sets the case, spaces the postcode and leaves out the UK', () => {
    expect(place('1 EXAMPLE PLACE\nMARKET STREET', 'LONDON', 'EC1A1BB')).toBe('1 Example Place, Market Street, London EC1A 1BB');
    expect(place('123 ST MUNGO STREET', 'GLASGOW', 'M1 1AE')).toBe('123 St Mungo Street, Glasgow M1 1AE');
    expect(place('1 EXAMPLE RIVER PLACE', 'LONDON', 'CR26XH')).toBe('1 Example River Place, London CR2 6XH');
  });

  it('puts back lines wrapped mid-name, and a house number on a line of its own', () => {
    expect(place('EXAMPLE TOWER FIRST FLOOR 2 MARKET\nSTREET', 'LONDON', 'W1A 0AX')).toBe('Example Tower First Floor 2 Market Street, London W1A 0AX');
    expect(place('3\nST ANNE STREET\nKENT', 'MAIDSTONE', 'DN55 1PT')).toBe('3 St Anne Street, Kent, Maidstone DN55 1PT');
  });

  it('a quoted town with its country, a town that is only "UK", a phone number on its own line', () => {
    expect(place('2 OLD MILL ROAD', '"NEWBURY, ENGLAND"', 'B33 8TH')).toBe('2 Old Mill Road, Newbury B33 8TH');
    expect(place('1500 NORTH EXAMPLE STREET', 'UK', 'A00')).toBe('1500 North Example Street, A00');
    expect(place('12 RUE EXEMPLE\n0600000000', undefined, '75000', 'FRANCE')).toBe('12 Rue Exemple, 75000, France');
  });

  it('keeps unit numbers and ordinals readable, and joining words small', () => {
    expect(place('2 EXAMPLE CRESCENT 7TH FLOOR', 'LONDON', 'M1 1AE')).toBe('2 Example Crescent 7th Floor, London M1 1AE');
    expect(place('20B EXAMPLEGATE', 'YORK', 'YO1')).toBe('20B Examplegate, York YO1');
    expect(place('4 EXAMPLE STREET', 'CITY OF LONDON', 'EC1A')).toBe('4 Example Street, City of London EC1A');
    expect(place('PO BOX 123', 'STAINES', 'CR2 6XH')).toBe('PO Box 123, Staines CR2 6XH');
    expect(place('9 THE EXAMPLE', 'YORK', 'DN55 1PT')).toBe('9 The Example, York DN55 1PT');
    expect(titleCase('STRATFORD-UPON-AVON')).toBe('Stratford-upon-Avon');
    expect(titleCase("ST JOHN'S WOOD")).toBe("St John's Wood");
    expect(titleCase("O'CONNELL STREET")).toBe("O'Connell Street");
  });

  it('abroad: the country is kept, and the postcode left as written', () => {
    expect(place('1000 EXAMPLE ST\nSTE 100', 'SAN FRANCISCO', '94000', 'UNITED STATES')).toBe('1000 Example St, Ste 100, San Francisco 94000, United States');
    expect(place('36 EXAMPLE DR\nUNIT 3', 'HAMILTON', 'K1A 0B1', 'CANADA')).toBe('36 Example Dr, Unit 3, Hamilton K1A 0B1, Canada');
    expect(place('38 AVENUE MARIE F. CURIE\nLUXEMBOURG', undefined, 'L-1000', 'LUXEMBOURG')).toBe('38 Avenue Marie F. Curie, L-1000, Luxembourg');
  });

  it('text already in mixed case is left as it is; nothing but the UK is no place', () => {
    expect(tidyPlace({ address: '12 High Street', city: 'London', postcode: 'w1a 0ax', country: 'GBR' })).toBe('12 High Street, London W1A 0AX');
    expect(tidyPlace({ country: UK })).toBeUndefined();
    expect(tidyPlace(undefined)).toBeUndefined();
    expect(tidyPlace({ city: 'LONDON' })).toBe('London');
  });

  it('postcodes: only full UK postcodes get a space', () => {
    expect([tidyPostcode('ec1a1bb'), tidyPostcode('B33 8TH'), tidyPostcode('YO1'), tidyPostcode('94000')]).toEqual(['EC1A 1BB', 'B33 8TH', 'YO1', '94000']);
  });
});

describe('stored transactions get their place, and keep it current', () => {
  it('works it out for history once, then changes nothing', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Store } = await import('../src/server/store');
    const { refreshPlaces } = await import('../src/server/enrich');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-places-'));
    const store = await Store.open(path.join(dir, 'data'));
    try {
      const stamp = '2026-01-01T00:00:00+00:00';
      await store.setAccounts([{ id: 'amex', name: 'Amex', type: 'credit_card', currency: 'GBP', status: 'open', aliases: [], includeInNetWorth: true, createdAt: stamp, updatedAt: stamp }]);
      await store.addTransactions(
        [
          { id: 'tx_00000000000000a1', accountId: 'amex', date: '2026-09-01', amount: -12.5, currency: 'GBP', description: 'AMZNMKTPLACE', merchant: { address: '1 EXAMPLE PLACE\nMARKET STREET', city: 'LONDON', postcode: 'EC1A1BB', country: UK }, source: {} },
          { id: 'tx_00000000000000a2', accountId: 'amex', date: '2026-09-02', amount: -3, currency: 'GBP', description: 'COFFEE', source: {} },
        ],
        'test',
      );
      expect(await refreshPlaces(store)).toBe(1);
      expect(store.transaction('tx_00000000000000a1')!.place).toBe('1 Example Place, Market Street, London EC1A 1BB');
      expect(store.transaction('tx_00000000000000a1')!.merchant!.address).toBe('1 EXAMPLE PLACE\nMARKET STREET');
      expect(await refreshPlaces(store)).toBe(0);
    } finally {
      store.stopWatching();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
