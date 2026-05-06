import type { ReactNode } from 'react';
import { DashboardHeader } from './header';
import { Sidebar, type SidebarLink } from './sidebar';

interface ShellProps {
  email: string | undefined;
  isAdmin: boolean;
  area: 'dashboard' | 'admin';
  links: SidebarLink[];
  children: ReactNode;
}

// Shared chrome for both /dashboard and /admin: top header (logo + email +
// sign out) plus a left rail of section links.
export function DashboardShell({ email, isAdmin, area, links, children }: ShellProps) {
  return (
    <div className="min-h-screen bg-slate-50">
      <DashboardHeader email={email} isAdmin={isAdmin} area={area} />
      <div className="mx-auto grid max-w-7xl grid-cols-[200px_1fr] gap-8 px-6 py-8">
        <aside>
          <Sidebar links={links} />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
