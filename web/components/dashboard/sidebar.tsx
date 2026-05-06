'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export interface SidebarLink {
  href: string;
  label: string;
}

export function Sidebar({ links }: { links: SidebarLink[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 text-sm">
      {links.map((link) => {
        const active =
          pathname === link.href || (link.href !== '/dashboard' && link.href !== '/admin' && pathname.startsWith(link.href));
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              'rounded-md px-3 py-2 transition-colors',
              active ? 'bg-brand text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
