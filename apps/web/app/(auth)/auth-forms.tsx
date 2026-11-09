'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The account-lifecycle forms (W-01, W-02).
 *
 * They share one shell and one error vocabulary, because the whole point of the server's coarse
 * error codes is that the client cannot accidentally reveal more than the server intended.
 */

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password combination did not work.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  invite_invalid: 'This invitation link is no longer valid. Ask for a new one.',
  reset_invalid: 'This reset link is no longer valid. Request a new one.',
  password_weak: 'Choose a longer, less predictable password (at least 12 characters).',
  internal: 'Something went wrong on our side. Try again.',
};

/**
 * What is wrong with the password, in words that suggest what to do instead.
 *
 * A breached password is the one worth separating: it may be long, mixed-case and full of symbols,
 * and none of that helps once it is in a list someone is already running.
 */
const PASSWORD_PROBLEMS: Record<string, string> = {
  breached: 'That password has appeared in a data breach. Choose one you have not used elsewhere.',
  too_common: 'That is one of the most commonly used passwords. Choose something else.',
  guessable: 'That password is easier to guess than it looks. A few unrelated words work well.',
  too_short: 'Passwords need at least 12 characters.',
  contains_email: 'Do not build the password out of your email address.',
  contains_site_name: 'Do not build the password out of the name of this site.',
  repetitive: 'Too much of that password is the same few characters repeated.',
  single_character_class: 'Add something other than one kind of character — words, digits, spaces.',
};

function passwordMessage(detail: unknown): string | null {
  const problems = (detail as { problems?: unknown })?.problems;
  if (!Array.isArray(problems)) return null;

  for (const problem of problems) {
    const message = PASSWORD_PROBLEMS[String(problem)];
    if (message) return message;
  }
  return null;
}

async function post(
  url: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true };

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; detail?: unknown };
  };
  const code = payload.error?.code ?? 'internal';
  return {
    ok: false,
    code,
    // The server says which rules were broken; the client turns the first into a sentence.
    message: (code === 'password_weak' ? passwordMessage(payload.error?.detail) : null) ??
      MESSAGES[code] ??
      MESSAGES['internal']!,
  };
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <span className="logo" aria-hidden />
        <h1>{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        {children}
      </div>
    </main>
  );
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post('/api/auth/login', { email, password });
    setBusy(false);
    if (result.ok) router.push(next);
    else setError(result.message);
  }

  return (
    <AuthShell title="Sign in" subtitle="Access is by invitation.">
      <form onSubmit={submit} data-testid="signin-form">
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="password"
          />
        </label>
        {error && (
          <p className="auth-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy} data-testid="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <a className="auth-link" href="/reset">
          Forgot your password?
        </a>
      </form>
    </AuthShell>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await post('/api/auth/invite/accept', { token, password });
    setBusy(false);
    if (result.ok) router.push('/account');
    else setError(result.message);
  }

  return (
    <AuthShell title="Choose a password" subtitle="Clicking your invitation link confirmed your email address.">
      <form onSubmit={submit} data-testid="accept-form">
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="password"
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="confirm"
          />
        </label>
        <p className="auth-hint">At least 12 characters. Longer beats complicated.</p>
        {error && (
          <p className="auth-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy} data-testid="submit">
          {busy ? 'Setting up…' : 'Set password and continue'}
        </button>
      </form>
    </AuthShell>
  );
}

export function RequestResetForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await post('/api/auth/password/forgot', { email });
    setBusy(false);
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell title="Check your email">
        {/* Deliberately unconditional: confirming which addresses exist is an information leak. */}
        <p className="auth-sub" data-testid="reset-sent">
          If that address has an account, a reset link is on its way. The link is valid for one hour.
        </p>
        <a className="auth-link" href="/signin">
          Back to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset your password">
      <form onSubmit={submit} data-testid="forgot-form">
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="email"
          />
        </label>
        <button type="submit" className="primary" disabled={busy} data-testid="submit">
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}

export function CompleteResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post('/api/auth/password/reset', { token, password });
    setBusy(false);
    if (result.ok) router.push('/signin');
    else setError(result.message);
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Every signed-in device will be signed out.">
      <form onSubmit={submit} data-testid="reset-form">
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="password"
          />
        </label>
        {error && (
          <p className="auth-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy} data-testid="submit">
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthShell>
  );
}

/**
 * Signing out, from either of the two places it is offered.
 *
 * The nav's account menu made this component appear twice on `/account` — once in the menu, once
 * as the page's own action — and two elements carrying `data-testid="sign-out"` is a strict-mode
 * violation, not a cosmetic clash. The page keeps the canonical id because it is the page's
 * action; the menu names itself.
 */
export function SignOutButton({ testId = 'sign-out' }: { testId?: string } = {}) {
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/signin');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
