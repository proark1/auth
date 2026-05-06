import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/session';
import type { SessionItem } from '@/lib/api';
import { SessionRow } from './session-row';

export default async function SessionsPage() {
  const sessions = await apiFetch<SessionItem[]>('/v1/sessions');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Sessions</h1>
        <p className="text-sm text-slate-500">Devices currently signed into your account.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Each row is a refresh-token grant. Signing out a session forces that device to log in again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-slate-500">No active sessions.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Device</th>
                  <th className="py-2 pr-4">IP</th>
                  <th className="py-2 pr-4">Last used</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    id={s.id}
                    ip={s.ip}
                    userAgent={s.userAgent}
                    createdAt={s.createdAt}
                    lastUsedAt={s.lastUsedAt}
                    expiresAt={s.expiresAt}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
