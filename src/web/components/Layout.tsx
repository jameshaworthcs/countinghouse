import {
  ArrowLeftRight,
  ChartPie,
  Eye,
  EyeOff,
  Landmark,
  LayoutDashboard,
  Library,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  Sun,
  ScrollText,
  Telescope,
  TrendingUp,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import type { ImportListResponse } from '../../shared/api';
import { api, useApi } from '../lib/api';
import { useAppData, useLiveUpdates } from '../lib/data';
import { cn } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { scrollToTop } from '../lib/scroll';
import { useProposals } from './Proposals';
import { GlobalDrop } from './Upload';
import { IconButton } from './ui';

const NAV: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: <LayoutDashboard className="size-[18px]" />, end: true },
  { to: '/accounts', label: 'Accounts', icon: <Wallet className="size-[18px]" /> },
  { to: '/transactions', label: 'Transactions', icon: <ArrowLeftRight className="size-[18px]" /> },
  { to: '/spending', label: 'Spending', icon: <ChartPie className="size-[18px]" /> },
  { to: '/projections', label: 'Projections', icon: <Telescope className="size-[18px]" /> },
  { to: '/investments', label: 'Investments & pensions', icon: <TrendingUp className="size-[18px]" /> },
  { to: '/tax', label: 'Tax year', icon: <Landmark className="size-[18px]" /> },
  { to: '/assumptions', label: 'Assumptions & research', icon: <Library className="size-[18px]" /> },
  { to: '/import', label: 'Import', icon: <Upload className="size-[18px]" /> },
  { to: '/sessions', label: 'Claude sessions', icon: <ScrollText className="size-[18px]" /> },
  { to: '/settings', label: 'Settings', icon: <Settings className="size-[18px]" /> },
];

function ThemeButton() {
  const { theme, setTheme } = usePrefs();
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;
  return (
    <IconButton label={`Theme: ${theme} (switch to ${next})`} onClick={() => setTheme(next)}>
      <Icon className="size-[18px]" />
    </IconButton>
  );
}

function PrivacyButton() {
  const { privacy, togglePrivacy } = usePrefs();
  return (
    <IconButton label={privacy ? 'Show amounts' : 'Hide amounts (privacy mode)'} onClick={togglePrivacy} className={privacy ? 'bg-accent-soft text-accent' : ''}>
      {privacy ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
    </IconButton>
  );
}

function NavList({ reviewCount, running, onNavigate }: { reviewCount: number; running: number; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end ?? false}
          onClick={(e) => {
            // The page you're on: stay put (keeping its filters) and go back to the top.
            if (pathname === n.to) {
              e.preventDefault();
              scrollToTop();
            }
            onNavigate?.();
          }}
          className={({ isActive }) =>
            cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors', isActive ? 'bg-panel text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:bg-panel-2 hover:text-ink')
          }
        >
          <span className="text-ink-3">{n.icon}</span>
          <span className="flex-1">{n.label}</span>
          {n.to === '/import' && reviewCount > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-5 font-semibold text-white">{reviewCount}</span>}
          {n.to === '/sessions' && running > 0 && (
            <span className="flex items-center gap-1 text-[11.5px] text-ink-3" title={`${running} Claude session${running === 1 ? '' : 's'} running`}>
              <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden />
              {running} running
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export function Layout() {
  useLiveUpdates();
  const { data } = useAppData();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const imports = useApi<ImportListResponse>(['imports'], '/imports', { refetchInterval: 15_000 });
  const proposals = useProposals();
  // Claude at work (a reading, a job): the live stream refreshes it as sessions start and end.
  const sessions = useApi<{ running: number }>(['sessions', 'running'], '/sessions/running', { refetchInterval: 60_000 });
  const running = sessions.data?.running ?? 0;
  // Imports to review and proposed fixes to decide: both wait for you on the Import page.
  const reviewCount = (imports.data?.pending.filter((p) => p.status === 'review' || p.status === 'needs_mapping' || p.status === 'failed').length ?? 0) + (proposals.data?.pending.length ?? 0);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    window.location.assign('/login?signedout=1');
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <GlobalDrop />
      {/* Sidebar (desktop) */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-canvas px-3 py-4 lg:flex">
        <div className="mb-5 flex items-center gap-2 px-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-ink">Finance</div>
            <div className="text-[11.5px] text-ink-3">{data.demo ? 'Demo data' : 'Private · local'}</div>
          </div>
        </div>
        <NavList reviewCount={reviewCount} running={running} />
        <div className="mt-auto flex items-center gap-1 border-t border-line px-1 pt-3">
          <PrivacyButton />
          <ThemeButton />
          {data.user && (
            <IconButton label={`Sign out ${data.user}`} onClick={() => void logout()} className="ml-auto">
              <LogOut className="size-[18px]" />
            </IconButton>
          )}
        </div>
      </aside>

      {/* Top bar (mobile / tablet) */}
      <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-canvas/95 px-3 py-2 backdrop-blur lg:hidden">
        <IconButton label="Menu" onClick={() => setMenuOpen(true)}>
          <Menu className="size-5" />
        </IconButton>
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="font-semibold text-ink">Finance</span>
        </div>
        <div className="ml-auto flex items-center">
          <PrivacyButton />
          <ThemeButton />
        </div>
      </header>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-canvas px-3 py-3 shadow-xl">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="font-semibold text-ink">Finance</span>
              <IconButton label="Close menu" onClick={() => setMenuOpen(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <NavList reviewCount={reviewCount} running={running} onNavigate={() => setMenuOpen(false)} />
            {data.user && (
              <button className="mt-auto flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-ink-2 hover:bg-panel-2" onClick={() => void logout()}>
                <LogOut className="size-4" /> Sign out
              </button>
            )}
          </div>
        </div>
      )}

      <main className="px-4 pt-5 pb-16 sm:px-6 lg:ml-60 lg:px-8 lg:pt-7">
        <div className="mx-auto max-w-[1280px]">
          {/* Demo data says so on every page, so no screenshot of it can pass for anyone's real finances. */}
          {data.demo && (
            <div role="note" className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-ink px-3 py-2 text-[13px] text-ink-inverse">
              <span className="rounded bg-ink-inverse/15 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">Demo data</span>
              <span>An invented person with made-up figures: nothing here is real.</span>
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
