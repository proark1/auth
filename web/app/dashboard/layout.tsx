import type { ReactNode } from 'react';
import { requireSession } from '@/lib/session';
import { DashboardShell } from '@/components/dashboard/shell';

const links = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/security', label: 'Security' },
  { href: '/dashboard/sessions', label: 'Sessions' },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <DashboardShell email={session.email} isAdmin={session.isAdmin} links={links}>
      {children}
    </DashboardShell>
  );
}
