// Thin, typed wrapper over the HTTP API, plus query hooks.

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

export async function api<T>(path: string, init: { method?: string; body?: Json | FormData | undefined; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-finance-csrf': '1' };
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', ...(init.signal ? { signal: init.signal } : {}) });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError('Not signed in', 401, 'unauthenticated');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? ((await res.json()) as unknown) : await res.text();
  if (!res.ok) {
    const err = data as { error?: string; code?: string };
    throw new ApiError(err?.error ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** GET with caching; keeps the previous data on screen while refetching (no layout jump). */
export function useApi<T>(key: QueryKey, path: string | null, opts: { refetchInterval?: number | false; enabled?: boolean } = {}) {
  return useQuery<T, ApiError>({
    queryKey: key,
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: path !== null && opts.enabled !== false,
    placeholderData: keepPreviousData,
    ...(opts.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

/** Mutation that refreshes everything afterwards (data changes ripple through every view). */
export function useApiMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>, opts: { onSuccess?: (r: TResult, v: TVars) => void; onError?: (e: ApiError, v: TVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<TResult, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: (r, v) => {
      void qc.invalidateQueries();
      opts.onSuccess?.(r, v);
    },
    ...(opts.onError
      ? {
          onError: (e: ApiError, v: TVars) => {
            void qc.invalidateQueries();
            opts.onError?.(e, v);
          },
        }
      : {}),
  });
}
