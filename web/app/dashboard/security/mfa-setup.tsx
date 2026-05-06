'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setupTotpAction, confirmTotpAction } from './actions';

type State =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'enrolling'; factorId: string; secret: string; otpauthUri: string }
  | { kind: 'confirming'; factorId: string; secret: string; otpauthUri: string }
  | { kind: 'error'; message: string };

export function MfaSetup() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const label = String(form.get('label') ?? '').trim() || undefined;
    setState({ kind: 'pending' });
    const result = await setupTotpAction(label);
    if (!result.ok || !result.factor) {
      setState({ kind: 'error', message: result.error ?? 'Setup failed.' });
      return;
    }
    setState({
      kind: 'enrolling',
      factorId: result.factor.factorId,
      secret: result.factor.secret,
      otpauthUri: result.factor.otpauthUri,
    });
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind !== 'enrolling' && state.kind !== 'confirming') return;
    const form = new FormData(e.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    setState({ ...state, kind: 'confirming' });
    const result = await confirmTotpAction(state.factorId, code);
    if (!result.ok) {
      setState({ kind: 'error', message: result.error ?? 'Confirmation failed.' });
      return;
    }
    setState({ kind: 'idle' });
  }

  if (state.kind === 'enrolling' || state.kind === 'confirming') {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
        <p className="text-slate-700">
          Add this account to your authenticator app, then enter the 6-digit code it shows.
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">otpauth URI</span>
          <code className="break-all rounded bg-white p-2 text-xs">{state.otpauthUri}</code>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Secret</span>
          <code className="rounded bg-white p-2 text-xs">{state.secret}</code>
        </div>
        <form onSubmit={confirm} className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="code">6-digit code</Label>
            <Input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required />
          </div>
          <Button type="submit" variant="accent" disabled={state.kind === 'confirming'}>
            {state.kind === 'confirming' ? 'Confirming…' : 'Confirm'}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="label">Label (optional)</Label>
        <Input id="label" name="label" placeholder="iPhone" />
      </div>
      <Button type="submit" variant="accent" disabled={state.kind === 'pending'}>
        {state.kind === 'pending' ? 'Generating…' : 'Add authenticator'}
      </Button>
      {state.kind === 'error' && <p className="text-sm text-red-600">{state.message}</p>}
    </form>
  );
}
