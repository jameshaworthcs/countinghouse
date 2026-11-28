// Clipboard paste helpers (src/web/lib/paste.ts).

import { describe, expect, it } from 'vitest';
import { dateFromFileName } from '../src/server/ingest/images';
import { accountIdFromPath, clipboardFiles, isEditableElement, shouldDirectPaste, type ClipboardDataLike } from '../src/web/lib/paste';

function makeClipboard(files: File[], extraItems: { kind: string; getAsFile: () => File | null }[] = []): ClipboardDataLike {
  return {
    items: [...extraItems, ...files.map((f) => ({ kind: 'file', getAsFile: () => f }))],
    files,
  };
}

describe('paste target detection', () => {
  it('treats text inputs, textareas and contenteditable elements as editable', () => {
    expect(isEditableElement({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableElement({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isEditableElement({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isEditableElement({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableElement({ nodeType: 3, parentElement: { tagName: 'DIV', contentEditable: 'true' } })).toBe(true);
  });

  it('allows paste on non-text inputs and ordinary page elements', () => {
    expect(isEditableElement({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isEditableElement({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isEditableElement({ tagName: 'INPUT', type: 'button' })).toBe(false);
    expect(isEditableElement({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableElement({ tagName: 'DIV' })).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe('paste routing', () => {
  it('posts directly only on the Import page', () => {
    expect(shouldDirectPaste('/import')).toBe(true);
    expect(shouldDirectPaste('/import/')).toBe(true);
    expect(shouldDirectPaste('/')).toBe(false);
    expect(shouldDirectPaste('/import/imp_123')).toBe(false);
    expect(shouldDirectPaste('/accounts/monzo')).toBe(false);
  });

  it('reads the account id from an account detail route', () => {
    expect(accountIdFromPath('/accounts/monzo')).toBe('monzo');
    expect(accountIdFromPath('/accounts/monzo/')).toBe('monzo');
    expect(accountIdFromPath('/accounts/my%20isa')).toBe('my isa');
    expect(accountIdFromPath('/accounts')).toBeUndefined();
    expect(accountIdFromPath('/import')).toBeUndefined();
    expect(accountIdFromPath('/')).toBeUndefined();
  });
});

describe('clipboardFiles', () => {
  const now = Date.UTC(2026, 10, 28, 13, 40, 0);

  it('ignores plain-text clipboard payloads', () => {
    const data: ClipboardDataLike = {
      items: [{ kind: 'string', getAsFile: () => null }],
      files: [],
    };
    expect(clipboardFiles(data, now)).toEqual([]);
    expect(clipboardFiles(null, now)).toEqual([]);
  });

  it('renames generic browser screenshots without inventing a filename date and clears synthetic lastModified', () => {
    const raw = new File(['png-bytes'], 'image.png', { type: 'image/png', lastModified: now });
    const files = clipboardFiles(makeClipboard([raw], [{ kind: 'string', getAsFile: () => null }]), now);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('pasted-screenshot.png');
    expect(files[0]!.type).toBe('image/png');
    expect(files[0]!.lastModified).toBe(0);
    // Crucial: must not trigger filename date extraction as if it were taken today.
    expect(dateFromFileName(files[0]!.name)).toBeNull();
  });

  it('numbers multiple unnamed screenshots and names non-image blobs cleanly', () => {
    const a = new File(['a'], '', { type: 'image/png', lastModified: now });
    const b = new File(['b'], 'image.png', { type: 'image/png', lastModified: now });
    const pdf = new File(['%PDF'], 'blob', { type: 'application/pdf', lastModified: now });
    const files = clipboardFiles(makeClipboard([a, b, pdf]), now);
    expect(files.map((f) => f.name)).toEqual(['pasted-screenshot.png', 'pasted-screenshot-2.png', 'pasted-file.pdf']);
    expect(files.every((f) => f.lastModified === 0)).toBe(true);
  });

  it('preserves real filenames and timestamps for files copied from disk', () => {
    const earlier = Date.UTC(2026, 9, 2, 14, 30, 12);
    const csv = new File(['date,amount\n'], 'monzo-2026-10.csv', { type: 'text/csv', lastModified: earlier });
    const files = clipboardFiles(makeClipboard([csv]), now);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(csv);
    expect(files[0]!.name).toBe('monzo-2026-10.csv');
    expect(files[0]!.lastModified).toBe(earlier);
  });

  it('keeps an older lastModified even if a file on disk is literally named image.png', () => {
    const twoDaysAgo = now - 2 * 86_400_000;
    const raw = new File(['png-bytes'], 'image.png', { type: 'image/png', lastModified: twoDaysAgo });
    const files = clipboardFiles(makeClipboard([raw]), now);
    expect(files[0]!.lastModified).toBe(twoDaysAgo);
  });

  it('falls back to clipboardData.files when items is unavailable', () => {
    const raw = new File(['data'], 'statement.pdf', { type: 'application/pdf', lastModified: now - 60_000 });
    const files = clipboardFiles({ files: [raw] }, now);
    expect(files).toEqual([raw]);
  });
});
