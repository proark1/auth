import { cn } from '@/lib/cn';

const tones = {
  green: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20',
  amber: 'bg-amber-100 text-amber-800 ring-amber-600/20',
  red: 'bg-red-100 text-red-800 ring-red-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  indigo: 'bg-indigo-100 text-indigo-800 ring-indigo-600/20',
} as const;

export type Tone = keyof typeof tones;

export function Pill({ children, tone = 'slate', className }: { children: React.ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'LOCKED'): Tone {
  switch (status) {
    case 'ACTIVE':
      return 'green';
    case 'PENDING':
      return 'amber';
    case 'LOCKED':
    case 'DISABLED':
      return 'red';
  }
}
