import 'server-only';
import { systemStatus, type StatusOptions, type SystemStatus } from '@pr/admin/status';
import { CONCERN_TEXT, type JobConcern } from '@pr/job-queue';
import { getSql } from './db';
import { devToolingEnabled } from './dev-only';
import { getStorage } from './storage';
import { serviceCards, overall, type EmailMode, type ServiceCard, type Overall } from '../system-status';

export interface StatusPayload {
  status: SystemStatus;
  cards: ServiceCard[];
  overall: Overall;
  /** Sent with the data because the page's client code cannot import the queue package. */
  concernText: Record<JobConcern, string>;
}

/** Everything the System Status page shows, for the page's first render and for each refresh. */
export async function loadStatus(options: StatusOptions = {}): Promise<StatusPayload> {
  const [status, storage] = await Promise.all([systemStatus(getSql(), options), checkStorage()]);
  const cards = serviceCards({
    status,
    storage,
    email: { ...emailConfiguration(), failures24h: status.events.mailFailures24h },
    web: {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      environment: process.env.NODE_ENV === 'production' ? 'production build' : 'development server',
    },
  });
  return { status, cards, overall: overall(cards), concernText: CONCERN_TEXT };
}

async function checkStorage(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    // The same probe /api/health makes: a miss is a healthy answer; an exception is not.
    await getStorage().has('health/probe');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}

/**
 * Which mail transport this process would use — the rule `getMailer()` applies — without building
 * one. Names the sender, which is public; never the key.
 */
function emailConfiguration(): { mode: EmailMode; sender: string | null } {
  const key = process.env['RESEND_API_KEY']?.trim();
  const sender = process.env['MAIL_FROM']?.trim() || null;
  if (devToolingEnabled() && !key) return { mode: 'dev_mailbox', sender: null };
  if (!key) return { mode: 'none', sender: null };
  if (!sender) return { mode: 'misconfigured', sender: null };
  return { mode: 'resend', sender };
}
