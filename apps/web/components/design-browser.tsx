'use client';

import { useState } from 'react';
import { Grid2X2, List } from 'lucide-react';
import type { DesignSummary } from '@pr/designs';
import { DesignActions } from './design-actions';

type DesignCard = Omit<DesignSummary, 'thumbnailKey'> & { thumbnailUrl: string | null };

export function DesignBrowser({ designs }: { designs: DesignCard[] }) {
  const [query, setQuery] = useState('');
  const [product, setProduct] = useState('');
  const [sort, setSort] = useState('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const products = [...new Set(designs.map((design) => design.productName))].sort();
  const visible = designs
    .filter(
      (design) =>
        (!product || design.productName === product) &&
        `${design.name} ${design.productName} ${design.variantName}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );

  return (
    <>
      <div className="library-toolbar">
        <input
          aria-label="Search designs"
          placeholder="Search designs…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter by product"
          value={product}
          onChange={(event) => setProduct(event.target.value)}
        >
          <option value="">All products</option>
          {products.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          className="library-sort"
          aria-label="Sort designs"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="recent">Recently edited</option>
          <option value="name">Name A–Z</option>
        </select>
        <div className="view-switch">
          <button
            type="button"
            aria-label="Grid view"
            className={view === 'grid' ? 'active' : ''}
            onClick={() => setView('grid')}
          >
            <Grid2X2 size={16} />
          </button>
          <button
            type="button"
            aria-label="List view"
            className={view === 'list' ? 'active' : ''}
            onClick={() => setView('list')}
          >
            <List size={16} />
          </button>
        </div>
      </div>
      <p className="library-count">
        {visible.length} of {designs.length} recent designs
      </p>
      {visible.length === 0 && <p className="auth-sub">No designs match your filters.</p>}
      <ul className={`design-gallery ${view}`} data-testid="design-list">
        {visible.map((design) => (
          <li className="design-card" key={design.id} data-testid={`design-${design.id}`}>
            <a href={`/design/${design.id}`}>
              {design.thumbnailUrl ? (
                <img className="design-thumb" src={design.thumbnailUrl} alt="" />
              ) : (
                <span className="design-thumb empty">Preview appears after editing</span>
              )}
              <span className="design-card-body">
                <strong>{design.name}</strong>
                {Boolean(design.archivedArtworks?.length) && (
                  <span className="archive-design-status">Archived artwork · View-only</span>
                )}
                <span>
                  {design.productName} · {design.variantName}
                </span>
                <small>
                  v{design.version} · Edited {new Date(design.updatedAt).toLocaleDateString()}
                </small>
              </span>
            </a>
            <DesignActions
              designId={design.id}
              name={design.name}
              readOnly={Boolean(design.archivedArtworks?.length)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
