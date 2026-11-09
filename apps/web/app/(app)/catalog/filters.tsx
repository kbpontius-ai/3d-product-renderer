'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FacetSummary } from '@pr/catalog';

/**
 * How long the field sits still before the catalog re-queries.
 *
 * Short enough that it reads as live, long enough that typing a word is one query rather than six.
 * The catalog is a few dozen rows behind an indexed query, so this is about not thrashing the
 * server, not about the search being expensive.
 */
const DEBOUNCE_MS = 250;

/**
 * Filtering the catalog by whatever the packs happen to declare (F-CAT-02).
 *
 * Nothing here knows what a facet means. "Neck size" is a fact about closures that a carton pack
 * has never heard of, so the controls are built from the values present rather than from a list
 * this code carries — which is the same reason the catalog has no product-specific code at all.
 *
 * The search field filters as it is typed (F-CAT-02). The query lives in the URL rather than in
 * this component, so a filtered catalog stays a link somebody can send; the debounce is what keeps
 * that from meaning a server render per keystroke.
 */
export function CatalogFilters({
  facets,
  chosen,
  search,
}: {
  facets: FacetSummary[];
  chosen: Record<string, string>;
  search: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(search);

  /**
   * The `q` this component last put in the URL.
   *
   * It answers "did that prop change because of us?". Every navigation here re-renders the server
   * component and arrives back as a new `search` prop, and without somewhere to record what we
   * sent, the resync below would overwrite whatever was typed while the request was in flight —
   * the classic live-search bug where fast typing loses its last few characters.
   */
  const sent = useRef(search);

  // `toString()` rather than the object: `useSearchParams` hands back a fresh instance per render,
  // so the string is what actually tells us the query changed.
  const queryString = params.toString();

  /**
   * The URL for a given search term, with any other filter left as it is.
   *
   * `q` is written from the argument rather than read out of `params`, because a debounced search
   * may not have landed yet — building a facet's URL from the address bar alone would drop what is
   * sitting in the field.
   */
  const urlFor = useCallback(
    (q: string, mutate?: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(queryString);
      if (q) next.set('q', q);
      else next.delete('q');
      mutate?.(next);
      return next.size ? `/catalog?${next}` : '/catalog';
    },
    [queryString],
  );

  const commit = useCallback(
    (q: string, mode: 'push' | 'replace', mutate?: (next: URLSearchParams) => void) => {
      sent.current = q;
      const url = urlFor(q, mutate);
      // Typing replaces; choosing a facet pushes. Six history entries for "bottle" would make the
      // back button useless, while a facet is a decision worth being able to undo.
      if (mode === 'push') router.push(url);
      else router.replace(url);
    },
    [router, urlFor],
  );

  useEffect(() => {
    // Also the mount case: on first render the field already agrees with the URL, so there is
    // nothing to send and no navigation to make.
    if (query === sent.current) return;

    const timer = setTimeout(() => {
      // Re-checked at fire time, not just when the timer was armed: submitting or changing a facet
      // in the meantime has already carried this term into the URL.
      if (query === sent.current) return;
      commit(query, 'replace');
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, commit]);

  useEffect(() => {
    // A `search` we did not send came from somewhere else — history navigation, or a link. Follow
    // it, so the field never disagrees with the results underneath it.
    if (search === sent.current) return;
    sent.current = search;
    setQuery(search);
  }, [search]);

  return (
    <form
      className="catalog-filters"
      // Only labelled as the filter bar when there is something to filter by; a lone search box on
      // an unfiltered catalog is not the same control.
      {...(facets.length === 0 && !search ? {} : { 'data-testid': 'catalog-filters' })}
      onSubmit={(event) => {
        // The field is already the search, so Enter only means "do not wait out the debounce" —
        // and, more importantly, "do not reload the page".
        event.preventDefault();
        if (query !== sent.current) commit(query, 'replace');
      }}
    >
      <input
        name="q"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search products"
        data-testid="catalog-search"
      />

      {facets.map((facet) => (
        <label key={facet.key}>
          {facet.key.replace(/_/g, ' ')}
          <select
            value={chosen[facet.key] ?? ''}
            data-testid={`facet-${facet.key}`}
            onChange={(event) =>
              commit(query, 'push', (next) => {
                if (event.target.value) next.set(`f_${facet.key}`, event.target.value);
                else next.delete(`f_${facet.key}`);
              })
            }
          >
            <option value="">Any</option>
            {facet.values.map((value) => (
              <option key={value.value} value={value.value}>
                {value.value} ({value.count})
              </option>
            ))}
          </select>
        </label>
      ))}

      {(search || Object.keys(chosen).length > 0) && (
        <a className="auth-link" href="/catalog" data-testid="catalog-clear">
          Clear
        </a>
      )}
    </form>
  );
}
