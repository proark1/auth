'use client';

import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
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
  | { status: 'done' }
  | { status: 'error'; message: string };

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>({ status: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const newPassword = String(new FormData(e.currentTarget).get('new_password') ?? '');
    if (!token) {
      setState({ status: 'error', message: 'No reset token in the URL.' });
      return;
    }
    setState({ status: 'submitting' });
    const res = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    if (res.ok) {
      setState({ status: 'done' });
    } else {
      const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
      setState({
        status: 'error',
        message: body.message ?? body.code ?? 'This link is invalid or has expired.',
      });
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          Once you set it, every existing session will be signed out.
        </CardDescription>
      </CardHeader>
      {state.status === 'done' ? (
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-slate-700">Password updated. Log in to continue.</p>
          <Link href="/login">
            <Button variant="accent" className="w-full">
              Log in
            </Button>
          </Link>
        </CardContent>
      ) : (
        <form onSubmit={onSubmit}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new_password">New password</Label>
              <Input
                id="new_password"
                name="new_password"
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
          <CardFooter>
            <Button
              type="submit"
              variant="accent"
              className="w-full"
              disabled={state.status === 'submitting'}
            >
              {state.status === 'submitting' ? 'Saving…' : 'Save password'}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <Suspense fallback={<div className="text-sm text-slate-500">Loading…</div>}>
        <ResetForm />
      </Suspense>
    </main>
  );
}
