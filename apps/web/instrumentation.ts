/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * Node only: the edge runtime has no database driver. The check has to be spelled exactly
 * `process.env.NEXT_RUNTIME === 'nodejs'` around the import — that is the form the bundler replaces
 * at build time, which is what keeps the database driver out of the edge bundle altogether.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installServiceEvents } = await import('./lib/server/service-events');
    installServiceEvents();
  }
}
