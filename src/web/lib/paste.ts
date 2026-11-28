// Extracting and normalising files from clipboard paste events (Upload.tsx).

export interface ClipboardItemLike {
  kind: string;
  getAsFile(): File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
}

interface ElementLike {
  nodeType?: number;
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  contentEditable?: string;
  parentElement?: ElementLike | null;
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

const GENERIC_CLIPBOARD_NAME = /^(image|blob|clipboard|pasted)(\.[a-z0-9]{1,5})?$/i;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/plain': 'txt',
};

/** True when paste belongs to a text field or rich-text surface rather than global import. */
export function isEditableElement(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  let el = target as ElementLike | null;
  if (el && el.nodeType === 3) el = el.parentElement ?? null;
  while (el) {
    const tag = el.tagName?.toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.type ?? 'text').toLowerCase();
      if (!NON_TEXT_INPUT_TYPES.has(type)) return true;
    }
    if (el.isContentEditable === true || el.contentEditable === 'true' || el.contentEditable === '') return true;
    el = el.parentElement ?? null;
  }
  return false;
}

/** Direct paste posts straight to /imports on the Import page; everywhere else confirms first. */
export function shouldDirectPaste(pathname: string): boolean {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return clean === '/import';
}

/** Account id when pasting on an account's detail page (`/accounts/:id`), so it can be pre-selected. */
export function accountIdFromPath(pathname: string): string | undefined {
  const m = /^\/accounts\/([^/]+)\/?$/.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}

function extensionFor(file: File): string {
  const fromMime = MIME_EXTENSIONS[file.type.toLowerCase()];
  if (fromMime) return fromMime;
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(file.name.trim())?.[1]?.toLowerCase();
  return fromName ?? 'bin';
}

/**
 * Pull any files or screenshots out of a clipboard payload. Generic browser-synthesised names
 * (`image.png`, `""`) are given a date-free name (`pasted-screenshot.png`) and have synthetic
 * "right now" modification times cleared so ingestion never mistakes the paste moment for when a
 * screenshot was actually taken.
 */
export function clipboardFiles(data: ClipboardDataLike | null | undefined, now = Date.now()): File[] {
  if (!data) return [];
  const raw: File[] = [];
  if (data.items && data.items.length > 0) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (item?.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) raw.push(f);
    }
  } else if (data.files && data.files.length > 0) {
    for (let i = 0; i < data.files.length; i++) {
      const f = data.files[i];
      if (f) raw.push(f);
    }
  }
  if (!raw.length) return [];

  const counts = new Map<string, number>();
  return raw.map((file) => {
    const trimmed = file.name.trim();
    const isGeneric = !trimmed || GENERIC_CLIPBOARD_NAME.test(trimmed);
    if (!isGeneric) return file;
    const ext = extensionFor(file);
    const stem = file.type.startsWith('image/') ? 'pasted-screenshot' : 'pasted-file';
    const key = `${stem}.${ext}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const name = n === 1 ? key : `${stem}-${n}.${ext}`;
    // Clipboard screenshots get lastModified === Date.now(); clearing synthetic timestamps leaves
    // EXIF intact on the server and otherwise honestly marks the date as the upload day.
    const syntheticTime = !file.lastModified || Math.abs(now - file.lastModified) < 5_000;
    const lastModified = syntheticTime ? 0 : file.lastModified;
    return new File([file], name, { type: file.type, lastModified });
  });
}
