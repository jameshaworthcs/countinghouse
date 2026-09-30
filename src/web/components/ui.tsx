// The small component kit every page is built from.

import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Info, LoaderCircle, Minus, TriangleAlert, X } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn, compact as compactMoney, money, pct } from '../lib/format';

// ─── Buttons ─────────────────────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border border-transparent shadow-sm',
  secondary: 'bg-panel text-ink border border-line-strong hover:bg-panel-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-panel-2 hover:text-ink border border-transparent',
  danger: 'bg-panel text-bad-ink border border-line-strong hover:bg-bad-soft',
  subtle: 'bg-panel-2 text-ink hover:bg-panel-3 border border-transparent',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-[15px]' : 'h-9 px-3.5 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn('inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-panel-2 hover:text-ink', className)} {...rest}>
      {children}
    </button>
  );
}

// ─── Surfaces ────────────────────────────────────────────────────────────────────────────────────

export function Card({ title, description, actions, children, className, padded = true, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean; id?: string }) {
  return (
    <section id={id} className={cn('print-plain rounded-xl border border-line bg-panel shadow-card', className)}>
      {(title || actions) && (
        <header className={cn('flex flex-wrap items-start justify-between gap-2', padded ? 'px-5 pt-4' : 'px-5 py-4')}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'muted';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  good: 'bg-good-soft text-good-ink border-transparent',
  warn: 'bg-warn-soft text-warn-ink border-transparent',
  bad: 'bg-bad-soft text-bad-ink border-transparent',
  muted: 'bg-transparent text-ink-3 border-line',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap', BADGE_TONES[tone], className)}>{icon}{children}</span>;
}

/** Status always travels with an icon and a label, never colour alone. */
export function StatusBadge({ status, children }: { status: 'good' | 'warn' | 'bad' | 'info' | 'pending'; children: ReactNode }) {
  const map = {
    good: { tone: 'good' as Tone, icon: <CircleCheck className="size-3.5" aria-hidden /> },
    warn: { tone: 'warn' as Tone, icon: <TriangleAlert className="size-3.5" aria-hidden /> },
    bad: { tone: 'bad' as Tone, icon: <CircleAlert className="size-3.5" aria-hidden /> },
    info: { tone: 'accent' as Tone, icon: <Info className="size-3.5" aria-hidden /> },
    pending: { tone: 'neutral' as Tone, icon: <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> },
  }[status];
  return (
    <Badge tone={map.tone} icon={map.icon}>
      {children}
    </Badge>
  );
}

export function Callout({ tone = 'accent', title, children, className, action }: { tone?: 'accent' | 'good' | 'warn' | 'bad' | 'neutral'; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) {
  const styles = {
    accent: 'bg-accent-soft border-transparent',
    good: 'bg-good-soft border-transparent',
    warn: 'bg-warn-soft border-transparent',
    bad: 'bg-bad-soft border-transparent',
    neutral: 'bg-panel-2 border-line',
  }[tone];
  const Icon = tone === 'good' ? CircleCheck : tone === 'warn' ? TriangleAlert : tone === 'bad' ? CircleAlert : Info;
  const iconColor = { accent: 'text-accent', good: 'text-good-ink', warn: 'text-warn-ink', bad: 'text-bad-ink', neutral: 'text-ink-3' }[tone];
  return (
    <div className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-[13px] text-ink', styles, className)} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title ? 'mt-0.5' : '', 'text-ink-2')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle className={cn('size-5 animate-spin text-ink-3', className)} aria-label={label} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-ink-3" role="status">
      <Spinner className="size-4" /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 text-ink-3">{icon}</div>}
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-[13px] text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** The page numbers to offer: all of them when few, else the first, the last and this page's neighbours; null is a gap. */
function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = [...new Set([1, page - 1, page, page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let last = 0;
  for (const p of keep) {
    // A gap of one page shows that page: "…" would take the same room.
    if (p - last === 2) out.push(last + 1);
    else if (p - last > 2) out.push(null);
    out.push(p);
    last = p;
  }
  return out;
}

/** Numbered pages with previous and next; `children` sits on the left (what this page shows). */
export function Pager({ page, pages, onPage, label, children, className }: { page: number; pages: number; onPage: (page: number) => void; label: string; children?: ReactNode; className?: string }) {
  return (
    <nav aria-label={label} className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1', className)}>
      {children}
      <div className="flex items-center gap-0.5">
        <Button size="sm" variant="ghost" className="px-2" icon={<ChevronLeft className="size-4" />} aria-label="Previous page" title="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} />
        {pageNumbers(page, pages).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="w-6 text-center text-[13px] text-ink-3" aria-hidden>
              …
            </span>
          ) : (
            <Button key={p} size="sm" variant={p === page ? 'subtle' : 'ghost'} className="min-w-8 px-2 tabular-nums" aria-current={p === page ? 'page' : undefined} aria-label={`Page ${p}`} onClick={p === page ? undefined : () => onPage(p)}>
              {p}
            </Button>
          ),
        )}
        <Button size="sm" variant="ghost" className="px-2" icon={<ChevronRight className="size-4" />} aria-label="Next page" title="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </div>
    </nav>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <Callout tone="bad" title="Something went wrong">{error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error'}</Callout>;
}

// ─── Numbers ─────────────────────────────────────────────────────────────────────────────────────

export function Money({ value, currency, compact, sign, colored, className, decimals }: { value: number | null | undefined; currency?: string; compact?: boolean; sign?: boolean; colored?: boolean; className?: string; decimals?: number }) {
  const text = compact ? compactMoney(value) : money(value, { ...(currency ? { currency } : {}), ...(sign ? { sign: true } : {}), ...(decimals !== undefined ? { decimals } : {}) });
  const color = colored && value ? (value > 0 ? 'text-good-ink' : 'text-ink') : '';
  return <span className={cn('sensitive', color, className)}>{text}</span>;
}

/** Signed change with direction icon; colour = direction × whether up is good. */
export function Delta({ value, percent, upIsGood = true, label, className }: { value: number | null | undefined; percent?: number | null; upIsGood?: boolean; label?: ReactNode; className?: string }) {
  if (value === null || value === undefined) return <span className={cn('text-[13px] text-ink-3', className)}>—{label ? <span className="ml-1">{label}</span> : null}</span>;
  const up = value > 0;
  const flat = value === 0;
  const good = flat ? null : up === upIsGood;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[13px] font-medium', good === null ? 'text-ink-3' : good ? 'text-good-ink' : 'text-bad-ink', className)}>
      <Icon className="size-3.5" aria-hidden />
      <span className="sensitive">{money(Math.abs(value))}</span>
      {percent !== undefined && percent !== null && <span className="text-ink-3">({pct(Math.abs(percent))})</span>}
      {label && <span className="ml-1 font-normal text-ink-3">{label}</span>}
    </span>
  );
}

export function Stat({ label, value, sub, delta, trend, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; delta?: ReactNode; trend?: ReactNode; className?: string }) {
  return (
    <div className={cn('print-plain flex min-w-0 flex-col rounded-xl border border-line bg-panel px-4 py-3.5 shadow-card', className)}>
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="mt-1 truncate text-[22px] font-semibold tracking-tight text-ink">{value}</div>
      {(delta || sub) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
          {delta}
          {sub}
        </div>
      )}
      {trend && <div className="mt-2">{trend}</div>}
    </div>
  );
}

// ─── Forms ───────────────────────────────────────────────────────────────────────────────────────

const inputBase = 'h-9 w-full rounded-lg border border-line-strong bg-panel px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputBase, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputBase, 'h-auto min-h-[72px] py-2', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(inputBase, 'appearance-none bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 12 12%27%3E%3Cpath d=%27M3 4.5l3 3 3-3%27 stroke=%27%23898781%27 stroke-width=%271.5%27 fill=%27none%27/%3E%3C/svg%3E")' }} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="text-[12px] text-ink-3">{hint}</span>}
      {error && <span className="text-[12px] text-bad-ink">{error}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, className, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; className?: string; disabled?: boolean; indeterminate?: boolean }) {
  const id = useId();
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        className="size-4 rounded border-line-strong accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label && (
        <label htmlFor={id} className="text-sm text-ink-2">
          {label}
        </label>
      )}
    </span>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span>
        <span className="text-sm font-medium text-ink">{label}</span>
        {description && <span className="block text-[12.5px] text-ink-3">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-panel-3')}
      >
        <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0')} />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: 'sm' | 'md'; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-line bg-panel-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium whitespace-nowrap transition-colors',
            size === 'sm' ? 'px-2 py-0.5 text-[12px]' : 'px-3 py-1 text-[13px]',
            value === o.value ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="scrollbar-thin mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', value === t.value ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────────────────────────

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RDialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-panel shadow-xl',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <RDialog.Title className="text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[13px] text-ink-3">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <IconButton label="Close" className="-mt-1 -mr-2">
                <X className="size-4" />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Drawer({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; children: ReactNode }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-panel shadow-xl">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <RDialog.Title className="truncate text-base font-semibold text-ink">{title}</RDialog.Title>
            <RDialog.Description className="sr-only">Details</RDialog.Description>
            <RDialog.Close asChild>
              <IconButton label="Close">
                <X className="size-4" />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────────────────────────────────────

interface ToastItem {
  id: number;
  tone: 'good' | 'bad' | 'neutral';
  text: ReactNode;
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.action ? 9000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[13px] shadow-lg', t.tone === 'bad' ? 'border-transparent bg-bad-soft text-ink' : 'border-line bg-panel text-ink')}>
            {t.tone === 'good' ? <CircleCheck className="size-4 shrink-0 text-good-ink" /> : t.tone === 'bad' ? <CircleAlert className="size-4 shrink-0 text-bad-ink" /> : <Info className="size-4 shrink-0 text-accent" />}
            <div className="flex-1">{t.text}</div>
            {t.action && (
              <button className="font-medium text-accent hover:underline" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ─── Misc ────────────────────────────────────────────────────────────────────────────────────────

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-panel-2 px-1 py-px font-mono text-[11px] text-ink-3">{children}</kbd>;
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[13px]', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Keeps a debounced copy of a value (for search boxes). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMediaQuery(q: string): boolean {
  const mq = useMemo(() => window.matchMedia(q), [q]);
  const [match, setMatch] = useState(mq.matches);
  useEffect(() => {
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return match;
}

export const tableClasses = {
  table: 'w-full border-collapse text-[13px]',
  th: 'border-b border-line px-3 py-2 text-left text-[12px] font-medium text-ink-3 whitespace-nowrap',
  td: 'border-b border-line px-3 py-2 align-middle text-ink',
  num: 'text-right tabular whitespace-nowrap',
};
