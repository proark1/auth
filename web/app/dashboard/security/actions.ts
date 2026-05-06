'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/session';
import { ApiError } from '@/lib/api';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function setupTotpAction(label: string | undefined): Promise<{
  ok: boolean;
  error?: string;
  factor?: { factorId: string; secret: string; otpauthUri: string };
}> {
  try {
    const result = await apiFetch<{ factor_id: string; secret: string; otpauth_uri: string }>(
      '/v1/mfa/totp/setup',
      { method: 'POST', body: JSON.stringify({ label }) },
    );
    return {
      ok: true,
      factor: { factorId: result.factor_id, secret: result.secret, otpauthUri: result.otpauth_uri },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function confirmTotpAction(factorId: string, code: string): Promise<ActionResult> {
  try {
    await apiFetch<null>('/v1/mfa/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({ factor_id: factorId, code }),
    });
    revalidatePath('/dashboard/security');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteTotpAction(factorId: string): Promise<ActionResult> {
  try {
    await apiFetch<null>(`/v1/mfa/totp/${factorId}`, { method: 'DELETE' });
    revalidatePath('/dashboard/security');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function changePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<ActionResult> {
  try {
    await apiFetch<null>('/v1/password/change', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    return { ok: true };
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
