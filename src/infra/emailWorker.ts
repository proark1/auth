import { prisma } from './db.js';
import { deliverEmail, type EmailTemplate } from './email.js';
import { env } from './env.js';

// Background drainer for PendingEmail rows. Runs on a recursive setTimeout
// inside the API process — the auth service is the only writer to
// PendingEmail, so a dedicated worker process is overkill at MVP scale.
//
// Concurrency: each row is *claimed* before the upstream call by pushing
// nextAttemptAt out by VISIBILITY_TIMEOUT_MS, scoped to "still unclaimed
// and still due". updateMany returns count=0 if another replica got there
// first; the loser just skips. Without this, two replicas could both pass
// the SELECT and both call the mailer, producing duplicate emails.
//
// Why setTimeout (not setInterval): a slow drain (mailer-timeout-loop +
// big backlog) could take longer than EMAIL_WORKER_POLL_MS, in which case
// setInterval would queue overlapping ticks and amplify the load. Recursive
// setTimeout always schedules the next poll *after* the previous one
// finished.
//
// Permanent failure: after MAX_ATTEMPTS the row is marked failedAt and
// dropped from active rotation. The vars JSON is cleared so secrets don't
// linger indefinitely; an operator can inspect attempts/lastError to debug.

const MAX_ATTEMPTS = 6;                     // ≈ 30s, 1m, 2m, 4m, 8m, 16m
const BACKOFF_BASE_MS = 30_000;
const POLL_BATCH_SIZE = 10;
// How long a row stays "claimed" before another worker may retry. Should
// comfortably exceed the longest expected upstream call.
const VISIBILITY_TIMEOUT_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

export function startEmailWorker(): void {
  const e = env();
  if (!e.EMAIL_WORKER_ENABLED) return;
  if (!stopped) return; // already running
  stopped = false;

  const tick = () => {
    void drainOnce()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[email-worker] tick failed', err);
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, e.EMAIL_WORKER_POLL_MS);
        // Don't keep the event loop alive purely for the worker.
        if (typeof timer.unref === 'function') timer.unref();
      });
  };

  // First tick after one poll interval, not at boot — gives the rest of the
  // app a moment to settle.
  timer = setTimeout(tick, e.EMAIL_WORKER_POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopEmailWorker(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
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
    select: {
      id: true,
      recipient: true,
      template: true,
      vars: true,
      clientId: true,
      attempts: true,
      nextAttemptAt: true,
    },
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
  nextAttemptAt: Date;
}): Promise<void> {
  // Claim the row by pushing nextAttemptAt into the future. Scoped to the
  // exact (id, current nextAttemptAt) so concurrent workers can't both
  // claim — whoever wins the UPDATE owns delivery for at least
  // VISIBILITY_TIMEOUT_MS.
  const claimed = await prisma.pendingEmail.updateMany({
    where: {
      id: row.id,
      sentAt: null,
      failedAt: null,
      nextAttemptAt: row.nextAttemptAt,
    },
    data: {
      nextAttemptAt: new Date(Date.now() + VISIBILITY_TIMEOUT_MS),
    },
  });
  if (claimed.count === 0) return; // another replica got it

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
          // Replace the visibility-timeout claim with the real backoff value.
          nextAttemptAt: new Date(Date.now() + delay),
        },
      });
    }
  }
}
