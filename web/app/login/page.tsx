'use client';

import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type State =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'mfa'; mfaToken: string }
  | { status: 'error'; message: string };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next');
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    setState({ status: 'submitting' });
    const url = next ? `/api/auth/login?next=${encodeURIComponent(next)}` : '/api/auth/login';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      redirectTo?: string;
      mfa_required?: boolean;
      mfa_token?: string;
      message?: string;
      code?: string;
    };

    if (res.ok && body.mfa_required && body.mfa_token) {
      setState({ status: 'mfa', mfaToken: body.mfa_token });
      return;
    }
    if (res.ok && body.ok) {
      router.push(body.redirectTo ?? '/dashboard');
      return;
    }
    setState({ status: 'error', message: body.message ?? body.code ?? 'Invalid credentials.' });
  }

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Log in with your email and password.</CardDescription>
        </CardHeader>
        {state.status === 'mfa' ? (
          <CardContent>
            <p className="text-sm text-slate-700">
              Two-factor required. Enter your TOTP code in the app you set up — the dedicated MFA
              page is coming soon. For now, complete the challenge with{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">POST /v1/login/mfa</code>{' '}
              using <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">mfa_token</code>{' '}
              from your session.
            </p>
          </CardContent>
        ) : (
          <form onSubmit={onSubmit}>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/password/forgot"
                    className="text-xs text-brand-accent hover:underline"
                  >
                    Forgot?
                  </Link>
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>
              {state.status === 'error' && (
                <p className="text-sm text-red-600">{state.message}</p>
              )}
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button
                type="submit"
                variant="accent"
                className="w-full"
                disabled={state.status === 'submitting'}
              >
                {state.status === 'submitting' ? 'Logging in…' : 'Log in'}
              </Button>
              <p className="text-sm text-slate-500">
                New here?{' '}
                <Link href="/register" className="text-brand-accent hover:underline">
                  Create an account
                </Link>
              </p>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  );
}
