// Getting files in: a drop zone, a picker that works on phones (camera roll), a page-wide drop
// target, and clipboard paste (direct on Import; confirmed via a modal everywhere else).

import { useQueryClient } from '@tanstack/react-query';
import { Camera, FileImage, FileSpreadsheet, FileText, FileUp, Upload } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ACCOUNT_TYPE_META } from '../../shared/accounts';
import { formatDate } from '../../shared/dates';
import { api } from '../lib/api';
import { useAppData } from '../lib/data';
import { cn, fileSize } from '../lib/format';
import { accountIdFromPath, clipboardFiles, isEditableElement, shouldDirectPaste } from '../lib/paste';
import { Button, Dialog, Field, Select, useToast } from './ui';

export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ofx,.qfx,.qif,.pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*,application/pdf,text/csv';

interface UploadResult {
  fileName: string;
  id?: string;
  duplicateOf?: { id: string };
  error?: string;
}

export function useUpload() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const upload = useCallback(
    async (files: File[], opts: { accountId?: string; navigateTo?: boolean } = {}) => {
      if (!files.length) return [];
      setBusy(true);
      try {
        const form = new FormData();
        for (const f of files) {
          form.append('file', f, f.name);
          form.append('lastModified', String(f.lastModified));
        }
        if (opts.accountId) form.append('accountId', opts.accountId);
        const { results } = await api<{ results: UploadResult[] }>('/imports', { body: form });
        void qc.invalidateQueries({ queryKey: ['imports'] });
        const ok = results.filter((r) => r.id).length;
        const dups = results.filter((r) => r.duplicateOf).length;
        const errors = results.filter((r) => r.error);
        if (ok) {
          toast({
            tone: 'good',
            text: `${ok} file${ok > 1 ? 's' : ''} queued for reading`,
            action: opts.navigateTo === false ? undefined : { label: 'Review', onClick: () => void navigate('/import') },
          });
        }
        if (dups) toast({ tone: 'neutral', text: `${dups} file${dups > 1 ? 's were' : ' was'} already imported` });
        for (const e of errors) toast({ tone: 'bad', text: `${e.fileName}: ${e.error}` });
        return results;
      } catch (err) {
        toast({ tone: 'bad', text: (err as Error).message });
        return [];
      } finally {
        setBusy(false);
      }
    },
    [qc, toast, navigate],
  );
  return { upload, busy };
}

export function FilePickerButton({ onFiles, children, accountId, variant = 'secondary', size = 'md', icon }: { onFiles?: (files: File[]) => void; children: ReactNode; accountId?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const { upload, busy } = useUpload();
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (onFiles) onFiles(files);
          else void upload(files, accountId ? { accountId } : {});
        }}
      />
      <Button variant={variant} size={size} loading={busy} icon={icon ?? <Upload className="size-4" />} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}

export function DropZone({ accountId, compact = false }: { accountId?: string; compact?: boolean }) {
  const { upload, busy } = useUpload();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void upload(Array.from(e.dataTransfer.files), accountId ? { accountId, navigateTo: false } : { navigateTo: false });
      }}
      className={cn(
        'no-print flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors',
        compact ? 'px-4 py-5' : 'px-6 py-9',
        over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel hover:bg-panel-2',
      )}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void upload(files, accountId ? { accountId, navigateTo: false } : { navigateTo: false });
        }}
      />
      <FileUp className={cn('mb-2 text-ink-3', compact ? 'size-6' : 'size-8')} aria-hidden />
      <div className="text-[15px] font-semibold text-ink">Drop or paste statements, exports or screenshots</div>
      <div className="mt-1 max-w-md text-[13px] text-ink-3">CSV, OFX, QIF, PDF statements and screenshots of banking, ISA, LISA, SIPP or pension apps. Nothing is saved until you review it.</div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="primary" loading={busy} icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <Button variant="secondary" className="sm:hidden" icon={<Camera className="size-4" />} onClick={() => input.current?.click()}>
          Screenshots
        </Button>
      </div>
    </div>
  );
}

/** Full-window drop target shown while files are dragged over the app. */
export function GlobalDrop() {
  const [active, setActive] = useState(false);
  const { upload } = useUpload();
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      void upload(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [upload]);
  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-accent/10 backdrop-blur-[2px]">
      <div className="rounded-2xl border-2 border-dashed border-accent bg-panel px-10 py-8 text-center shadow-xl">
        <FileUp className="mx-auto mb-2 size-9 text-accent" />
        <div className="text-lg font-semibold text-ink">Drop to import</div>
        <div className="text-sm text-ink-3">Each file becomes a draft for you to review</div>
      </div>
    </div>
  );
}

function PasteFileIcon({ mediaType }: { mediaType: string }) {
  const Icon = mediaType.startsWith('image/') ? FileImage : mediaType === 'application/pdf' ? FileText : FileSpreadsheet;
  return <Icon className="size-5 shrink-0 text-ink-3" aria-hidden />;
}

function PasteConfirmDialog({ files, initialAccountId, onClose }: { files: File[]; initialAccountId?: string; onClose: () => void }) {
  const { data, companyAccounts } = useAppData();
  const { upload, busy } = useUpload();
  const formId = useId();

  const { openPersonal, closedPersonal, companyGroups, eligibleIds } = useMemo(() => {
    const open = data.accounts.filter((a) => a.status === 'open' && !ACCOUNT_TYPE_META[a.type].derived);
    const closed = data.accounts.filter((a) => a.status === 'closed' && !ACCOUNT_TYPE_META[a.type].derived);
    const groups = (companyAccounts ?? []).filter((g) => g.accounts.length > 0);
    const ids = new Set<string>([...open.map((a) => a.id), ...closed.map((a) => a.id), ...groups.flatMap((g) => g.accounts.map((a) => a.id))]);
    return { openPersonal: open, closedPersonal: closed, companyGroups: groups, eligibleIds: ids };
  }, [data.accounts, companyAccounts]);

  const [accountId, setAccountId] = useState(() => (initialAccountId && eligibleIds.has(initialAccountId) ? initialAccountId : ''));
  const [previews, setPreviews] = useState<(string | null)[]>([]);

  useEffect(() => {
    const urls = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null));
    setPreviews(urls);
    return () => {
      for (const u of urls) if (u) URL.revokeObjectURL(u);
    };
  }, [files]);

  const hasAccounts = eligibleIds.size > 0;
  const singleImage = files.length === 1 && files[0]!.type.startsWith('image/');
  const title = files.length === 1 ? (singleImage ? 'Import pasted screenshot' : 'Import pasted file') : `Import ${files.length} pasted files`;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    await upload(files, accountId ? { accountId } : {});
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={title}
      description="Nothing is recorded until you review it on the Import page."
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} autoFocus icon={<Upload className="size-4" />}>
            Import
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4">
        {singleImage ? (
          <div className="flex flex-col gap-2">
            <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-lg border border-line bg-panel-2 p-2">
              {previews[0] && <img src={previews[0]} alt={files[0]!.name} className="max-h-64 w-auto max-w-full rounded object-contain" />}
            </div>
            <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
              <span className="truncate font-medium text-ink-2">{files[0]!.name}</span>
              <span className="shrink-0 tabular-nums">{fileSize(files[0]!.size)}</span>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel-2">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                {previews[i] ? (
                  <img src={previews[i]} alt={f.name} className="size-10 shrink-0 rounded border border-line bg-panel object-cover" />
                ) : (
                  <PasteFileIcon mediaType={f.type} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">{f.name}</div>
                  <div className="text-[12px] text-ink-3 tabular-nums">{fileSize(f.size)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {hasAccounts && (
          <Field label="Account" hint="Leave on automatic matching, or pin directly to one account.">
            <Select value={accountId} disabled={busy} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Match automatically</option>
              {openPersonal.length > 0 && (
                <optgroup label="Your accounts">
                  {openPersonal.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {closedPersonal.length > 0 && (
                <optgroup label="Closed accounts (for their old statements)">
                  {closedPersonal.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.closedOn ? ` (closed ${formatDate(a.closedOn)})` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {companyGroups.map((g) => (
                <optgroup key={g.company.id} label={`${g.company.name}’s accounts (the company’s, not yours)`}>
                  {g.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.status === 'closed' ? ' (closed)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Page-wide paste target for screenshots and files (`Ctrl/⌘+V`). On `/import` it uploads straight
 * away (matching `DropZone`); everywhere else it opens a confirmation modal first so an accidental
 * paste never kicks off extraction silently.
 */
export function GlobalPaste() {
  const location = useLocation();
  const { upload } = useUpload();
  const [pending, setPending] = useState<{ files: File[]; accountId?: string } | null>(null);

  useEffect(() => {
    setPending(null);
  }, [location.pathname]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const files = clipboardFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      if (shouldDirectPaste(location.pathname)) {
        void upload(files, { navigateTo: false });
      } else {
        const accountId = accountIdFromPath(location.pathname);
        setPending(accountId ? { files, accountId } : { files });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [location.pathname, upload]);

  if (!pending) return null;
  return <PasteConfirmDialog files={pending.files} {...(pending.accountId ? { initialAccountId: pending.accountId } : {})} onClose={() => setPending(null)} />;
}
