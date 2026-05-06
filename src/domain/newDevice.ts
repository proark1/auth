import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail } from '../infra/email.js';
import { env } from '../infra/env.js';

// "We noticed a sign-in from a new device or network" notification.
//
// Detection: a session is "new device" if NO prior session for this user
// (within NEW_DEVICE_WINDOW_DAYS, regardless of revoked state) shared either
// the same IP or the same User-Agent. Two signals because each is independently
// noisy: IPs roll over (mobile carriers, VPNs); UAs change with browser
// updates. Requiring both to differ keeps false positives low.
//
// All failures are swallowed. This is a notification, not a security gate —
// blocking login on a mailer hiccup would be hostile, and the audit log
// already captures every login independently.

interface NotifyInput {
  userId: string;
  email: string;
  ip: string | null;
  userAgent: string | null;
  excludeSessionId?: string | undefined; // skip the session we just created
  registeredClientId?: string | null;
  loggedInVia?: string | undefined;       // 'password' | 'magic_link' | etc — for audit/email
}

export async function notifyIfNewDevice(input: NotifyInput): Promise<void> {
  const e = env();
  if (!e.NEW_DEVICE_EMAIL_ENABLED) return;
  // Without an IP we can't reliably detect — skip rather than spam.
  if (!input.ip) return;

  try {
    const since = new Date(Date.now() - e.NEW_DEVICE_WINDOW_DAYS * 24 * 3600 * 1000);
    const seen = await prisma.session.findFirst({
      where: {
        userId: input.userId,
        createdAt: { gte: since },
        ...(input.excludeSessionId ? { id: { not: input.excludeSessionId } } : {}),
        OR: [
          { ip: input.ip },
          ...(input.userAgent ? [{ userAgent: input.userAgent }] : []),
        ],
      },
      select: { id: true },
    });

    if (seen) {
      // Recognised device — nothing to do.
      return;
    }

    await sendEmail({
      to: input.email,
      template: 'new_device_login',
      vars: {
        ip: input.ip,
        user_agent: input.userAgent ?? 'unknown',
        when: new Date().toISOString(),
        method: input.loggedInVia ?? 'password',
      },
      clientId: input.registeredClientId ?? null,
    });

    await audit({
      event: 'login.new_device.notified',
      userId: input.userId,
      ip: input.ip,
      userAgent: input.userAgent ?? undefined,
      metadata: { method: input.loggedInVia ?? null },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[new-device] notification failed', err);
  }
}
