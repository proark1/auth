'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { changePasswordAction } from './actions';

export function ChangePassword() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const current = String(data.get('current_password') ?? '');
    const next = String(data.get('new_password') ?? '');
    setBusy(true);
    setMessage(null);
    const result = await changePasswordAction(current, next);
    setBusy(false);
    if (result.ok) {
      setMessage({ tone: 'ok', text: 'Password updated.' });
      form.reset();
    } else {
      setMessage({ tone: 'error', text: result.error ?? 'Update failed.' });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="current_password">Current password</Label>
        <Input
          id="current_password"
          name="current_password"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new_password">New password</Label>
        <Input
          id="new_password"
          name="new_password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
        />
        <span className="text-xs text-slate-500">At least 12 characters.</span>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="accent" disabled={busy}>
          {busy ? 'Updating…' : 'Change password'}
        </Button>
        {message && (
          <p className={message.tone === 'ok' ? 'text-sm text-emerald-600' : 'text-sm text-red-600'}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
