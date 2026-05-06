import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/dashboard/pill';
import { apiFetch } from '@/lib/session';
import type { AdminClient } from '@/lib/api';
import { EditClient } from './edit-client';

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await apiFetch<AdminClient>(`/v1/admin/clients/${id}`);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/clients" className="text-sm text-brand-accent hover:underline">
          ← All clients
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-brand">{client.name}</h1>
        <p className="font-mono text-xs text-slate-500">{client.clientId}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <KeyVal label="Status">
              {client.disabled ? <Pill tone="red">disabled</Pill> : <Pill tone="green">active</Pill>}
            </KeyVal>
            <KeyVal label="Created">
              <span>{new Date(client.createdAt).toLocaleString()}</span>
            </KeyVal>
            <KeyVal label="Last used">
              <span>{client.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : 'never'}</span>
            </KeyVal>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Manage</CardTitle>
          <CardDescription>
            Disable instead of deleting — token issuance for a disabled client returns 401 immediately. Rotation
            invalidates the previous secret.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EditClient client={client} />
        </CardContent>
      </Card>
    </div>
  );
}

function KeyVal({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  );
}
