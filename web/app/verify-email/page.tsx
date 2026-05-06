'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type State =
  | { status: 'verifying' }
  | { status: 'verified' }
  | { status: 'missing_token' }
  | { status: 'error'; message: string };

function VerifyInner() {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>(
    token ? { status: 'verifying' } : { status: 'missing_token' },
  );

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setState({ status: 'verified' });
      } else {
        const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
        setState({
          status: 'error',
          message: body.message ?? body.code ?? 'This link is invalid or has expired.',
        });
      }
    })();
  }, [token]);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Verify email</CardTitle>
        <CardDescription>
          {state.status === 'verifying' && 'Confirming your address…'}
          {state.status === 'verified' && 'Your email is verified.'}
          {state.status === 'missing_token' && 'No verification token in the URL.'}
          {state.status === 'error' && 'We couldn’t verify this link.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === 'error' && <p className="text-sm text-red-600">{state.message}</p>}
        {state.status === 'verified' && (
          <p className="text-sm text-slate-700">You can now log in.</p>
        )}
      </CardContent>
      <CardFooter>
        <Link href="/login" className="w-full">
          <Button variant="accent" className="w-full">
            Continue to log in
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <Suspense fallback={<div className="text-sm text-slate-500">Loading…</div>}>
        <VerifyInner />
      </Suspense>
    </main>
  );
}
