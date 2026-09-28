// Getting files in: a drop zone, a picker that works on phones (camera roll), and a page-wide drop
// target so a file dropped anywhere starts an import.

import { useQueryClient } from '@tanstack/react-query';
import { Camera, FileUp, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { cn } from '../lib/format';
import { Button, useToast } from './ui';

export const ACCEPT = '.csv,.tsv,.txt,.ofx,.qfx,.qif,.pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*,application/pdf,text/csv';

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
      <div className="text-[15px] font-semibold text-ink">Drop statements, exports or screenshots</div>
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
