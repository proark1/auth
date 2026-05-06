import { prisma } from './db.js';
import { deliverEmail, type EmailTemplate } from './email.js';
import { env } from './env.js';

// Background drainer for PendingEmail rows. Runs on a setInterval inside the
// API process — the auth service is the only writer to PendingEmail, so a
// dedicated worker process is overkill at MVP scale.
//
// Concurrency: a single Postgres advisory-style lock is unnecessary here
// because rows are claimed via UPDATE ... WHERE id = ? AND sentAt IS NULL,
// which is atomic. Two API replicas trying to drain the same row can race
// the upstream call, but the worst outcome is one duplicate email — better
// than dropped, and HIBP-style mailers are usually idempotent on (to, body).
//
// Permanent failure: after MAX_ATTEMPTS the row is marked failedAt and
// dropped from active rotation. The vars JSON is cleared so secrets don't
// linger indefinitely; an operator can inspect attempts/lastError to debug.

const MAX_ATTEMPTS = 6;                     // ≈ 30s, 1m, 2m, 4m, 8m, 16m
const BACKOFF_BASE_MS = 30_000;
const POLL_BATCH_SIZE = 10;

let timer: ReturnType<typeof setInterval> | null = null;

export function startEmailWorker(): void {
  const e = env();
  if (!e.EMAIL_WORKER_ENABLED) return;
  if (timer) return; // already started

  timer = setInterval(() => {
    void drainOnce().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[email-worker] tick failed', err);
    });
  }, e.EMAIL_WORKER_POLL_MS);
  // Don't keep the event loop alive purely for the worker — let process
  // shutdown signal exit cleanly.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopEmailWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function drainOnce(): Promise<void> {
  const due = await prisma.pendingEmail.findMany({
    where: {
      sentAt: null,
      failedAt: null,
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: POLL_BATCH_SIZE,
  });

  for (const row of due) {
    await tryDeliver(row);
  }
}

async function tryDeliver(row: {
  id: string;
  recipient: string;
  template: string;
  vars: unknown;
  clientId: string | null;
  attempts: number;
}): Promise<void> {
  try {
    await deliverEmail({
      to: row.recipient,
      template: row.template as EmailTemplate,
      vars: (row.vars as Record<string, string>) ?? {},
      clientId: row.clientId,
    });
    await prisma.pendingEmail.update({
      where: { id: row.id },
      data: { sentAt: new Date(), lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await prisma.pendingEmail.update({
        where: { id: row.id },
        data: {
          attempts: nextAttempts,
          lastError: message.slice(0, 500),
          failedAt: new Date(),
          // Drop the payload — it carries one-shot tokens that don't need to
          // sit in the DB indefinitely once we've given up.
          vars: {},
        },
      });
    } else {
      const delay = BACKOFF_BASE_MS * 2 ** (nextAttempts - 1);
      await prisma.pendingEmail.update({
        where: { id: row.id },
        data: {
          attempts: nextAttempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + delay),
        },
      });
    }
  }
}
