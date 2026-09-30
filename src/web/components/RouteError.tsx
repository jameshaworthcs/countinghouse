// The screen for a page that failed to show, in place of React Router's developer error page. It
// sends you to sign in when the session has ended and reloads onto a new build after a deploy; only
// what neither explains is shown, in plain words with the details folded away.

import { Home, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouteError } from 'react-router';
import { api } from '../lib/api';
import { classifyFailure, signInPath } from '../lib/errors';
import { Button, Loading } from './ui';

// One automatic reload per stale build: if the page still fails straight after, show the error
// rather than reload forever.
const RELOADED_KEY = 'finance:stale-build-reload';
const RELOAD_WINDOW_MS = 30_000;

function reloadedRecently(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem(RELOADED_KEY) ?? 0) < RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    // No storage: the reload still happens; a second failure then shows the error.
  }
}

const here = () => location.pathname + location.search;

export function RouteError() {
  const error = useRouteError();
  const failure = classifyFailure(error);
  // 'checking': asking the server whether the session is still good before showing an error.
  const [state, setState] = useState<'redirecting' | 'checking' | 'failed'>(() => (failure === 'signed-out' || (failure === 'stale-build' && !reloadedRecently()) ? 'redirecting' : 'checking'));

  useEffect(() => {
    if (state === 'redirecting') {
      if (failure === 'signed-out') {
        location.assign(signInPath(here()));
      } else {
        markReloaded();
        location.reload();
      }
      return;
    }
    if (state !== 'checking') return;
    let live = true;
    // Whatever broke, an ended session is the likely cause and the one the owner can't fix by
    // reading the error, so check it first.
    api<{ configured: boolean; user: string | null }>('/auth/status')
      .then((s) => {
        if (!live) return;
        if (s.configured && !s.user) location.assign(signInPath(here()));
        else setState('failed');
      })
      .catch(() => live && setState('failed'));
    return () => {
      live = false;
    };
  }, [state, failure]);

  if (state !== 'failed') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <Loading label={failure === 'stale-build' ? 'Finance has been updated. Loading the new version…' : failure === 'signed-out' ? 'Taking you to sign in…' : 'Loading…'} />
      </div>
    );
  }

  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-card" role="alert">
        <h1 className="text-lg font-semibold text-ink">This page couldn’t be shown</h1>
        <p className="mt-1.5 text-sm text-ink-2">Something went wrong while loading it. Reloading usually fixes it; your data is safe either way.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" icon={<RotateCw className="size-4" />} onClick={() => location.reload()}>
            Reload
          </Button>
          <Button icon={<Home className="size-4" />} onClick={() => location.assign('/')}>
            Go to Overview
          </Button>
        </div>
        {detail && (
          <details className="mt-5 text-[12.5px] text-ink-3">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <p className="mt-2 break-words font-mono">{detail}</p>
          </details>
        )}
      </div>
    </div>
  );
}
