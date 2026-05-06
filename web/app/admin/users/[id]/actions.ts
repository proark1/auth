'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/session';
import { ApiError, type Role, type UserStatus } from '@/lib/api';

export interface AdminActionResult {
  ok: boolean;
  error?: string;
}

export async function updateUserAction(
  id: string,
  patch: { status?: UserStatus; role?: Role },
): Promise<AdminActionResult> {
  try {
    await apiFetch<null>(`/v1/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function revokeAllSessionsAction(id: string): Promise<AdminActionResult> {
  try {
    await apiFetch<null>(`/v1/admin/users/${id}/sessions/revoke`, { method: 'POST' });
    revalidatePath(`/admin/users/${id}`);
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
