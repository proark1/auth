import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Pill } from '@/components/dashboard/pill';
import { apiFetch } from '@/lib/session';
import type { MeResponse, SessionItem, MfaFactor } from '@/lib/api';

export default async function DashboardOverviewPage() {
  const [me, sessions, mfa] = await Promise.all([
    apiFetch<MeResponse>('/v1/me'),
    apiFetch<SessionItem[]>('/v1/sessions'),
    apiFetch<{ factors: MfaFactor[] }>('/v1/mfa'),
  ]);

  const confirmedFactors = mfa.factors.filter((f) => f.confirmedAt);
  const memberSince = new Date(me.created_at).toLocaleDateString();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Welcome back</h1>
        <p className="text-sm text-slate-500">Here's a snapshot of your account.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Identity and verification status.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Row label="Email">
              <span>{me.email}</span>
            </Row>
            <Row label="Verified">
              {me.email_verified ? (
                <Pill tone="green">verified</Pill>
              ) : (
                <Pill tone="amber">pending</Pill>
              )}
            </Row>
            <Row label="Status">
              <Pill tone={me.status === 'ACTIVE' ? 'green' : 'slate'}>{me.status.toLowerCase()}</Pill>
            </Row>
            <Row label="Member since">
              <span>{memberSince}</span>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>Two-factor + active sessions.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <Row label="Two-factor">
              {confirmedFactors.length > 0 ? (
                <Pill tone="green">{confirmedFactors.length} factor{confirmedFactors.length === 1 ? '' : 's'}</Pill>
              ) : (
                <Pill tone="amber">off</Pill>
              )}
            </Row>
            <Row label="Active sessions">
              <span>{sessions.length}</span>
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quick actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <ActionLink href="/dashboard/security">Change password</ActionLink>
          <ActionLink href="/dashboard/security">Manage 2FA</ActionLink>
          <ActionLink href="/dashboard/sessions">Review sessions</ActionLink>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
