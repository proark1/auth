import Link from 'next/link';
import { logoutAction } from '@/lib/auth-actions';

interface HeaderProps {
  email: string | undefined;
  isAdmin: boolean;
  // Which dashboard the user is currently inside. Drives the cross-link in
  // the header: admins on /dashboard see an "Admin" jump link; admins on
  // /admin see "My account". Non-admins on /dashboard see neither.
  area: 'dashboard' | 'admin';
}

export function DashboardHeader({ email, isAdmin, area }: HeaderProps) {
  const showAdminLink = isAdmin && area === 'dashboard';
  const showAccountLink = area === 'admin';
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-6">
        <Link href={area === 'admin' ? '/admin' : '/dashboard'} className="text-sm font-semibold text-brand">
          myauthservice
          {area === 'admin' && (
            <span className="ml-2 rounded bg-brand px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
              admin
            </span>
          )}
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {showAdminLink && (
            <Link
              href="/admin"
              className="rounded-md border border-brand bg-brand px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-white hover:bg-slate-800"
            >
              Admin
            </Link>
          )}
          {showAccountLink && (
            <Link href="/dashboard" className="text-slate-600 hover:text-slate-900">
              My account
            </Link>
          )}
          <span className="text-slate-500">{email}</span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
