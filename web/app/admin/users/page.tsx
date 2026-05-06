import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill, statusTone } from '@/components/dashboard/pill';
import { apiFetch } from '@/lib/session';
import type { AdminUserListItem } from '@/lib/api';

interface SearchParams {
  query?: string;
  status?: string;
  role?: string;
  cursor?: string;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  if (params.query) qs.set('query', params.query);
  if (params.status) qs.set('status', params.status);
  if (params.role) qs.set('role', params.role);
  if (params.cursor) qs.set('cursor', params.cursor);
  const path = `/v1/admin/users${qs.toString() ? `?${qs}` : ''}`;
  const { users, nextCursor } = await apiFetch<{ users: AdminUserListItem[]; nextCursor: string | null }>(path);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Users</h1>
        <p className="text-sm text-slate-500">{users.length} on this page.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-3 text-sm" action="/admin/users">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Email contains</label>
              <input
                name="query"
                defaultValue={params.query ?? ''}
                className="rounded-md border border-slate-300 px-3 py-1.5"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Status</label>
              <select name="status" defaultValue={params.status ?? ''} className="rounded-md border border-slate-300 px-3 py-1.5">
                <option value="">Any</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="PENDING">PENDING</option>
                <option value="DISABLED">DISABLED</option>
                <option value="LOCKED">LOCKED</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Role</label>
              <select name="role" defaultValue={params.role ?? ''} className="rounded-md border border-slate-300 px-3 py-1.5">
                <option value="">Any</option>
                <option value="USER">USER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </div>
            <button type="submit" className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
              Apply
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No users match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Verified</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link href={`/admin/users/${u.id}`} className="text-brand-accent hover:underline">
                        {u.email}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Pill tone={statusTone(u.status)}>{u.status.toLowerCase()}</Pill>
                    </td>
                    <td className="px-4 py-2">
                      <Pill tone={u.role === 'ADMIN' ? 'indigo' : 'slate'}>{u.role.toLowerCase()}</Pill>
                    </td>
                    <td className="px-4 py-2">
                      {u.emailVerified ? <Pill tone="green">yes</Pill> : <Pill tone="amber">no</Pill>}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{new Date(u.createdAt).toLocaleDateString()}</td>
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
              pathname: '/admin/users',
              query: {
                ...(params.query ? { query: params.query } : {}),
                ...(params.status ? { status: params.status } : {}),
                ...(params.role ? { role: params.role } : {}),
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
