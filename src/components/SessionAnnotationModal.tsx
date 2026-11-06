import React, { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Eraser,
  MessageSquarePlus,
  Palette,
  Tag,
  X,
} from "lucide-react";
import {
  hexToRgba,
  QUICK_COMMENT_SUGGESTIONS,
  SESSION_MARK_PALETTE,
} from "../lib/sessionDiff";
import type { SessionSummary } from "../types/proxy";

interface SessionAnnotationModalProps {
  open: boolean;
  targetSessions: SessionSummary[];
  onClose: () => void;
  onSave: (
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ) => void;
}

export const SessionAnnotationModal: React.FC<SessionAnnotationModalProps> = ({
  open,
  targetSessions,
  onClose,
  onSave,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const [comment, setComment] = useState("");
  const [markedColor, setMarkedColor] = useState<string>("");

  const ids = targetSessions.map((s) => s.id);
  const primary = targetSessions[0] ?? null;
  const hasExistingAnnotation = targetSessions.some(
    (s) => Boolean(s.comment || s.markedColor)
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && targetSessions.length > 0) {
      setComment(targetSessions[0]?.comment ?? "");
      setMarkedColor(targetSessions[0]?.markedColor ?? "");
      if (!dialog.open) {
        dialog.showModal();
      }
      // Select existing text so user can immediately type or overwrite after pressing `M`
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else if (dialog.open) {
      dialog.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ids.join(",")]);

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

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ids.length === 0) return;
    onSave(
      ids,
      comment.trim() ? comment.trim() : null,
      markedColor.trim() ? markedColor.trim() : null
    );
    dialogRef.current?.close();
  };

  const handleClear = () => {
    if (ids.length === 0) return;
    onSave(ids, null, null);
    dialogRef.current?.close();
  };

  const previewTint = hexToRgba(markedColor, 0.22);
  const customColorPickerValue = /^#[0-9a-fA-F]{6}$/.test(markedColor)
    ? markedColor
    : "#f59e0b";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-lg rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-amber-400" />
          <h2 id={titleId} className="text-sm font-semibold">
            Комментарий и цветовой маркер сессии (Comment / Mark)
          </h2>
          <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            M
          </kbd>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть окно аннотации"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSaveSubmit} className="space-y-4 p-4 text-xs">
        {/* Target Session Summary */}
        {primary && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2 font-mono text-[11px]">
            {targetSessions.length === 1 ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-subtle">#{primary.id}</span>
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-bold text-sky-400">
                  {primary.method}
                </span>
                <span className="truncate text-fg" title={primary.url}>
                  {primary.url}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-fg">
                <Tag className="h-3.5 w-3.5 text-sky-400" />
                <span>
                  Выбрано сессий: <strong>{targetSessions.length}</strong> (
                  {targetSessions
                    .slice(0, 5)
                    .map((s) => `#${s.id}`)
                    .join(", ")}
                  {targetSessions.length > 5 ? "…" : ""})
                </span>
              </div>
            )}
            {targetSessions.length === 1 && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  primary.status >= 400
                    ? "bg-rose-500/20 text-rose-300"
                    : "bg-emerald-500/15 text-emerald-400"
                }`}
              >
                {primary.status}
              </span>
            )}
          </div>
        )}

        {/* Comment Input + Quick Templates */}
        <div className="space-y-2">
          <label
            htmlFor={`${titleId}-comment`}
            className="block text-[11px] font-semibold uppercase tracking-wider text-subtle"
          >
            Заметка к сессии (сохраняется в SQLite дампе)
          </label>
          <input
            ref={inputRef}
            id={`${titleId}-comment`}
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Например: Кейс с протухшим токеном..."
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            className="h-9 w-full rounded-lg border border-strong bg-canvas px-3 text-xs text-fg placeholder:text-subtle focus:border-sky-500 focus:outline-none"
          />

          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {QUICK_COMMENT_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  setComment(suggestion);
                  inputRef.current?.focus();
                }}
                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  comment === suggestion
                    ? "border-amber-500/60 bg-amber-500/15 text-amber-300"
                    : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
                }`}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        {/* Row Background Color Picker */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Цветовая заливка строки (Mark Row)
            </span>
            {markedColor && (
              <span className="font-mono text-[11px] text-muted">
                {markedColor.toUpperCase()}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setMarkedColor("")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
                !markedColor
                  ? "border-sky-500 bg-sky-500/15 font-medium text-fg"
                  : "border-hairline bg-canvas text-muted hover:text-fg"
              }`}
            >
              <span>Без заливки</span>
            </button>

            {SESSION_MARK_PALETTE.map((swatch) => {
              const active =
                markedColor.toLowerCase() === swatch.color.toLowerCase();
              return (
                <button
                  key={swatch.id}
                  type="button"
                  onClick={() => setMarkedColor(swatch.color)}
                  title={swatch.label}
                  aria-label={swatch.label}
                  style={{ backgroundColor: swatch.color }}
                  className={`relative flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110 ${
                    active
                      ? "ring-2 ring-fg ring-offset-2 ring-offset-surface scale-110"
                      : "opacity-85 hover:opacity-100"
                  }`}
                >
                  {active && (
                    <Check className="h-3.5 w-3.5 text-white drop-shadow" />
                  )}
                </button>
              );
            })}

            {/* Native Custom Color Input */}
            <label
              title="Выбрать произвольный HEX-цвет заливки строки"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-hairline bg-canvas px-2.5 text-[11px] text-muted transition-colors hover:border-strong hover:text-fg"
            >
              <Palette className="h-3.5 w-3.5 text-sky-400" />
              <span>Свой цвет</span>
              <input
                type="color"
                value={customColorPickerValue}
                onChange={(e) => setMarkedColor(e.target.value)}
                aria-label="Произвольный цвет заливки строки"
                className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
              />
            </label>
          </div>
        </div>

        {/* Live TrafficGrid Row Preview */}
        {primary && (
          <div className="space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-subtle">
              Предпросмотр строки в TrafficGrid
            </span>
            <div
              style={{
                backgroundColor: previewTint ?? undefined,
                boxShadow: markedColor
                  ? `inset 3px 0 0 0 ${markedColor}`
                  : undefined,
              }}
              className="flex h-8 items-center justify-between gap-2 rounded-md border border-hairline bg-canvas px-2.5 font-mono text-xs"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-[11px] text-subtle">#{primary.id}</span>
                <span className="font-semibold text-fg">{primary.method}</span>
                <span className="truncate text-muted">{primary.path}</span>
                {comment.trim() && (
                  <span
                    style={
                      markedColor
                        ? {
                            borderColor: hexToRgba(markedColor, 0.55) ?? undefined,
                            backgroundColor:
                              hexToRgba(markedColor, 0.22) ?? undefined,
                          }
                        : undefined
                    }
                    className="inline-flex max-w-[220px] items-center gap-1 truncate rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.2 font-sans text-[11px] font-medium text-fg"
                  >
                    <span>💬</span>
                    <span className="truncate">{comment.trim()}</span>
                  </span>
                )}
              </div>
              <span className="shrink-0 text-[10px] text-subtle">SQLite ✓</span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-hairline pt-3">
          <div>
            {(hasExistingAnnotation || comment.trim() || markedColor) && (
              <button
                type="button"
                onClick={handleClear}
                className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-xs text-rose-400 hover:border-rose-500/40 hover:bg-rose-500/10"
              >
                <Eraser className="h-3.5 w-3.5" />
                <span>Очистить метку</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded-md border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-fg"
            >
              Отмена
            </button>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Сохранить аннотацию</span>
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
};
