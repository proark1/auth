'use client';

import { useState, useTransition } from 'react';
import type { MfaFactor } from '@/lib/api';
import { Pill } from '@/components/dashboard/pill';
import { deleteTotpAction } from './actions';

export function FactorList({ factors }: { factors: MfaFactor[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (factors.length === 0) {
    return <p className="text-sm text-slate-500">No authenticator app set up yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {factors.map((f) => (
        <div
          key={f.id}
          className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3 text-sm"
        >
          <div className="flex flex-col">
            <span className="font-medium">{f.label ?? 'Authenticator'}</span>
            <span className="text-xs text-slate-500">
              {f.type} · added {new Date(f.createdAt).toLocaleDateString()}
              {f.lastUsedAt && ` · last used ${new Date(f.lastUsedAt).toLocaleDateString()}`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {f.confirmedAt ? <Pill tone="green">active</Pill> : <Pill tone="amber">unconfirmed</Pill>}
            <button
              className="rounded border border-slate-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              disabled={pendingId === f.id}
              onClick={() => {
                setError(null);
                setPendingId(f.id);
                startTransition(async () => {
                  const result = await deleteTotpAction(f.id);
                  setPendingId(null);
                  if (!result.ok) setError(result.error ?? 'Delete failed.');
                });
              }}
            >
              {pendingId === f.id ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ))}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
