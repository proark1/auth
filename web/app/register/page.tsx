'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
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
  | { status: 'sent' }
  | { status: 'error'; message: string };

export default function RegisterPage() {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    setState({ status: 'submitting' });
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      setState({ status: 'sent' });
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      setState({
        status: 'error',
        message: body.message ?? body.code ?? 'Registration failed.',
      });
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            If this email isn&apos;t already registered, we&apos;ll send a verification
            link to confirm your address.
          </CardDescription>
        </CardHeader>
        {state.status === 'sent' ? (
          <CardContent className="flex flex-col gap-3 text-sm text-slate-700">
            <p>
              If this email isn&apos;t already registered, we&apos;ve sent you a verification
              link. Check your inbox (and spam) within a minute or two.
            </p>
            <p>
              Already have an account?{' '}
              <Link href="/login" className="text-brand-accent hover:underline">
                Sign in
              </Link>
              {' '}or{' '}
              <Link href="/password/forgot" className="text-brand-accent hover:underline">
                reset your password
              </Link>
              .
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
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={12}
                />
                <p className="text-xs text-slate-500">At least 12 characters.</p>
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
                {state.status === 'submitting' ? 'Creating…' : 'Create account'}
              </Button>
              <p className="text-sm text-slate-500">
                Already have one?{' '}
                <Link href="/login" className="text-brand-accent hover:underline">
                  Log in
                </Link>
              </p>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  );
}
