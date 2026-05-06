import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill, type Tone } from '@/components/dashboard/pill';
import { apiFetch } from '@/lib/session';
import type { AdminSigningKey } from '@/lib/api';
import { RotateKeyButton } from './rotate-button';

function keyTone(status: AdminSigningKey['status']): Tone {
  switch (status) {
    case 'ACTIVE':
      return 'green';
    case 'RETIRING':
      return 'amber';
    case 'RETIRED':
      return 'slate';
  }
}

export default async function AdminKeysPage() {
  const keys = await apiFetch<AdminSigningKey[]>('/v1/admin/keys');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Signing keys</h1>
        <p className="text-sm text-slate-500">JWT signing key lifecycle.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rotate</CardTitle>
          <CardDescription>
            Generate a new signing key. The current ACTIVE key moves to RETIRING and stays in JWKS so existing tokens
            keep verifying. Use after a suspected key compromise or on a regular schedule.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RotateKeyButton />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {keys.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">
              No keys yet. The first key is generated lazily on the first JWT sign.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">kid</th>
                  <th className="px-4 py-3">alg</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Retired</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{k.kid}</td>
                    <td className="px-4 py-2 font-mono text-xs">{k.alg}</td>
                    <td className="px-4 py-2">
                      <Pill tone={keyTone(k.status)}>{k.status.toLowerCase()}</Pill>
                    </td>
                    <td className="px-4 py-2 text-slate-500">{new Date(k.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {k.retiredAt ? new Date(k.retiredAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
