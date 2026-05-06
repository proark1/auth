'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { rotateKeyAction } from './actions';

export function RotateKeyButton() {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [, startTransition] = useTransition();

  function rotate() {
    if (
      !confirm(
        'Rotate signing key now?\n\nThe current ACTIVE key will move to RETIRING (still usable for verification of in-flight tokens). A fresh key will be generated and become ACTIVE. Existing access tokens stay valid until they expire.',
      )
    ) {
      return;
    }
    setMessage(null);
    setPending(true);
    startTransition(async () => {
      const result = await rotateKeyAction();
      setPending(false);
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? 'Rotation failed.' });
      else setMessage({ tone: 'ok', text: `New ACTIVE kid: ${result.kid}` });
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="accent" onClick={rotate} disabled={pending}>
        {pending ? 'Rotating…' : 'Rotate now'}
      </Button>
      {message && (
        <p className={message.tone === 'ok' ? 'text-sm text-emerald-600' : 'text-sm text-red-600'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
