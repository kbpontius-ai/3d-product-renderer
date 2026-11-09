import { NextResponse } from 'next/server';
import { route } from '@/lib/server/observability';
import { capturedMail } from '@/lib/server/mailer';
import { devToolingEnabled } from '@/lib/server/dev-only';

/** The development mailbox: what the dev mailer would have sent, newest first. */
async function handleGet() {
  if (!devToolingEnabled()) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  return NextResponse.json({ messages: capturedMail() });
}

export const GET = route('dev/mail', handleGet);
