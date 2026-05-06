import type { ReactNode } from 'react';
import { requireAdminSession } from '@/lib/session';
import { DashboardShell } from '@/components/dashboard/shell';

const links = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/audit', label: 'Audit log' },
  { href: '/admin/clients', label: 'Service clients' },
  { href: '/admin/keys', label: 'Signing keys' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requireAdminSession();
  return (
    <DashboardShell email={session.email} isAdmin={session.isAdmin} links={links}>
      {children}
    </DashboardShell>
  );
}
