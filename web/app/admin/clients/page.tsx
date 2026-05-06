import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/dashboard/pill';
import { apiFetch } from '@/lib/session';
import type { AdminClient } from '@/lib/api';
import { NewClientForm } from './new-client-form';

interface SearchParams {
  created?: string;
  secret?: string;
  createError?: string;
}

export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const clients = await apiFetch<AdminClient[]>('/v1/admin/clients');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Service clients</h1>
        <p className="text-sm text-slate-500">{clients.length} client{clients.length === 1 ? '' : 's'}.</p>
      </div>

      {params.createError && (
        <Card>
          <CardContent className="p-4 text-sm text-red-700">
            Could not create client: {decodeURIComponent(params.createError)}
          </CardContent>
        </Card>
      )}

      {params.created && params.secret && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader>
            <CardTitle>Copy this secret now</CardTitle>
            <CardDescription>
              This is the only time the plaintext secret is shown. Store it in your consumer service's secret store immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 font-mono text-sm">
            <span className="text-xs uppercase tracking-wide text-slate-500">client_secret</span>
            <code className="break-all rounded bg-white p-2">{decodeURIComponent(params.secret)}</code>
            <Link
              href={`/admin/clients/${decodeURIComponent(params.created)}`}
              className="mt-2 text-xs text-brand-accent hover:underline"
            >
              View this client →
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create a client</CardTitle>
        </CardHeader>
        <CardContent>
          <NewClientForm />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {clients.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No service clients yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">client_id</th>
                  <th className="px-4 py-3">Scopes</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Last used</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link href={`/admin/clients/${c.id}`} className="text-brand-accent hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{c.clientId}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {c.scopes.length === 0 ? '—' : c.scopes.join(', ')}
                    </td>
                    <td className="px-4 py-2">
                      {c.disabled ? <Pill tone="red">disabled</Pill> : <Pill tone="green">active</Pill>}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : 'never'}
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
