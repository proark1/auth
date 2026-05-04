import { env } from './env.js';

// HTTP client for the internal email service. Templates are rendered server-side
// over there; we just hand it a template name + variables.

export interface SendEmailInput {
  to: string;
  template: 'verify_email' | 'password_reset';
  vars: Record<string, string>;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const e = env();
  if (!e.EMAIL_SERVICE_URL || !e.EMAIL_SERVICE_TOKEN) {
    // In dev / tests the email service may not be configured.
    // Log the payload so flows are still walkable end-to-end.
    // eslint-disable-next-line no-console
    console.warn('[email] EMAIL_SERVICE_URL not set — would have sent:', input);
    return;
  }

  const res = await fetch(`${e.EMAIL_SERVICE_URL.replace(/\/$/, '')}/v1/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${e.EMAIL_SERVICE_TOKEN}`,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email service responded ${res.status}: ${body.slice(0, 200)}`);
  }
}
