import { useState } from 'react';
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER } from '../../shared/accounts';
import { today } from '../../shared/dates';
import { INSTITUTION_CATALOG } from '../../shared/institutions';
import type { Account, AccountType } from '../../shared/schema';
import { api, useApiMutation } from '../lib/api';
import { useAppData } from '../lib/data';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Textarea, useToast } from './ui';

export function AccountTypeSelect({ value, onChange }: { value: AccountType; onChange: (t: AccountType) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as AccountType)}>
      {ACCOUNT_TYPE_ORDER.map((t) => (
        <option key={t} value={t}>
          {ACCOUNT_TYPE_META[t].label}
        </option>
      ))}
    </Select>
  );
}

export function AccountDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Account }) {
  const { data } = useAppData();
  const toast = useToast();
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'current');
  const [institution, setInstitution] = useState(account?.institutionId ? (data.institutions.find((i) => i.id === account.institutionId)?.name ?? '') : '');
  const [last4, setLast4] = useState(account?.last4 ?? '');
  const [currency, setCurrency] = useState(account?.currency ?? 'GBP');
  const [aliases, setAliases] = useState((account?.aliases ?? []).join(', '));
  const [include, setInclude] = useState(account?.includeInNetWorth ?? true);
  const [flexible, setFlexible] = useState(account?.flexibleIsa ?? false);
  const [pensionMethod, setPensionMethod] = useState(account?.pension?.method ?? '');
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [balance, setBalance] = useState('');
  const [balanceDate, setBalanceDate] = useState(today());
  const meta = ACCOUNT_TYPE_META[type];
  const save = useApiMutation(
    () => {
      const inst = INSTITUTION_CATALOG.find((i) => i.name.toLowerCase() === institution.trim().toLowerCase()) ?? data.institutions.find((i) => i.name.toLowerCase() === institution.trim().toLowerCase());
      const body: Record<string, unknown> = {
        name: name.trim(),
        type,
        currency: currency.trim().toUpperCase() || 'GBP',
        includeInNetWorth: include,
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        ...(inst ? { institutionId: inst.id } : institution.trim() ? { institutionName: institution.trim() } : {}),
        ...(last4.trim() ? { last4: last4.trim() } : account ? { last4: null } : {}),
        ...(meta.isa && type !== 'lisa' ? { flexibleIsa: flexible } : {}),
        ...(meta.pension && pensionMethod ? { pension: { method: pensionMethod } } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      if (!account && balance.trim()) {
        body.balance = Number(balance);
        body.balanceDate = balanceDate;
      }
      return account ? api(`/accounts/${account.id}`, { method: 'PATCH', body }) : api('/accounts', { body });
    },
    {
      onSuccess: () => {
        toast({ tone: 'good', text: account ? 'Account updated' : 'Account added' });
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={account ? `Edit ${account.name}` : 'Add an account'}
      description={account ? undefined : 'Most accounts are created automatically by imports. Add one here for things like property, a pension forecast or cash.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate(undefined)}>
            {account ? 'Save' : 'Add account'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vanguard Stocks & Shares ISA" autoFocus />
        </Field>
        <Field label="Type" hint={meta.description} className="sm:col-span-2">
          <AccountTypeSelect value={type} onChange={setType} />
        </Field>
        <Field label="Provider">
          <Input value={institution} onChange={(e) => setInstitution(e.target.value)} list="institution-list" placeholder="e.g. Monzo" />
          <datalist id="institution-list">
            {[...new Set([...data.institutions.map((i) => i.name), ...INSTITUTION_CATALOG.map((i) => i.name)])].map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        <Field label="Last 4 digits" hint="Used to match statements to this account">
          <Input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
        </Field>
        <Field label="Currency">
          <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
        </Field>
        <Field label="Also appears as" hint="Names in payment descriptions, comma separated (links transfers)">
          <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="e.g. J SMITH SAVER" />
        </Field>
        {meta.pension && type !== 'state_pension' && type !== 'db_pension' && (
          <Field label="How tax relief is given" className="sm:col-span-2">
            <Select value={pensionMethod} onChange={(e) => setPensionMethod(e.target.value)}>
              <option value="">Not sure</option>
              <option value="relief_at_source">Relief at source (SIPPs, most personal pensions)</option>
              <option value="net_pay">Net pay (taken from pay before tax)</option>
              <option value="salary_sacrifice">Salary sacrifice</option>
            </Select>
          </Field>
        )}
        {!account && (
          <>
            <Field label={meta.balanceMode === 'market' ? 'Current value' : 'Current balance'} hint={meta.liability ? 'Amounts owed are negative, e.g. -1200' : undefined}>
              <Input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" placeholder="optional" />
            </Field>
            <Field label="As of">
              <Input type="date" value={balanceDate} onChange={(e) => setBalanceDate(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Checkbox checked={include} onChange={setInclude} label="Include in estate value" />
          {meta.isa && type !== 'lisa' && <Checkbox checked={flexible} onChange={setFlexible} label="Flexible ISA (withdrawals can be replaced in the same tax year)" />}
        </div>
      </div>
      {save.error && <Callout tone="bad" className="mt-3">{save.error.message}</Callout>}
    </Dialog>
  );
}

export function BalanceDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: Account }) {
  const toast = useToast();
  const meta = ACCOUNT_TYPE_META[account.type];
  const [date, setDate] = useState(today());
  const [balance, setBalance] = useState('');
  const [contributions, setContributions] = useState('');
  const [annualIncome, setAnnualIncome] = useState('');
  const [note, setNote] = useState('');
  const [approximate, setApproximate] = useState(false);
  const save = useApiMutation(
    () =>
      api(`/accounts/${account.id}/balances`, {
        body: {
          date,
          balance: Number(balance || 0),
          ...(contributions ? { contributions: Number(contributions) } : {}),
          ...(annualIncome ? { annualIncome: Number(annualIncome) } : {}),
          ...(note ? { note } : {}),
          ...(approximate ? { approximate: true } : {}),
        },
      }),
    {
      onSuccess: () => {
        toast({ tone: 'good', text: 'Balance recorded' });
        onOpenChange(false);
      },
    },
  );
  const forecast = account.type === 'state_pension' || account.type === 'db_pension';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Record ${meta.balanceMode === 'market' ? 'a value' : 'a balance'}`}
      description={account.name}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!balance && !annualIncome} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={forecast ? 'Transfer value (optional)' : meta.balanceMode === 'market' ? 'Value' : 'Balance'} hint={meta.liability ? 'Owed amounts are negative' : undefined}>
          <Input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" autoFocus />
        </Field>
        {meta.balanceMode === 'market' && !forecast && (
          <Field label="Total paid in (optional)">
            <Input value={contributions} onChange={(e) => setContributions(e.target.value)} inputMode="decimal" />
          </Field>
        )}
        {forecast && (
          <Field label="Forecast income per year">
            <Input value={annualIncome} onChange={(e) => setAnnualIncome(e.target.value)} inputMode="decimal" />
          </Field>
        )}
        <Field label="Note" className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox checked={approximate} onChange={setApproximate} label="A rough figure: use it only until statements or screenshots bring real data past this date" />
        </div>
      </div>
      {save.error && <Callout tone="bad" className="mt-3">{save.error.message}</Callout>}
    </Dialog>
  );
}
