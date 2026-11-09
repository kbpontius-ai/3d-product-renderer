'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { NotificationRecord } from '@pr/notifications';

/**
 * The bell (F-REND-08).
 *
 * Polls while the tab is visible and stops when it is not: the thing being waited for takes
 * minutes, and a background tab polling all afternoon is the kind of thing that makes people close
 * the app. Opening the list marks it read, because a badge that survives being looked at is a badge
 * people learn to ignore.
 */

const POLL_MS = 30_000;

export function NotificationBell() {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications');
      if (!response.ok) return;
      const body = (await response.json()) as { notifications: NotificationRecord[]; unread: number };
      setItems(body.notifications);
      setUnread(body.unread);
    } catch {
      // A failed poll is not worth telling anyone about; the next one will do.
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
      timer.current = setTimeout(tick, POLL_MS);
    };
    tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    // Only while it is open: a panel nobody can see has no reason to be listening to the document.
    if (!open) return;

    /*
     * `pointerdown`, not `click`.
     *
     * The panel should be gone by the time the press lands, and a `click` only arrives after the
     * button is released — long enough on a drag or a slow tap to look stuck. Closing here rather
     * than through `toggle` is deliberate too: dismissing is not opening, and only opening marks
     * the list read.
     */
    const dismiss = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || unread === 0) return;

    setUnread(0);
    await fetch('/api/notifications', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    void load();
  };

  return (
    <div className="bell" ref={root}>
      <button type="button" onClick={() => void toggle()} data-testid="bell" aria-label="Notifications">
        {/*
          * Was the Unicode glyph `◍` — a circled bullet standing in for a bell, which rendered as
          * a dark blob at any size and belongs to whatever font happened to load. lucide's icons
          * are stroked SVG paths, which is what DESIGN.md asks for: "minimal stroked linework in
          * Ink Black". `currentColor` means it inherits the button's colour rather than needing
          * one of its own.
          */}
        <Bell size={18} strokeWidth={1.5} aria-hidden />
        {unread > 0 && (
          <span className="bell-badge" data-testid="bell-unread">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="bell-list" data-testid="bell-list">
          {items.length === 0 && <p className="auth-sub">Nothing yet.</p>}
          {items.map((item) => (
            <a
              key={item.id}
              href={item.link ?? '/renders'}
              className={item.readAt ? 'bell-item' : 'bell-item unread'}
              data-testid={`bell-item-${item.kind}`}
            >
              <strong>{item.title}</strong>
              {item.body && <span>{item.body}</span>}
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
