import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import type { CaCertificateInfo } from "../types/proxy";

interface CertificateModalProps {
  open: boolean;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

interface StatusFeedback {
  tone: "success" | "error";
  text: string;
}

export const CertificateModal: React.FC<CertificateModalProps> = ({
  open,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [caInfo, setCaInfo] = useState<CaCertificateInfo | null>(null);
  const [busyAction, setBusyAction] = useState<"install" | "uninstall" | null>(
    null
  );
  const [statusFeedback, setStatusFeedback] = useState<StatusFeedback | null>(
    null
  );

  const refreshCaInfo = useCallback(async () => {
    const info = await proxyBridge.getCaInfo();
    setCaInfo(info);
    return info;
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setStatusFeedback(null);
      if (!dialog.open) {
        dialog.showModal();
      }
      void refreshCaInfo();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, refreshCaInfo]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is not natively supported
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) dialog.close();
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  const handleInstallTrust = async () => {
    setBusyAction("install");
    setStatusFeedback(null);
    try {
      const msg = await proxyBridge.installRootCa();
      await refreshCaInfo();
      setStatusFeedback({ tone: "success", text: msg });
      onNotify(msg);
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      await refreshCaInfo().catch(() => undefined);
      setStatusFeedback({ tone: "error", text: errText });
      onNotify(errText);
    } finally {
      setBusyAction(null);
    }
  };

  const handleUninstallTrust = async () => {
    setBusyAction("uninstall");
    setStatusFeedback(null);
    try {
      const msg = await proxyBridge.uninstallRootCa();
      await refreshCaInfo();
      setStatusFeedback({ tone: "success", text: msg });
      onNotify(msg);
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      await refreshCaInfo().catch(() => undefined);
      setStatusFeedback({ tone: "error", text: errText });
      onNotify(errText);
    } finally {
      setBusyAction(null);
    }
  };

  const isBusy = busyAction !== null;
  const isTrusted = Boolean(caInfo?.isTrusted);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck
            aria-hidden="true"
            className="h-4 w-4 text-emerald-400"
          />
          <h2 id={titleId} className="text-sm font-semibold">
            HTTPS MITM Root Certificate Authority
          </h2>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close certificate settings"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 p-4 text-xs">
        <p className="leading-relaxed text-muted">
          FluxProxy dynamically generates per-domain ECDSA P-256 leaf certificates on the fly via{" "}
          <code className="rounded bg-elevated px-1 py-0.5 font-mono text-sky-400">
            rcgen + rustls
          </code>
          . Trusting this local Root CA allows decrypting HTTPS/1.1, HTTPS/2, and WSS traffic on{" "}
          <code className="font-mono text-fg">127.0.0.1:8888</code>.
        </p>

        {caInfo && (
          <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3 font-mono text-[11px] select-text">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2 font-sans">
              <span className="text-[11px] font-medium text-muted">
                Статус в доверенном хранилище ОС:
              </span>
              {isTrusted ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
                  <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  <span>Установлен (доверен ОС)</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-strong bg-elevated px-2.5 py-0.5 text-[11px] font-medium text-muted">
                  <ShieldOff aria-hidden="true" className="h-3.5 w-3.5" />
                  <span>Не установлен в доверенные ОС</span>
                </span>
              )}
            </div>
            <div>
              <span className="block text-[10px] uppercase text-subtle">
                Subject
              </span>
              <span className="text-fg">{caInfo.subject}</span>
            </div>
            <div>
              <span className="block text-[10px] uppercase text-subtle">
                SHA-256 Fingerprint
              </span>
              <span className="break-all text-emerald-400">
                {caInfo.sha256Fingerprint}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="block text-[10px] uppercase text-subtle">
                  Certificate File (.cer)
                </span>
                <span className="block truncate text-muted">
                  {caInfo.certCerPath}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(caInfo.certCerPath);
                  onNotify("Copied Root CA path to clipboard");
                }}
                aria-label="Copy certificate file path"
                title="Copy certificate file path"
                className="shrink-0 rounded border border-hairline bg-surface p-1.5 text-muted hover:text-fg"
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {statusFeedback && (
          <div
            role={statusFeedback.tone === "error" ? "alert" : "status"}
            aria-live={statusFeedback.tone === "error" ? "assertive" : "polite"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              statusFeedback.tone === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {statusFeedback.tone === "error" ? (
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="break-words leading-relaxed">
              {statusFeedback.text}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/40 px-4 py-3">
        <form method="dialog">
          <button
            value="cancel"
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            className="rounded-md border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-fg"
          >
            Close
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleUninstallTrust()}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 disabled:opacity-50"
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span>
              {busyAction === "uninstall"
                ? "Удаление из хранилища ОС..."
                : "Удалить сертификат из доверенных ОС"}
            </span>
          </button>

          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleInstallTrust()}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
            <span>
              {busyAction === "install"
                ? "Prompting OS Trust Store..."
                : "Trust Root CA in OS Store"}
            </span>
          </button>
        </div>
      </div>
    </dialog>
  );
};
