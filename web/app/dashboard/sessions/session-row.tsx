'use client';

import { useState, useTransition } from 'react';
import { revokeSessionAction } from './actions';

interface Props {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export function SessionRow(props: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-4">{shortenUa(props.userAgent)}</td>
      <td className="py-2 pr-4 font-mono text-xs">{props.ip ?? '—'}</td>
      <td className="py-2 pr-4">
        {props.lastUsedAt ? new Date(props.lastUsedAt).toLocaleString() : '—'}
      </td>
      <td className="py-2 pr-4">{new Date(props.createdAt).toLocaleString()}</td>
      <td className="py-2 text-right">
        <button
          className="rounded border border-slate-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
          disabled={pending}
          onClick={() => {
            setError(null);
            setPending(true);
            startTransition(async () => {
              const result = await revokeSessionAction(props.id);
              setPending(false);
              if (!result.ok) setError(result.error ?? 'Revoke failed.');
            });
          }}
        >
          {pending ? 'Revoking…' : 'Sign out'}
        </button>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}

function shortenUa(ua: string | null): string {
  if (!ua) return 'Unknown';
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/i);
  return m ? m[0] : ua.slice(0, 40);
}
