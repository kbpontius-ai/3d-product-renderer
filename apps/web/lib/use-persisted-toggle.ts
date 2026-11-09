'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A boolean the browser remembers (F-PLACE-06).
 *
 * For editor preferences rather than design data: whether snapping is on is a way of working, not
 * part of the product being designed, so it belongs to the person and not to the document. Storing
 * it in the design would put one colleague's preference in another's editor and, worse, make it a
 * change worth saving.
 *
 * `localStorage` rather than the server for the same reason a scroll position is not a database
 * row: nobody needs it to survive a change of machine, and a round trip to read it would leave the
 * toggle visibly flipping after the editor had already drawn.
 *
 * Read after mount, never during render: the server has no `localStorage`, and reading it while
 * rendering makes the server's HTML and the browser's first paint disagree.
 */
export function usePersistedToggle(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'true' || stored === 'false') setValue(stored === 'true');
    } catch {
      // A browser with storage disabled or a private window that refuses it: the preference simply
      // does not persist, which is a smaller problem than an editor that will not open.
    }
  }, [key]);

  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // As above: remembering is the nice-to-have, the toggle itself still works.
      }
    },
    [key],
  );

  return [value, update];
}
