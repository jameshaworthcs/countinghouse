// What went wrong when a page failed to show, so the error screen can fix it instead of printing it.

/**
 * - `signed-out`: the session ended (an API call answered 401).
 * - `stale-build`: a deploy replaced the page bundles this tab was built against, so loading one it
 *   hadn't opened yet fails (the old hashed file is gone). A reload picks up the new build.
 * - `other`: anything else, a bug or a failed request.
 */
export type PageFailure = 'signed-out' | 'stale-build' | 'other';

// How each browser words a dynamic import (or its preload) that could not be fetched or run.
const STALE_BUILD = [
  /Failed to fetch dynamically imported module/i, // Chrome, Edge
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's preload helper
  /is not a valid JavaScript MIME type/i, // Safari, when index.html comes back in place of the file
];

export function classifyFailure(error: unknown): PageFailure {
  if (typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401) return 'signed-out';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (STALE_BUILD.some((re) => re.test(message))) return 'stale-build';
  return 'other';
}

/** The sign-in page, coming back to `here` (a path plus query) afterwards. */
export function signInPath(here: string): string {
  return `/login?next=${encodeURIComponent(here)}`;
}
