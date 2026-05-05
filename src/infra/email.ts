import { env } from './env.js';

// HTTP client for the internal email service (mailnowapi).
// Templates live on the email service and are referenced by UUID; we map
// our logical names ('verify_email' | 'password_reset') to template IDs
// from env so the call sites stay readable.

export type EmailTemplate = 'verify_email' | 'password_reset';

export interface SendEmailInput {
  to: string;
  template: EmailTemplate;
  vars: Record<string, string>;
}

const SUBJECTS: Record<EmailTemplate, string> = {
  verify_email: 'Verify your email',
  password_reset: 'Reset your password',
};

function templateIdFor(template: EmailTemplate): string | undefined {
  const e = env();
  return template === 'verify_email' ? e.VERIFY_EMAIL_TEMPLATE_ID : e.PASSWORD_RESET_TEMPLATE_ID;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const e = env();
  const templateId = templateIdFor(input.template);

  if (!e.EMAIL_SERVICE_URL || !e.EMAIL_SERVICE_TOKEN || !e.EMAIL_SERVICE_FROM || !templateId) {
    // In dev / tests the email service may not be configured.
    // Log the payload so flows are still walkable end-to-end.
    // eslint-disable-next-line no-console
    console.warn('[email] email service not fully configured — would have sent:', input);
    return;
  }

  const res = await fetch(`${e.EMAIL_SERVICE_URL.replace(/\/$/, '')}/v1/emails`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${e.EMAIL_SERVICE_TOKEN}`,
    },
    body: JSON.stringify({
      from: e.EMAIL_SERVICE_FROM,
      to: [input.to],
      subject: SUBJECTS[input.template],
      template_id: templateId,
      template_variables: input.vars,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email service responded ${res.status}: ${body.slice(0, 200)}`);
  }
}
