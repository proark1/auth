import Link from 'next/link';
import { logoutAction } from '@/lib/auth-actions';

interface HeaderProps {
  email: string | undefined;
  isAdmin: boolean;
}

export function DashboardHeader({ email, isAdmin }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-6">
        <Link href={isAdmin ? '/admin' : '/dashboard'} className="text-sm font-semibold text-brand">
          myauthservice
          {isAdmin && (
            <span className="ml-2 rounded bg-brand px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
              admin
            </span>
          )}
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {isAdmin && (
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
