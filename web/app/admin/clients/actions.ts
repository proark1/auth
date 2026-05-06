'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/session';
import { ApiError, type AdminCreatedClient } from '@/lib/api';

interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function createClientFormAction(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const scopes = String(formData.get('scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromAddress = String(formData.get('fromAddress') ?? '').trim();
  const verifySubject = String(formData.get('verifyEmailSubject') ?? '').trim();
  const resetSubject = String(formData.get('passwordResetSubject') ?? '').trim();

  const body: Record<string, unknown> = { name, scopes };
  if (fromAddress) body.fromAddress = fromAddress;
  if (verifySubject) body.verifyEmailSubject = verifySubject;
  if (resetSubject) body.passwordResetSubject = resetSubject;

  let created: AdminCreatedClient;
  try {
    created = await apiFetch<AdminCreatedClient>('/v1/admin/clients', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof ApiError ? err.body.message ?? err.body.code ?? 'create failed' : 'create failed';
    redirect(`/admin/clients?createError=${encodeURIComponent(msg)}`);
  }

  revalidatePath('/admin/clients');
  // Pass the one-time secret + new client id back to the page via querystring
  // so we can render a one-shot "copy this now" panel.
  redirect(
    `/admin/clients?created=${encodeURIComponent(created.id)}&secret=${encodeURIComponent(created.clientSecret)}`,
  );
}

export async function updateClientAction(
  id: string,
  patch: {
    name?: string;
    scopes?: string[];
    disabled?: boolean;
    fromAddress?: string | null;
    verifyEmailSubject?: string | null;
    passwordResetSubject?: string | null;
  },
): Promise<ActionResult> {
  try {
    await apiFetch<null>(`/v1/admin/clients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    revalidatePath('/admin/clients');
    revalidatePath(`/admin/clients/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function rotateClientSecretAction(id: string): Promise<{ ok: boolean; error?: string; clientSecret?: string }> {
  try {
    const result = await apiFetch<{ clientSecret: string }>(`/v1/admin/clients/${id}/rotate-secret`, {
      method: 'POST',
    });
    revalidatePath(`/admin/clients/${id}`);
    return { ok: true, clientSecret: result.clientSecret };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.body.message ?? err.body.code ?? 'Request failed.';
  }
  return 'Request failed.';
}
