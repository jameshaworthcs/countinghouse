import { useState } from 'react';
import { useNavigate } from 'react-router';
import { today } from '../../shared/dates';
import { api, useApiMutation } from '../lib/api';
import { Button, Field, Input } from './ui';

/** Keep a company's books here: its incorporation date is all that is needed to begin. */
export function KeepBooks({ companyId, companyName, onDone }: { companyId: string; companyName: string; onDone?: () => void }) {
  const [inc, setInc] = useState('');
  const [from, setFrom] = useState(today());
  const navigate = useNavigate();
  const keep = useApiMutation(() => api(`/companies/${companyId}/books`, { method: 'PUT', body: { books: { incorporatedOn: inc, periods: [], ctPeriods: [], ...(from ? { deadlinesFrom: from } : {}) }, was: null, company: companyId } }), {
    onSuccess: () => {
      onDone?.();
      void navigate(`/company/${companyId}/settings`);
    },
  });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={`When was ${companyName} incorporated?`}>
        <Input type="date" value={inc} max={today()} onChange={(e) => setInc(e.target.value)} className="w-44" />
      </Field>
      <Field label="List deadlines from" hint="Deadlines due before it are left out (settled before you kept its books here). Change it, or record past filings, in Settings.">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
      </Field>
      <Button variant="primary" disabled={!inc} loading={keep.isPending} onClick={() => keep.mutate(undefined)}>
        Keep its books here
      </Button>
      {keep.error && <span className="text-[12px] text-bad-ink">{keep.error.message}</span>}
    </div>
  );
}
