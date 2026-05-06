import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/session';
import type { AdminStats } from '@/lib/api';

export default async function AdminOverviewPage() {
  const stats = await apiFetch<AdminStats>('/v1/admin/stats');

  const tiles: Array<{ label: string; value: number; sub?: string }> = [
    { label: 'Total users', value: stats.users.total },
    { label: 'Active sessions', value: stats.sessions.active },
    { label: 'Signups (7d)', value: stats.signups7d },
    { label: 'Logins (7d)', value: stats.logins7d },
    { label: 'Failed logins (24h)', value: stats.failedLogins24h },
    { label: 'Admins', value: stats.users.admins },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Admin overview</h1>
        <p className="text-sm text-slate-500">Operational counters across the auth service.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-500">{t.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-semibold text-brand tabular-nums">{t.value.toLocaleString()}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>User breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <Stat label="Active" value={stats.users.active} />
            <Stat label="Pending" value={stats.users.pending} />
            <Stat label="Disabled" value={stats.users.disabled} />
            <Stat label="Locked" value={stats.users.locked} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-xl font-semibold text-brand tabular-nums">{value.toLocaleString()}</dd>
    </div>
  );
}
