import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/session';
import type { MfaFactor } from '@/lib/api';
import { FactorList } from './factor-list';
import { MfaSetup } from './mfa-setup';
import { ChangePassword } from './change-password';

export default async function SecurityPage() {
  const mfa = await apiFetch<{ factors: MfaFactor[] }>('/v1/mfa');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand">Security</h1>
        <p className="text-sm text-slate-500">Two-factor authentication and password.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Authenticator apps</CardTitle>
          <CardDescription>
            Use an app like 1Password, Authy, or Google Authenticator to generate one-time codes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FactorList factors={mfa.factors} />
          <MfaSetup />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Changing your password keeps existing sessions logged in.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePassword />
        </CardContent>
      </Card>
    </div>
  );
}
