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

export default function ForgotPasswordPage() {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    setState({ status: 'submitting' });
    const res = await fetch('/api/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      setState({ status: 'sent' });
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      setState({ status: 'error', message: body.message ?? body.code ?? 'Request failed.' });
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Reset password</CardTitle>
          <CardDescription>
            We&apos;ll send you a link to set a new one.
          </CardDescription>
        </CardHeader>
        {state.status === 'sent' ? (
          <CardContent>
            <p className="text-sm text-slate-700">
              If an account with that address exists, a reset link is on its way.
            </p>
          </CardContent>
        ) : (
          <form onSubmit={onSubmit}>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" />
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
                {state.status === 'submitting' ? 'Sending…' : 'Send reset link'}
              </Button>
              <p className="text-sm text-slate-500">
                <Link href="/login" className="text-brand-accent hover:underline">
                  Back to log in
                </Link>
              </p>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  );
}
