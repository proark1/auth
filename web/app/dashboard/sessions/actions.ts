'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/session';
import { ApiError } from '@/lib/api';

export async function revokeSessionAction(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await apiFetch<null>(`/v1/sessions/${id}`, { method: 'DELETE' });
    revalidatePath('/dashboard/sessions');
    revalidatePath('/dashboard');
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
