import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/session';
import type { AdminAuditEvent } from '@/lib/api';

interface SearchParams {
  userId?: string;
  event?: string;
  since?: string;
  cursor?: string;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  if (params.userId) qs.set('userId', params.userId);
  if (params.event) qs.set('event', params.event);
  if (params.since) qs.set('since', params.since);
  if (params.cursor) qs.set('cursor', params.cursor);
  const path = `/v1/admin/audit${qs.toString() ? `?${qs}` : ''}`;
  const { events, nextCursor } = await apiFetch<{
    events: AdminAuditEvent[];
    nextCursor: string | null;
  }>(path);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Audit log</h1>
        <p className="text-sm text-slate-500">{events.length} events on this page.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form action="/admin/audit" className="flex flex-wrap items-end gap-3 text-sm">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">User ID</label>
              <input
                name="userId"
                defaultValue={params.userId ?? ''}
                placeholder="UUID"
                className="rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Event contains</label>
              <input
                name="event"
                defaultValue={params.event ?? ''}
                placeholder="login.fail"
                className="rounded-md border border-slate-300 px-3 py-1.5"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Since</label>
              <input
                type="date"
                name="since"
                defaultValue={params.since ?? ''}
                className="rounded-md border border-slate-300 px-3 py-1.5"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Apply
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No events match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">IP</th>
                  <th className="px-4 py-3">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="px-4 py-2 text-slate-500">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.event}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {e.userId ? (
                        <Link href={`/admin/users/${e.userId}`} className="text-brand-accent hover:underline">
                          {e.userId.slice(0, 8)}…
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{e.ip ?? '—'}</td>
                    <td className="px-4 py-2">
                      {e.metadata ? (
                        <code className="text-xs">{JSON.stringify(e.metadata)}</code>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {nextCursor && (
        <div className="flex justify-end">
          <Link
            href={{
              pathname: '/admin/audit',
              query: {
                ...(params.userId ? { userId: params.userId } : {}),
                ...(params.event ? { event: params.event } : {}),
                ...(params.since ? { since: params.since } : {}),
                cursor: nextCursor,
              },
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Next page →
          </Link>
        </div>
      )}
    </div>
  );
}
