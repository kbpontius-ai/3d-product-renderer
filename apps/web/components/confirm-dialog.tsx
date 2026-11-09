'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The application's modal for asking before acting (F-UI-07) — an awaitable `window.confirm`, and
 * `window.prompt`, that look like the rest of the product and can say more than one sentence.
 *
 *   const { confirm, prompt, dialog } = useConfirm();
 *   if (!(await confirm({ title: 'Suspend …?', confirmLabel: 'Suspend', tone: 'danger' }))) return;
 *   const name = await prompt({ title: 'Rename', confirmLabel: 'Rename', input: { label: 'Name', defaultValue } });
 *   …
 *   return <>{…}{dialog}</>;
 *
 * Built on the native `<dialog>` and `showModal()`, so the top layer, the inert page behind it and
 * Escape-to-cancel come from the browser. A confirmation focuses Cancel first: Enter on a dialog that
 * deletes something should not be the thing that confirms it. A prompt focuses its field and Enter
 * submits it, because there the typing is the decision.
 *
 * Rendered into `document.body`, wherever `dialog` is placed: the top layer lifts it above the page,
 * but CSS inheritance still follows the DOM, and a dialog left inside a right-aligned, no-wrap table
 * cell came out right-aligned and overflowing. It only exists after a click, so `document` is there.
 */

export interface ConfirmOptions {
  title: string;
  /** Paragraphs under the title. */
  body?: ReactNode[];
  /** What will happen, one line each — shown as a list, because it is a list. */
  consequences?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for anything that takes something away. */
  tone?: 'default' | 'danger';
}

export interface PromptOptions extends ConfirmOptions {
  input: { label: string; defaultValue?: string; maxLength?: number };
}

type Settle = (result: { confirmed: boolean; value: string }) => void;

interface Pending {
  options: ConfirmOptions | PromptOptions;
  resolve: Settle;
}

export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** The trimmed text; null when cancelled, emptied, or left as it was. */
  prompt: (options: PromptOptions) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve: ({ confirmed }) => resolve(confirmed) })),
    [],
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) =>
        setPending({
          options,
          resolve: ({ confirmed, value }) => {
            const text = value.trim();
            const unchanged = text === (options.input.defaultValue ?? '').trim();
            resolve(confirmed && text !== '' && !unchanged ? text : null);
          },
        }),
      ),
    [],
  );

  const settle = useCallback<Settle>(
    (result) => {
      pending?.resolve(result);
      setPending(null);
    },
    [pending],
  );

  return {
    confirm,
    prompt,
    dialog: pending ? createPortal(<ConfirmDialog options={pending.options} onSettle={settle} />, document.body) : null,
  };
}

function ConfirmDialog({ options, onSettle }: { options: ConfirmOptions | PromptOptions; onSettle: Settle }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const input = 'input' in options ? options.input : null;
  const [value, setValue] = useState(input?.defaultValue ?? '');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    } else {
      cancelRef.current?.focus();
    }
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const empty = input !== null && value.trim() === '';

  return (
    // The backdrop click is the pointer's way out; the keyboard's is Escape, which the native dialog
    // turns into `cancel` below — so the click handler has its keyboard equivalent already.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- see above
    <dialog
      ref={ref}
      className="confirm-dialog"
      data-testid="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      // Escape: the browser closes the dialog and fires `cancel`; settle as a "no".
      onCancel={(event) => {
        event.preventDefault();
        onSettle({ confirmed: false, value });
      }}
      // A click on the backdrop lands on the dialog element itself, never on its contents.
      onClick={(event) => {
        if (event.target === event.currentTarget) onSettle({ confirmed: false, value });
      }}
    >
      <form
        className="confirm-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty) onSettle({ confirmed: true, value });
        }}
      >
        <h2 id="confirm-dialog-title">{options.title}</h2>
        {options.body?.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
        {options.consequences && options.consequences.length > 0 && (
          <ul className="confirm-dialog-consequences" data-testid="confirm-consequences">
            {options.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {input && (
          <label className="confirm-dialog-field">
            {input.label}
            <input
              ref={inputRef}
              value={value}
              maxLength={input.maxLength ?? 200}
              onChange={(event) => setValue(event.target.value)}
              data-testid="confirm-input"
            />
          </label>
        )}
        <div className="confirm-dialog-actions">
          <button
            type="button"
            ref={cancelRef}
            onClick={() => onSettle({ confirmed: false, value })}
            data-testid="confirm-cancel"
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={empty}
            className={options.tone === 'danger' ? 'danger-solid' : 'primary'}
            data-testid="confirm-accept"
          >
            {options.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
