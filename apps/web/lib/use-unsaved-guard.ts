'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useConfirm } from '@/components/confirm-dialog';

/**
 * Asks before leaving a page with work on it that has not been saved.
 *
 * Two ways out, both covered. A link inside the app is caught at the document in the capture phase,
 * before the framework's router sees the click, and asks in the application's own modal; staying
 * leaves the page exactly as it was, leaving navigates through the router. The browser's own ways
 * out — reload, close, typing a URL — can only ever show the browser's generic prompt: a page is not
 * allowed to put its own dialog in front of an unload, so that half stays native.
 *
 * Returns the modal; render it.
 */
export function useUnsavedGuard(active: boolean, message: string): ReactNode {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still required by some browsers for the prompt to appear at all.
      event.returnValue = '';
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      // The answer is asynchronous now, so the click is always stopped and the navigation, if
      // wanted, is made afterwards.
      event.preventDefault();
      event.stopPropagation();
      void confirm({
        title: 'Leave without saving?',
        body: [message],
        confirmLabel: 'Leave',
        cancelLabel: 'Stay',
        tone: 'danger',
      }).then((leave) => {
        if (leave) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active, message, confirm, router]);

  return dialog;
}
