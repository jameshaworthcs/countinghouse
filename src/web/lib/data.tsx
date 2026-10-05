// App-wide reference data (accounts, categories, profile…) and live refresh via server-sent events.

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { BootstrapResponse } from '../../shared/api';
import { CategoryIndex } from '../../shared/categories';
import type { Account } from '../../shared/schema';
import { useApi } from './api';

interface AppData {
  data: BootstrapResponse;
  cats: CategoryIndex;
  accountsById: Map<string, Account>;
  accountName: (id: string | undefined) => string;
}

const DataContext = createContext<AppData | null>(null);

export function DataProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const q = useApi<BootstrapResponse>(['bootstrap'], '/bootstrap');
  const value = useMemo<AppData | null>(() => {
    if (!q.data) return null;
    const accountsById = new Map(q.data.accounts.map((a) => [a.id, a]));
    return {
      data: q.data,
      cats: new CategoryIndex(q.data.categories),
      accountsById,
      accountName: (id) => (id ? (accountsById.get(id)?.name ?? id) : ''),
    };
  }, [q.data]);
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
