// App-wide reference data (accounts, categories, profile…) and live refresh via server-sent events.

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { BootstrapResponse, CompanyAccountsGroup } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import type { Account, Institution } from '../../shared/schema';
import { useApi } from './api';

interface AppData {
  data: BootstrapResponse;
  cats: CategoryIndex;
  /** Your accounts only: pickers and totals of yours read this. */
  accountsById: Map<string, Account>;
  accountName: (id: string | undefined) => string;
  /**
   * Each company's own accounts, as stored; `null` until they have loaded. Only where an account of
   * either side must be chosen or shown (the import review's "Import into"), never for a figure.
   */
  companyAccounts: { company: { id: string; name: string }; accounts: Account[] }[] | null;
  /** An account of yours or a company's, by id. */
  anyAccount: (id: string | undefined) => Account | undefined;
  /**
   * Every provider: yours (`data.institutions`), then those only a company's accounts are at, each
   * once. For choosing and naming a provider, never for a figure.
   */
  allInstitutions: (Institution & { company?: true })[];
}

const DataContext = createContext<AppData | null>(null);

export function DataProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const q = useApi<BootstrapResponse>(['bootstrap'], '/bootstrap');
  // A company's own accounts are not among yours (`data.accounts`): only their names, so a company
  // account's rows and page can say whose they are.
  const companies = useApi<CompanyAccountsGroup[]>(['company-accounts'], '/company-accounts');
  const value = useMemo<AppData | null>(() => {
    if (!q.data) return null;
    const accountsById = new Map(q.data.accounts.map((a) => [a.id, a]));
    const companyRecords = new Map((companies.data ?? []).flatMap((g) => g.records.map((a) => [a.id, a] as const)));
    return {
      data: q.data,
      cats: new CategoryIndex(q.data.categories),
      accountsById,
      accountName: (id) => (id ? (accountsById.get(id)?.name ?? companyRecords.get(id)?.name ?? id) : ''),
      companyAccounts: companies.data ? companies.data.map((g) => ({ company: { id: g.company.id, name: g.company.name }, accounts: g.records })) : null,
      anyAccount: (id) => (id ? (accountsById.get(id) ?? companyRecords.get(id)) : undefined),
      allInstitutions: [
        ...q.data.institutions,
        ...[...new Map((companies.data ?? []).flatMap((g) => g.providers).filter((i) => !q.data.institutions.some((x) => x.id === i.id)).map((i) => [i.id, { ...i, company: true as const }])).values()],
      ],
    };
  }, [q.data, companies.data]);
  if (!value) return <>{q.error ? <div className="p-6 text-sm text-bad-ink">{q.error.message}</div> : fallback}</>;
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useAppData outside DataProvider');
  return ctx;
}

/** Refetch whenever the server says data changed (imports, edits, external file changes). */
export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('data', () => {
        clearTimeout(timer);
        timer = setTimeout(() => void qc.invalidateQueries(), 150);
      });
      es.addEventListener('job', () => {
        void qc.invalidateQueries({ queryKey: ['jobs'] });
        // History's naming button follows its run, which may end after the names it wrote arrived.
        void qc.invalidateQueries({ queryKey: ['imports', 'history'] });
      });
      es.addEventListener('import', () => {
        void qc.invalidateQueries({ queryKey: ['imports'] });
        void qc.invalidateQueries({ queryKey: ['import'] });
        void qc.invalidateQueries({ queryKey: ['summary'] });
      });
      // A Claude session started, wrote to its transcript, or ended.
      es.addEventListener('session', (ev) => {
        let id: string | undefined;
        try {
          id = (JSON.parse((ev as MessageEvent<string>).data) as { id?: string }).id;
        } catch {
          // no id: refresh them all
        }
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: id ? ['session', id] : ['session'] });
      });
      // A question was asked, took a step, or was answered (Ask).
      es.addEventListener('ask', (ev) => {
        let id: string | undefined;
        try {
          id = (JSON.parse((ev as MessageEvent<string>).data) as { id?: string }).id;
        } catch {
          // no id: refresh them all
        }
        void qc.invalidateQueries({ queryKey: id ? ['ask', id] : ['ask'], exact: Boolean(id) });
        void qc.invalidateQueries({ queryKey: ['ask'], exact: true });
      });
      // The optional live feed took a reading, or failed to: what shows it, and today's figures
      // that count it (the Overview, Accounts, an account's page, Investments), refresh.
      es.addEventListener('feed', () => {
        for (const key of ['feeds', 'summary', 'accounts', 'account', 'investments']) void qc.invalidateQueries({ queryKey: [key] });
      });
      // An agent proposed a fix, or took one back.
      es.addEventListener('proposal', () => {
        void qc.invalidateQueries({ queryKey: ['proposals'] });
        void qc.invalidateQueries({ queryKey: ['proposal'] });
      });
    };
    connect();
    return () => {
      clearTimeout(timer);
      es?.close();
    };
  }, [qc]);
}
