import { NextResponse } from 'next/server';
import { auth, ApiError } from '@/lib/api';

export async function POST(req: Request): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as { email?: string; password?: string };
  } catch {
    return NextResponse.json({ code: 'invalid_body' }, { status: 400 });
  }

  if (!body.email || !body.password) {
    return NextResponse.json({ code: 'missing_fields' }, { status: 400 });
  }

  try {
    await auth.register(body.email, body.password);
    return NextResponse.json({ status: 'pending_verification' }, { status: 202 });
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json(err.body, { status: err.status });
    return NextResponse.json({ code: 'upstream_error' }, { status: 502 });
  }
}
