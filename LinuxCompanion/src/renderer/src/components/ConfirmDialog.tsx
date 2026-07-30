import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  children: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  destructive = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }
  return (
    <div className="dialog-backdrop">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="dialog-copy">{children}</div>
        <div className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`button ${destructive ? 'button-danger' : 'button-primary'}`}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
