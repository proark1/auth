import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill, statusTone } from '@/components/dashboard/pill';
import { apiFetch, requireAdminSession } from '@/lib/session';
import type { AdminUserDetail } from '@/lib/api';
import { UserControls } from './controls';

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, user] = await Promise.all([
    requireAdminSession(),
    apiFetch<AdminUserDetail>(`/v1/admin/users/${id}`),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/users" className="text-sm text-brand-accent hover:underline">
          ← All users
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-brand">{user.email}</h1>
        <p className="font-mono text-xs text-slate-500">{user.id}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <KeyVal label="Email">
              <span>{user.email}</span>
            </KeyVal>
            <KeyVal label="Status">
              <Pill tone={statusTone(user.status)}>{user.status.toLowerCase()}</Pill>
            </KeyVal>
            <KeyVal label="Role">
              <Pill tone={user.role === 'ADMIN' ? 'indigo' : 'slate'}>{user.role.toLowerCase()}</Pill>
            </KeyVal>
            <KeyVal label="Verified">
              {user.emailVerified ? <Pill tone="green">yes</Pill> : <Pill tone="amber">no</Pill>}
            </KeyVal>
            <KeyVal label="Created">
              <span>{new Date(user.createdAt).toLocaleString()}</span>
            </KeyVal>
            <KeyVal label="Registered via">
              <span>{user.registeredClient?.name ?? '—'}</span>
            </KeyVal>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Counts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <KeyVal label="Active sessions">
              <span>{user.sessionCount}</span>
            </KeyVal>
            <KeyVal label="Confirmed MFA factors">
              <span>{user.mfaFactorCount}</span>
            </KeyVal>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Manage</CardTitle>
          <CardDescription>
            Changing role revokes all of this user's active sessions so the change takes effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UserControls
            userId={user.id}
            currentStatus={user.status}
            currentRole={user.role}
            isSelf={user.id === me.userId}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Last 10 audit events for this user.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {user.recentEvents.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No events recorded.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">IP</th>
                </tr>
              </thead>
              <tbody>
                {user.recentEvents.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.event}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.ip ?? '—'}</td>
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

function KeyVal({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  );
}
