import { useQueryClient } from '@tanstack/react-query';
import { Lock, LogIn } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, ApiError, useApi } from '../lib/api';
import { Button, Callout, Field, Input, Loading } from '../components/ui';

interface AuthStatus {
  configured: boolean;
  method: 'oidc' | 'password' | null;
  /** The identity provider's name (FINANCE_OIDC_NAME), when sign-in goes through one. */
  provider: string | null;
  user: string | null;
  /** The demo's throwaway login in a GitHub codespace: only ever set there, over invented data. */
  demoLogin?: { username: string; password: string } | null;
}

/** Why an OIDC sign-in came back here (the callback's ?error= codes), in the provider's name. */
const OIDC_ERRORS: Record<string, (provider: string) => string> = {
  not_allowed: (p) => `${p} signed you in, but not with an account that can use Counting House.`,
  idp_denied: (p) => `${p} didn’t sign you in. You may have cancelled, or your account may not be allowed to use Counting House.`,
  flow_expired: () => 'That sign-in took too long, or was started in another tab. Try again.',
  idp_unreachable: (p) => `Couldn’t reach ${p}. Try again in a moment.`,
  invalid_response: (p) => `${p}’s answer couldn’t be verified. Try again; if it keeps happening, check the server log.`,
};

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-7 shadow-card">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <h1 className="text-lg font-semibold text-ink">Counting House</h1>
            <p className="text-[13px] text-ink-3">Sign in to continue</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const [params] = useSearchParams();
  const status = useApi<AuthStatus>(['auth-status'], '/auth/status');
  const navigate = useNavigate();
  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const signedIn = Boolean(status.data?.user) && !status.isFetching;

  useEffect(() => {
    if (signedIn) void navigate(target, { replace: true });
  }, [signedIn, navigate, target]);

  if (!status.data || signedIn) return <Panel>{status.error ? <Callout tone="bad">{status.error.message}</Callout> : <Loading />}</Panel>;
  if (status.data.method === 'oidc') return <OidcLogin provider={status.data.provider ?? 'your identity provider'} target={target} error={params.get('error')} signedOut={params.has('signedout')} />;
  return <PasswordLogin target={target} signedOut={params.has('signedout')} demoLogin={status.data.demoLogin ?? null} />;
}

/**
 * OIDC: go straight to the provider, unless this visit is to say why the last attempt failed or that
 * you signed out (going straight back would sign you in again, or loop on the same failure).
 */
function OidcLogin({ provider, target, error, signedOut }: { provider: string; target: string; error: string | null; signedOut: boolean }) {
  const href = `/api/auth/oidc/login?next=${encodeURIComponent(target)}`;
  const stay = Boolean(error) || signedOut;
  useEffect(() => {
    if (!stay) window.location.replace(href);
  }, [stay, href]);

  return (
    <Panel>
      <div className="flex flex-col gap-3.5">
        {error && <Callout tone="bad">{OIDC_ERRORS[error]?.(provider) ?? 'Sign-in failed. Try again.'}</Callout>}
        {signedOut && !error && <Callout tone="neutral">You’ve signed out of Counting House. You’re still signed in to {provider}.</Callout>}
        {stay ? (
          <Button variant="primary" size="lg" icon={<LogIn className="size-4" />} className="w-full" onClick={() => window.location.assign(href)}>
            Sign in with {provider}
          </Button>
        ) : (
          <Loading label={`Taking you to ${provider}…`} />
        )}
      </div>
    </Panel>
  );
}

function PasswordLogin({ target, signedOut, demoLogin }: { target: string; signedOut: boolean; demoLogin: AuthStatus['demoLogin'] }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { body: { username, password } });
      // Everything cached so far was fetched signed out, including the auth status RequireAuth
      // checks first. Invalidating isn't enough: that query is inactive while this page shows, so
      // it would keep answering "signed out" and send you straight back to an empty form.
      qc.clear();
      void navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5">
        {signedOut && !error && <Callout tone="neutral">You’ve signed out.</Callout>}
        {demoLogin && (
          <Callout
            tone="accent"
            title="Demo login"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setUsername(demoLogin.username);
                  setPassword(demoLogin.password);
                }}
              >
                Fill in
              </Button>
            }
          >
            <div>
              Username <code className="font-mono text-ink select-all">{demoLogin.username}</code>
            </div>
            <div>
              Password <code className="font-mono whitespace-nowrap text-ink select-all">{demoLogin.password}</code>
            </div>
          </Callout>
        )}
        <Field label="Username">
          <Input autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
        <Button type="submit" variant="primary" size="lg" loading={busy} icon={<Lock className="size-4" />} className="mt-1 w-full">
          Sign in
        </Button>
      </form>
    </Panel>
  );
}
