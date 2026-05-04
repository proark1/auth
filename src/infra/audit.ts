import { Prisma } from '@prisma/client';
import { prisma } from './db.js';

// Thin wrapper. Failures here must not break the calling request — log + swallow.
// (We do not want a logging hiccup to take down a login endpoint.)

export interface AuditInput {
  event: string;
  userId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        event: input.event,
        userId: input.userId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata:
          input.metadata === undefined
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write event', input.event, err);
  }
}
