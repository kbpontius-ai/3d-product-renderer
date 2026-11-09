'use client';

import { useEffect, useState } from 'react';

/**
 * Whether React has finished attaching to the server-rendered markup.
 *
 * The editor is server-rendered, so its controls are painted and look ready before any handler is
 * attached to them. Measured on a warm production build, that gap is about 200 ms — a click inside
 * it reaches a DOM node React does not yet know about and is simply lost, with nothing to see.
 *
 * Two hundred milliseconds is shorter than a person can see a button and reach it, so this is not
 * a control anybody is going to miss. It is a hazard for anything that clicks the instant an
 * element appears, which is what a test does, and what caught this: a probe waited on the artwork
 * name — which the demo design server-renders — took it for a readiness signal, and clicked into
 * the gap.
 *
 * So this exists to be *observable*, not to change what the customer sees. `data-hydrated` on the
 * editor root is a thing automation can wait for, in place of guessing from whatever element
 * happens to be on screen.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  // Runs after the commit, and only on the client, which is exactly the moment handlers are live.
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
