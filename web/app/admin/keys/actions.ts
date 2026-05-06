'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/session';
import { ApiError } from '@/lib/api';

export async function rotateKeyAction(): Promise<{ ok: boolean; error?: string; kid?: string }> {
  try {
    const result = await apiFetch<{ kid: string }>('/v1/admin/keys/rotate', { method: 'POST' });
    revalidatePath('/admin/keys');
    return { ok: true, kid: result.kid };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: err.body.message ?? err.body.code ?? 'Rotation failed.' };
    }
    return { ok: false, error: 'Rotation failed.' };
  }
}
