import { NextResponse } from 'next/server';
import { auth, ApiError } from '@/lib/api';

export async function POST(req: Request): Promise<Response> {
  let body: { token?: string; new_password?: string };
  try {
    body = (await req.json()) as { token?: string; new_password?: string };
  } catch {
    return NextResponse.json({ code: 'invalid_body' }, { status: 400 });
  }
  if (!body.token || !body.new_password) {
    return NextResponse.json({ code: 'missing_fields' }, { status: 400 });
  }

  try {
    await auth.resetPassword(body.token, body.new_password);
    return NextResponse.json({ status: 'reset' });
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json(err.body, { status: err.status });
    return NextResponse.json({ code: 'upstream_error' }, { status: 502 });
  }
}
