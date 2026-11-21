import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Edit3,
  Globe,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import { useProxyStore } from "../stores/proxyStore";
import type { HostRemapRule } from "../types/proxy";

interface HostRemapModalProps {
  open: boolean;
  onClose: () => void;
  onNotify?: (msg: string) => void;
}

interface StatusFeedback {
  tone: "success" | "error";
  text: string;
}

function validateSourcePatternInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Укажите исходный домен или wildcard-маску.";
  }
  if (/[\s\u0000-\u001f]/.test(trimmed)) {
    return "Маска домена не должна содержать пробелы.";
  }
  if (trimmed === "*" || trimmed === "*.") {
    return "Укажите конкретный домен или суффикс (например, *.staging.local) вместо '*'.";
  }
  return null;
}

function validateTargetHostInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Укажите целевой IP или хост (например, 127.0.0.1).";
  }
  if (/[\s\u0000-\u001f]/.test(trimmed) || /[\\/?#]/.test(trimmed)) {
    return "Целевой хост не должен содержать пробелы или символы /, \\, ?, #.";
  }
  if (/^[^:]+:\d+$/.test(trimmed)) {
    return "Укажите порт в отдельном поле Target Port, а не в Target Host.";
  }
  return null;
}

function validateTargetPortInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    return "Порт должен быть целым числом от 1 до 65535.";
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return "Порт должен быть в диапазоне 1..65535.";
  }
  return null;
}

export const HostRemapModal: React.FC<HostRemapModalProps> = ({
  open,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const targetHostInputRef = useRef<HTMLInputElement>(null);
  const targetPortInputRef = useRef<HTMLInputElement>(null);

  const titleId = useId();
  const formHeadingId = useId();
  const tableCaptionId = useId();
  const sourceInputId = useId();
  const sourceHintId = useId();
  const sourceErrorId = useId();
  const targetHostInputId = useId();
  const targetHostErrorId = useId();
  const targetPortInputId = useId();
  const targetPortErrorId = useId();
  const preserveHostCheckboxId = useId();
  const commentInputId = useId();

  const rules = useProxyStore((s) => s.hostRemapRules);
  const setHostRemapRules = useProxyStore((s) => s.setHostRemapRules);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<StatusFeedback | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [sourcePattern, setSourcePattern] = useState("");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("");
  const [preserveHostHeader, setPreserveHostHeader] = useState(true);
  const [comment, setComment] = useState("");

  const [sourceError, setSourceError] = useState<string | null>(null);
  const [targetHostError, setTargetHostError] = useState<string | null>(null);
  const [targetPortError, setTargetPortError] = useState<string | null>(null);

  const supportsNativeSwitch =
    typeof HTMLInputElement !== "undefined" &&
    "switch" in HTMLInputElement.prototype;

  const resetForm = useCallback(() => {
    setEditingId(null);
    setSourcePattern("");
    setTargetHost("127.0.0.1");
    setTargetPort("");
    setPreserveHostHeader(true);
    setComment("");
    setSourceError(null);
    setTargetHostError(null);
    setTargetPortError(null);
  }, []);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const list = await proxyBridge.getHostRemapRules();
      setHostRemapRules(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({
        tone: "error",
        text: `Не удалось загрузить правила HOSTS Remapping: ${msg}`,
      });
    } finally {
      setLoading(false);
    }
  }, [setHostRemapRules]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setFeedback(null);
      setSourceError(null);
      setTargetHostError(null);
      setTargetPortError(null);
      if (!dialog.open) {
        dialog.showModal();
      }
      void loadRules();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, loadRules]);

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

  const persistRules = async (
    nextRules: HostRemapRule[],
    successMsg: string
  ): Promise<HostRemapRule[] | null> => {
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await proxyBridge.updateHostRemapRules(nextRules);
      setHostRemapRules(saved);
      setFeedback({ tone: "success", text: successMsg });
      onNotify?.(successMsg);
      return saved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", text: msg });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitRule = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFeedback(null);

    const srcErr = validateSourcePatternInput(sourcePattern);
    const tgtErr = validateTargetHostInput(targetHost);
    const portErr = validateTargetPortInput(targetPort);

    setSourceError(srcErr);
    setTargetHostError(tgtErr);
    setTargetPortError(portErr);

    if (srcErr) {
      sourceInputRef.current?.focus();
      return;
    }
    if (tgtErr) {
      targetHostInputRef.current?.focus();
      return;
    }
    if (portErr) {
      targetPortInputRef.current?.focus();
      return;
    }

    const parsedPort = targetPort.trim() ? Number(targetPort.trim()) : null;
    const existingRule = editingId
      ? rules.find((r) => r.id === editingId)
      : undefined;

    const candidateRule: HostRemapRule = {
      id:
        editingId ??
        `remap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: existingRule ? existingRule.enabled : true,
      sourcePattern: sourcePattern.trim(),
      targetHost: targetHost.trim(),
      targetPort: parsedPort,
      preserveHostHeader,
      comment: comment.trim(),
    };

    const nextRules = editingId
      ? rules.map((r) => (r.id === editingId ? candidateRule : r))
      : [...rules, candidateRule];

    const saved = await persistRules(
      nextRules,
      editingId
        ? `Правило HOSTS '${candidateRule.sourcePattern}' обновлено`
        : `Правило HOSTS '${candidateRule.sourcePattern}' → ${candidateRule.targetHost}${parsedPort ? `:${parsedPort}` : ""} добавлено`
    );
    if (saved) {
      resetForm();
      sourceInputRef.current?.focus();
    }
  };

  const handleEditRule = (rule: HostRemapRule) => {
    setEditingId(rule.id);
    setSourcePattern(rule.sourcePattern);
    setTargetHost(rule.targetHost);
    setTargetPort(rule.targetPort ? String(rule.targetPort) : "");
    setPreserveHostHeader(rule.preserveHostHeader);
    setComment(rule.comment);
    setSourceError(null);
    setTargetHostError(null);
    setTargetPortError(null);
    setFeedback(null);
    sourceInputRef.current?.focus();
  };

  const handleToggleRule = async (rule: HostRemapRule) => {
    const nextEnabled = !rule.enabled;
    const nextRules = rules.map((r) =>
      r.id === rule.id ? { ...r, enabled: nextEnabled } : r
    );
    await persistRules(
      nextRules,
      `HOSTS '${rule.sourcePattern}' ${nextEnabled ? "включено" : "отключено"}`
    );
  };

  const handleDeleteRule = async (rule: HostRemapRule) => {
    const nextRules = rules.filter((r) => r.id !== rule.id);
    const saved = await persistRules(
      nextRules,
      `Правило HOSTS '${rule.sourcePattern}' удалено`
    );
    if (saved && editingId === rule.id) {
      resetForm();
    }
  };

  const handleClearAll = async () => {
    if (rules.length === 0) return;
    const saved = await persistRules([], "Все правила HOSTS Remapping удалены");
    if (saved) {
      resetForm();
    }
  };

  const activeCount = rules.filter((r) => r.enabled).length;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        resetForm();
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-4xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:max-h-[90vh] open:flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
          <div>
            <h2 id={titleId} className="text-sm font-semibold">
              Virtual DNS &amp; HOSTS Remapping
            </h2>
            <p className="text-[11px] text-muted">
              Локальное перенаправление доменов на IP/порт без правки системного
              файла hosts
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть управление HOSTS Remapping"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <form
          onSubmit={(e) => void handleSubmitRule(e)}
          noValidate
          aria-labelledby={formHeadingId}
          className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id={formHeadingId}
              className="flex items-center gap-1.5 text-xs font-semibold text-fg"
            >
              {editingId ? (
                <>
                  <Edit3 aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
                  <span>Редактировать правило HOSTS</span>
                </>
              ) : (
                <>
                  <Plus aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
                  <span>Добавить правило перенаправления</span>
                </>
              )}
            </h3>
            <span className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-0.5 text-[10px] text-muted">
              <ShieldCheck aria-hidden="true" className="h-3 w-3 text-status2xx-fg" />
              <span>TLS SNI сохраняется при ремаппинге домена</span>
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            {/* Source Pattern */}
            <div className="flex flex-col gap-1 md:col-span-5">
              <label
                htmlFor={sourceInputId}
                className="text-[11px] font-medium text-fg"
              >
                Исходный домен / маска{" "}
                <span aria-hidden="true" className="text-rose-400">
                  *
                </span>
              </label>
              <input
                ref={sourceInputRef}
                id={sourceInputId}
                name="sourcePattern"
                type="text"
                required
                autoFocus
                {...({ autofocus: "" } as Record<string, string>)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="api.prod.example.com или *.staging.local"
                value={sourcePattern}
                aria-invalid={sourceError ? "true" : "false"}
                aria-describedby={
                  sourceError ? `${sourceHintId} ${sourceErrorId}` : sourceHintId
                }
                onChange={(e) => {
                  setSourcePattern(e.target.value);
                  if (sourceError) setSourceError(null);
                }}
                className={`rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  sourceError
                    ? "border-rose-500/70 bg-rose-500/5"
                    : "border-strong"
                }`}
              />
              <span id={sourceHintId} className="text-[10px] text-subtle">
                Точный хост (<code>api.prod.com</code>), поддомены (
                <code>*.prod.com</code>) или glob.
              </span>
              {sourceError && (
                <span
                  id={sourceErrorId}
                  role="alert"
                  className="text-[11px] font-medium text-rose-400"
                >
                  {sourceError}
                </span>
              )}
            </div>

            {/* Target Host */}
            <div className="flex flex-col gap-1 md:col-span-4">
              <label
                htmlFor={targetHostInputId}
                className="text-[11px] font-medium text-fg"
              >
                Целевой хост / IP{" "}
                <span aria-hidden="true" className="text-rose-400">
                  *
                </span>
              </label>
              <input
                ref={targetHostInputRef}
                id={targetHostInputId}
                name="targetHost"
                type="text"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="127.0.0.1 или localhost"
                value={targetHost}
                aria-invalid={targetHostError ? "true" : "false"}
                aria-describedby={
                  targetHostError ? targetHostErrorId : undefined
                }
                onChange={(e) => {
                  setTargetHost(e.target.value);
                  if (targetHostError) setTargetHostError(null);
                }}
                className={`rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  targetHostError
                    ? "border-rose-500/70 bg-rose-500/5"
                    : "border-strong"
                }`}
              />
              {targetHostError && (
                <span
                  id={targetHostErrorId}
                  role="alert"
                  className="text-[11px] font-medium text-rose-400"
                >
                  {targetHostError}
                </span>
              )}
            </div>

            {/* Target Port */}
            <div className="flex flex-col gap-1 md:col-span-3">
              <label
                htmlFor={targetPortInputId}
                className="text-[11px] font-medium text-fg"
              >
                Target Port (опц.)
              </label>
              <input
                ref={targetPortInputRef}
                id={targetPortInputId}
                name="targetPort"
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                placeholder="Напр. 8443"
                value={targetPort}
                aria-invalid={targetPortError ? "true" : "false"}
                aria-describedby={
                  targetPortError ? targetPortErrorId : undefined
                }
                onChange={(e) => {
                  setTargetPort(e.target.value);
                  if (targetPortError) setTargetPortError(null);
                }}
                className={`rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  targetPortError
                    ? "border-rose-500/70 bg-rose-500/5"
                    : "border-strong"
                }`}
              />
              {targetPortError && (
                <span
                  id={targetPortErrorId}
                  role="alert"
                  className="text-[11px] font-medium text-rose-400"
                >
                  {targetPortError}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
            {/* Comment */}
            <div className="flex flex-col gap-1 md:col-span-6">
              <label
                htmlFor={commentInputId}
                className="text-[11px] font-medium text-fg"
              >
                Комментарий
              </label>
              <input
                id={commentInputId}
                name="comment"
                type="text"
                placeholder="Напр. Локальный стенд Docker / staging backend"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="rounded-md border border-strong bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>

            {/* Preserve Host Header */}
            <div className="md:col-span-6">
              <label
                htmlFor={preserveHostCheckboxId}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-[11px] text-fg hover:border-strong"
              >
                <input
                  id={preserveHostCheckboxId}
                  type="checkbox"
                  checked={preserveHostHeader}
                  onChange={(e) => setPreserveHostHeader(e.target.checked)}
                  className="checkbox-native"
                />
                <span>
                  Сохранять исходный заголовок{" "}
                  <code className="font-mono text-accent">Host</code> и TLS SNI
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-[10px] text-muted">
              Для HTTPS подключение открывается на{" "}
              <code className="font-mono text-fg">Target Host[:Port]</code> через
              кастомный DNS resolver с сохранением SNI, а для{" "}
              <code className="font-mono text-fg">CONNECT</code> Passthrough
              перенаправляется напрямую TCP-сокет.
            </p>
            <div className="flex items-center gap-2">
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-md border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
                >
                  Отмена
                </button>
              )}
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                <span>
                  {saving
                    ? "Сохранение…"
                    : editingId
                      ? "Сохранить правило"
                      : "Добавить правило"}
                </span>
              </button>
            </div>
          </div>
        </form>

        {/* Feedback Banner */}
        {feedback && (
          <div
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live={feedback.tone === "error" ? "assertive" : "polite"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              feedback.tone === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {feedback.tone === "error" ? (
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="min-w-0 flex-1 break-words">{feedback.text}</span>
          </div>
        )}

        {/* Rules Table */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-fg">
              Активные правила перенаправления ({activeCount}/{rules.length})
            </div>
            {rules.length > 0 && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleClearAll()}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-muted hover:border-rose-500/40 hover:text-rose-400 disabled:opacity-40"
              >
                <Trash2 aria-hidden="true" className="h-3 w-3" />
                <span>Очистить все</span>
              </button>
            )}
          </div>

          {loading && rules.length === 0 ? (
            <div className="rounded-lg border border-hairline bg-canvas p-6 text-center text-muted">
              Загрузка правил HOSTS Remapping…
            </div>
          ) : rules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-strong bg-canvas p-6 text-center text-muted">
              Правила HOSTS Remapping не настроены. Добавьте маску домена выше,
              чтобы направлять трафик на локальный порт или staging-сервер без
              изменения системного файла hosts.
            </div>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-labelledby={tableCaptionId}
              className="filter-table-wrapper max-h-72 rounded-lg border border-hairline bg-canvas"
            >
              <table
                className="filter-data-table text-left text-xs"
                style={
                  {
                    "--label-2": '"Target (IP/Port)"',
                    "--label-3": '"Host / SNI"',
                    "--label-4": '"Активно"',
                    "--label-5": '"Действия"',
                  } as React.CSSProperties
                }
              >
                <caption id={tableCaptionId} className="sr-only">
                  Таблица правил Virtual DNS (HOSTS Remapping)
                </caption>
                <thead>
                  <tr className="border-b border-hairline text-[11px] font-semibold uppercase tracking-wider text-subtle">
                    <th scope="col" className="px-3 py-2">
                      Source Pattern
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Target IP / Host : Port
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Host / SNI
                    </th>
                    <th scope="col" className="px-3 py-2 text-center">
                      Активно
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Действия
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rules.map((rule) => {
                    const targetLabel = `${rule.targetHost}${
                      rule.targetPort ? `:${rule.targetPort}` : ""
                    }`;
                    return (
                      <tr
                        key={rule.id}
                        className={rule.enabled ? "" : "opacity-60"}
                      >
                        <th
                          scope="row"
                          className="px-3 py-2.5 align-top font-normal"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-xs font-semibold text-fg">
                              {rule.sourcePattern}
                            </span>
                            {rule.comment && (
                              <span
                                className="max-w-[230px] truncate text-[11px] text-muted"
                                title={rule.comment}
                              >
                                {rule.comment}
                              </span>
                            )}
                          </div>
                        </th>
                        <td data-col="2" className="px-3 py-2.5 align-middle">
                          <span className="font-mono text-xs text-accent">
                            {targetLabel}
                          </span>
                        </td>
                        <td data-col="3" className="px-3 py-2.5 align-middle">
                          {rule.preserveHostHeader ? (
                            <span
                              title="Исходный заголовок Host и TLS SNI сохраняются"
                              className="inline-flex rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400"
                            >
                              Preserve Host/SNI
                            </span>
                          ) : (
                            <span
                              title="Заголовок Host подменяется на целевой хост"
                              className="inline-flex rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-300"
                            >
                              Rewrite Host
                            </span>
                          )}
                        </td>
                        <td
                          data-col="4"
                          className="px-3 py-2.5 text-center align-middle"
                        >
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            disabled={saving}
                            aria-label={`Переключить правило HOSTS для ${rule.sourcePattern}`}
                            {...(supportsNativeSwitch
                              ? { switch: "" }
                              : { role: "switch" })}
                            onChange={() => void handleToggleRule(rule)}
                            className="checkbox-native"
                          />
                        </td>
                        <td
                          data-col="5"
                          className="px-3 py-2.5 text-right align-middle"
                        >
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => handleEditRule(rule)}
                              title={`Редактировать правило для ${rule.sourcePattern}`}
                              aria-label={`Редактировать правило ${rule.sourcePattern}`}
                              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                            >
                              <Edit3 aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void handleDeleteRule(rule)}
                              title={`Удалить правило для ${rule.sourcePattern}`}
                              aria-label={`Удалить правило ${rule.sourcePattern}`}
                              className="rounded p-1 text-muted hover:bg-rose-500/10 hover:text-rose-400"
                            >
                              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <form
        method="dialog"
        className="flex items-center justify-end gap-2 border-t border-hairline px-4 py-2.5"
      >
        <button
          type="submit"
          className="rounded-md border border-strong bg-elevated px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover"
        >
          Готово
        </button>
      </form>
    </dialog>
  );
};
