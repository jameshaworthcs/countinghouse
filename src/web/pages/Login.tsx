import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../lib/api';
import { Button, Callout, Field, Input } from '../components/ui';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const next = params.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { body: { username, password } });
      await qc.invalidateQueries();
      void navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-2xl border border-line bg-panel p-7 shadow-card">
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <h1 className="text-lg font-semibold text-ink">Finance</h1>
            <p className="text-[13px] text-ink-3">Sign in to continue</p>
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
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
        </div>
      </form>
    </div>
  );
}
