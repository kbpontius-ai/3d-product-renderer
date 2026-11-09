/** Shown when the app runs without a database — the demo editor still works, accounts do not. */
export function NotConfigured() {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <span className="logo" aria-hidden />
        <h1>Accounts are not configured</h1>
        <p className="auth-sub">
          This deployment has no database, so sign-in is unavailable. The demo editor at{' '}
          <a className="auth-link" href="/design/demo">
            /design/demo
          </a>{' '}
          runs entirely in the browser and needs no account.
        </p>
      </div>
    </main>
  );
}
