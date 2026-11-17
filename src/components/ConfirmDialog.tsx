// An in-window confirm for destructive actions. The native dialog cannot show a
// red button, and its default button (Return) is the confirm; here focus starts
// on Cancel, Esc cancels, and only a click (or Return once the user has moved
// focus to it) on the red button confirms.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ConfirmRequest = { title: string; message: string; confirmLabel: string };

// [the dialog to render, confirm(request) resolving true on confirm].
export function useConfirm(): [ReactNode, (r: ConfirmRequest) => Promise<boolean>] {
  const [open, setOpen] = useState<{ req: ConfirmRequest; resolve: (ok: boolean) => void } | null>(
    null,
  );
  const confirm = useCallback(
    (req: ConfirmRequest) => new Promise<boolean>((resolve) => setOpen({ req, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    open?.resolve(ok);
    setOpen(null);
  };
  return [open && <ConfirmDialog {...open.req} onClose={close} />, confirm];
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onClose,
}: ConfirmRequest & { onClose: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      // Keys stay in the dialog: the window's own shortcuts must not fire.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose(false);
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          boxShadow: "var(--shadow-lg)",
          padding: 18,
          width: 340,
          color: "var(--fg-primary)",
          fontFamily: "var(--font-system)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: "var(--fg-secondary)", lineHeight: 1.4 }}>{message}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            ref={cancelRef}
            className="btn-secondary"
            style={{ padding: "5px 12px", height: 28 }}
            onClick={() => onClose(false)}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            style={{ padding: "5px 14px", height: 28, background: "var(--recording)" }}
            onClick={() => onClose(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
