// Thin, typed wrapper over the HTTP API, plus query hooks.

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { signInPath } from './errors';

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
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin', ...(init.signal ? { signal: init.signal } : {}) });
  } catch (err) {
    // Offline, or the server restarting mid-deploy: say so, not the browser's "Failed to fetch".
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('Couldn’t reach Counting House. Check your connection, then try again.', 0, 'network');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (!location.pathname.startsWith('/login')) location.assign(signInPath(location.pathname + location.search));
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
/** `refetchInterval` may depend on the data: refetch while something is still under way. */
export function useApi<T>(key: QueryKey, path: string | null, opts: { refetchInterval?: number | false | ((data: T | undefined) => number | false); enabled?: boolean } = {}) {
  return useQuery<T, ApiError>({
    queryKey: key,
    queryFn: ({ signal }) => api<T>(path!, { signal }),
    enabled: path !== null && opts.enabled !== false,
    placeholderData: keepPreviousData,
    ...(opts.refetchInterval !== undefined ? { refetchInterval: typeof opts.refetchInterval === 'function' ? (q: { state: { data: T | undefined } }) => (opts.refetchInterval as (d: T | undefined) => number | false)(q.state.data) : opts.refetchInterval } : {}),
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
