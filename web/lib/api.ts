// Server-side API client. Called from Next.js Route Handlers (app/api/**).
// Never imported from client components — credentials must not reach the browser.

const apiUrl = (path: string): string => {
  const base = process.env.AUTH_API_URL;
  if (!base) throw new Error('AUTH_API_URL is not set');
  return `${base.replace(/\/$/, '')}${path}`;
};

export interface ApiErrorBody {
  code?: string;
  message?: string;
  issues?: unknown[];
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.code || `auth API ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (body ?? {}) as ApiErrorBody);
  return body as T;
}

export interface LoginTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token_expires_at: string;
}

export interface MfaChallenge {
  mfa_required: true;
  mfa_token: string;
}

export type LoginResult = LoginTokens | MfaChallenge;

export const auth = {
  register: (email: string, password: string) =>
    apiFetch<{ status: 'pending_verification' }>('/v1/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    apiFetch<LoginResult>('/v1/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  verifyEmail: (token: string) =>
    apiFetch<{ status: 'verified' }>('/v1/email/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  forgotPassword: (email: string) =>
    apiFetch<{ status: 'queued' }>('/v1/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, newPassword: string) =>
    apiFetch<{ status: 'reset' }>('/v1/password/reset', {
      method: 'POST',
      body: JSON.stringify({ token, new_password: newPassword }),
    }),
};

export function isMfaChallenge(r: LoginResult): r is MfaChallenge {
  return (r as MfaChallenge).mfa_required === true;
}
