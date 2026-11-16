/**
 * The in-app alerts (lib/alertToasts.ts): a card per agent that needs the user or finished, at the
 * bottom corner; a click opens it there, X dismisses it. A finish leaves by itself after a while,
 * a question stays until dismissed or opened.
 */
import { useEffect } from "react";
import { X } from "lucide-react";

import "./AlertToasts.css";

import { dismissAlertToast, TOAST_MS, useAlertToasts, type AlertToast } from "../lib/alertToasts.ts";
import { useT } from "../lib/i18n.ts";

export function AlertToasts() {
  const toasts = useAlertToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="alert-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => <Toast key={toast.key} toast={toast} />)}
    </div>
  );
}

function Toast({ toast }: { toast: AlertToast }) {
  const t = useT();
  useEffect(() => {
    if (toast.kind === "blocked") return;
    const timer = setTimeout(() => dismissAlertToast(toast.key), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="alert-toast" data-kind={toast.kind}>
      <button type="button" className="alert-toast-open" onClick={() => { dismissAlertToast(toast.key); toast.open(); }}>
        <span className="alert-toast-dot" aria-hidden="true" />
        <span className="alert-toast-text">
          <span className="alert-toast-title">{toast.title}</span>
          {toast.place && <span className="alert-toast-place">{toast.place}</span>}
        </span>
      </button>
      <button type="button" className="icon-button alert-toast-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => dismissAlertToast(toast.key)}><X /></button>
    </div>
  );
}
