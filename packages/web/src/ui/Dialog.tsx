import { type ReactNode, useEffect, useRef } from "react";

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className={`dialog${wide ? " dialog-wide" : ""}`} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
