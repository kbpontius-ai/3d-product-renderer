'use client';

import { Archive } from 'lucide-react';

export function ArchiveBanner({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="archive-banner" data-testid="archive-banner">
      <Archive size={20} className="archive-banner-icon" />
      <div className="archive-banner-copy">
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
      {action && <div className="archive-banner-action">{action}</div>}
    </div>
  );
}
