'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdminClient } from '@/lib/api';
import { rotateClientSecretAction, updateClientAction } from '../actions';

export function EditClient({ client }: { client: AdminClient }) {
  const [name, setName] = useState(client.name);
  const [scopes, setScopes] = useState(client.scopes.join(', '));
  const [fromAddress, setFromAddress] = useState(client.fromAddress ?? '');
  const [verifySubject, setVerifySubject] = useState(client.verifyEmailSubject ?? '');
  const [resetSubject, setResetSubject] = useState(client.passwordResetSubject ?? '');
  const [disabled, setDisabled] = useState(client.disabled);

  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [pending, setPending] = useState<'save' | 'rotate' | null>(null);
  const [, startTransition] = useTransition();

  function save() {
    setMessage(null);
    setPending('save');
    startTransition(async () => {
      const patch = {
        name,
        scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
        disabled,
        fromAddress: fromAddress.trim() || null,
        verifyEmailSubject: verifySubject.trim() || null,
        passwordResetSubject: resetSubject.trim() || null,
      };
      const result = await updateClientAction(client.id, patch);
      setPending(null);
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? 'Update failed.' });
      else setMessage({ tone: 'ok', text: 'Saved.' });
    });
  }

  function rotate() {
    if (!confirm('Rotate this client\'s secret? The previous secret will stop working immediately.')) return;
    setMessage(null);
    setPending('rotate');
    startTransition(async () => {
      const result = await rotateClientSecretAction(client.id);
      setPending(null);
      if (!result.ok || !result.clientSecret) {
        setMessage({ tone: 'error', text: result.error ?? 'Rotation failed.' });
        return;
      }
      setRotated(result.clientSecret);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {rotated && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-4 font-mono text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-600">New client_secret (shown once)</span>
          <code className="break-all rounded bg-white p-2">{rotated}</code>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Scopes (comma-separated)">
          <Input value={scopes} onChange={(e) => setScopes(e.target.value)} />
        </Field>
        <Field label="From address">
          <Input
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="(falls back to global)"
          />
        </Field>
        <Field label="Verify subject">
          <Input
            value={verifySubject}
            onChange={(e) => setVerifySubject(e.target.value)}
            placeholder="(falls back to global)"
          />
        </Field>
        <Field label="Reset subject">
          <Input
            value={resetSubject}
            onChange={(e) => setResetSubject(e.target.value)}
            placeholder="(falls back to global)"
          />
        </Field>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
              className="h-4 w-4"
            />
            Disabled
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" onClick={save} disabled={pending === 'save'}>
          {pending === 'save' ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="outline" onClick={rotate} disabled={pending === 'rotate'}>
          {pending === 'rotate' ? 'Rotating…' : 'Rotate secret'}
        </Button>
        {message && (
          <p className={message.tone === 'ok' ? 'text-sm text-emerald-600' : 'text-sm text-red-600'}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
