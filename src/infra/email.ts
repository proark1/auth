import { env } from './env.js';
import { prisma } from './db.js';

// HTTP client for the internal email service (mailnowapi).
// Templates live on the email service and are referenced by UUID; we map
// our logical names ('verify_email' | 'password_reset') to template IDs
// from env so the call sites stay readable. When `clientId` is supplied
// and the matching ServiceClient has per-app overrides, we use those for
// the From address and subject; otherwise we fall back to global config.
//
// Failures are durable, not destructive: if the upstream is down or returns
// non-2xx, we persist the message in PendingEmail and return success to the
// caller. The retry worker (src/infra/emailWorker.ts) drains rows whose
// nextAttemptAt has passed. Net effect: a register / reset request never
// fails because the mailer hiccuped.

export type EmailTemplate = 'verify_email' | 'password_reset';

export interface SendEmailInput {
  to: string;
  template: EmailTemplate;
  vars: Record<string, string>;
  // ServiceClient.id (uuid) of the app the user registered through.
  // Optional — when null, global defaults are used.
  clientId?: string | null;
}

const SUBJECTS: Record<EmailTemplate, string> = {
  verify_email: 'Verify your email',
  password_reset: 'Reset your password',
};

function templateIdFor(template: EmailTemplate): string | undefined {
  const e = env();
  return template === 'verify_email' ? e.VERIFY_EMAIL_TEMPLATE_ID : e.PASSWORD_RESET_TEMPLATE_ID;
}

interface ClientBranding {
  fromAddress: string | null;
  verifyEmailSubject: string | null;
  passwordResetSubject: string | null;
}

async function loadClientBranding(clientId: string): Promise<ClientBranding | null> {
  const client = await prisma.serviceClient.findUnique({
    where: { id: clientId },
    select: { fromAddress: true, verifyEmailSubject: true, passwordResetSubject: true },
  });
  return client;
}

interface ResolvedEmail {
  from: string | undefined;
  subject: string;
  templateId: string | undefined;
}

async function resolve(input: SendEmailInput): Promise<ResolvedEmail> {
  const e = env();
  const branding = input.clientId ? await loadClientBranding(input.clientId) : null;
  const from = branding?.fromAddress ?? e.EMAIL_SERVICE_FROM;
  const subject =
    (input.template === 'verify_email'
      ? branding?.verifyEmailSubject
      : branding?.passwordResetSubject) ?? SUBJECTS[input.template];
  return { from, subject, templateId: templateIdFor(input.template) };
}

// Low-level upstream call. Returns void on 2xx, throws on anything else.
// Used both by the synchronous best-effort attempt in sendEmail and by the
// retry worker.
export async function deliverEmail(input: SendEmailInput): Promise<void> {
  const e = env();
  const { from, subject, templateId } = await resolve(input);

  if (!e.EMAIL_SERVICE_URL || !e.EMAIL_SERVICE_TOKEN || !from || !templateId) {
    // In dev / tests the email service may not be configured.
    // eslint-disable-next-line no-console
    console.warn('[email] email service not fully configured — would have sent:', {
      ...input,
      from,
      subject,
    });
    return;
  }

  const res = await fetch(`${e.EMAIL_SERVICE_URL.replace(/\/$/, '')}/v1/emails`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${e.EMAIL_SERVICE_TOKEN}`,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      template_id: templateId,
      template_variables: input.vars,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`email service responded ${res.status}: ${body.slice(0, 200)}`);
  }
}

// Best-effort send. Tries the upstream once synchronously; on any failure,
// persists a PendingEmail row and returns successfully so the caller's flow
// (register, reset, etc) is unaffected. The retry worker handles the rest.
export async function sendEmail(input: SendEmailInput): Promise<void> {
  try {
    await deliverEmail(input);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await prisma.pendingEmail.create({
        data: {
          recipient: input.to,
          template: input.template,
          vars: input.vars as object,
          clientId: input.clientId ?? null,
          attempts: 1,
          lastError: message,
          // First retry in ~30s; the worker applies exponential backoff
          // from then on (see emailWorker.ts BACKOFF_BASE_MS).
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      // eslint-disable-next-line no-console
      console.warn('[email] queued for retry:', { template: input.template, to: input.to, err: message });
    } catch (persistErr) {
      // We failed to send AND failed to persist. Don't throw — the calling
      // flow (e.g. register) shouldn't break because of mailer + DB issues
      // simultaneously, but log loudly so this gets noticed.
      // eslint-disable-next-line no-console
      console.error('[email] send failed AND queue persist failed', {
        sendErr: message,
        persistErr,
      });
    }
  }
}
