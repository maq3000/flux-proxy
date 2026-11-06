import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { DiffEditor, type MonacoDiffEditor } from "@monaco-editor/react";
import {
  ArrowDownAz,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  FilterX,
  GitCompareArrows,
  Maximize2,
  MessageSquarePlus,
  Rows2,
  WrapText,
  X,
} from "lucide-react";
import { formatBytes, formatDuration } from "../lib/formatters";
import {
  buildSessionDiffBundle,
  type DiffNormalizationOptions,
} from "../lib/sessionDiff";
import type {
  DiffTabId,
  SessionDetail,
  SessionSummary,
} from "../types/proxy";

const DIFF_TABS: { id: DiffTabId; label: string; hint: string }[] = [
  {
    id: "full",
    label: "Full HTTP",
    hint: "Полное сравнение запроса и ответа (заголовки, куки и тело)",
  },
  {
    id: "headers",
    label: "Headers",
    hint: "Построчный Diff заголовков Request и Response",
  },
  {
    id: "cookies",
    label: "Cookies & Auth",
    hint: "Построчное сравнение Cookie, Set-Cookie и декодированных JWT claims",
  },
  {
    id: "request",
    label: "Req Payload",
    hint: "Сравнение Query-параметров, форм и JSON-пейлоада запроса",
  },
  {
    id: "response",
    label: "Resp JSON / Body",
    hint: "Построчное сравнение JSON / текста ответа",
  },
];

interface SessionDiffViewProps {
  leftDetail: SessionDetail | null;
  rightDetail: SessionDetail | null;
  sessions?: SessionSummary[];
  resolvedTheme: "dark" | "light";
  defaultSideBySide?: boolean;
  onSelectPair?: (leftId: number, rightId: number) => void;
  onSwapPair: () => void;
  onAnnotateSession?: (id: number) => void;
  onExpandModal?: () => void;
  onCloseDiff?: () => void;
  closeLabel?: string;
}

export const SessionDiffView: React.FC<SessionDiffViewProps> = ({
  leftDetail,
  rightDetail,
  sessions,
  resolvedTheme,
  defaultSideBySide = true,
  onSelectPair,
  onSwapPair,
  onAnnotateSession,
  onExpandModal,
  onCloseDiff,
  closeLabel = "К инспектору",
}) => {
  const instanceUid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const origModelPath = `inmemory://fluxproxy-diff/${instanceUid}/original`;
  const modModelPath = `inmemory://fluxproxy-diff/${instanceUid}/modified`;

  const diffEditorRef = useRef<MonacoDiffEditor | null>(null);
  const [activeTab, setActiveTab] = useState<DiffTabId>("full");
  const [sortKeysAndHeaders, setSortKeysAndHeaders] = useState(true);
  const [ignoreVolatileHeaders, setIgnoreVolatileHeaders] = useState(true);
  const [sideBySide, setSideBySide] = useState(defaultSideBySide);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [diffHunkCount, setDiffHunkCount] = useState<number>(0);
  const [copiedSide, setCopiedSide] = useState<"left" | "right" | null>(null);

  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  const normOpts = useMemo<DiffNormalizationOptions>(
    () => ({
      sortKeysAndHeaders,
      ignoreVolatileHeaders,
    }),
    [sortKeysAndHeaders, ignoreVolatileHeaders]
  );

  const bundle = useMemo(() => {
    if (!leftDetail || !rightDetail) return null;
    return buildSessionDiffBundle(leftDetail, rightDetail, normOpts);
  }, [leftDetail, rightDetail, normOpts]);

  const activeSection = bundle ? bundle[activeTab] : null;

  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    const changes = editor.getLineChanges();
    setDiffHunkCount(changes?.length ?? 0);
  }, [activeSection?.original, activeSection?.modified, activeTab]);

  const handleCopyContent = async (side: "left" | "right") => {
    if (!activeSection) return;
    const text =
      side === "left" ? activeSection.original : activeSection.modified;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSide(side);
      window.setTimeout(() => setCopiedSide(null), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  if (!leftDetail || !rightDetail || !bundle || !activeSection) {
    return (
      <div className="pane-contain flex h-full flex-col items-center justify-center gap-2 bg-surface p-6 text-center text-xs text-muted">
        <GitCompareArrows className="h-7 w-7 text-sky-400/80" />
        <p className="font-semibold text-fg">Session Diff (Monaco DiffEditor)</p>
        <p className="max-w-sm leading-relaxed text-subtle">
          Выделите две строки в <code className="text-fg">TrafficGrid</code> с зажатым{" "}
          <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-fg">
            Ctrl+Click
          </kbd>{" "}
          или{" "}
          <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-fg">
            Shift+Click
          </kbd>{" "}
          (либо нажмите иконку сравнения в строке), чтобы увидеть построчную разницу заголовков, кук и JSON-пейлоада.
        </p>
      </div>
    );
  }

  const leftSum = leftDetail.summary;
  const rightSum = rightDetail.summary;
  const deltaDuration = rightSum.durationMs - leftSum.durationMs;
  const deltaSize = rightSum.bodySize - leftSum.bodySize;

  return (
    <div className="pane-contain flex h-full flex-col overflow-hidden bg-surface">
      {/* Top Comparison Header: Session A vs Session B */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
          {/* Left Session A */}
          <SessionEndpointPill
            badge="A"
            badgeClass="bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
            summary={leftSum}
            sessions={sessions}
            onSelectId={
              onSelectPair ? (id) => onSelectPair(id, rightSum.id) : undefined
            }
            onAnnotate={
              onAnnotateSession ? () => onAnnotateSession(leftSum.id) : undefined
            }
          />

          {/* Swap A <-> B */}
          <button
            type="button"
            onClick={onSwapPair}
            title="Поменять местами базовую (A) и сравниваемую (B) сессии"
            className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface px-1.5 text-muted transition-colors hover:border-sky-500/50 hover:text-sky-300"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>

          {/* Right Session B */}
          <SessionEndpointPill
            badge="B"
            badgeClass="bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40"
            summary={rightSum}
            sessions={sessions}
            onSelectId={
              onSelectPair ? (id) => onSelectPair(leftSum.id, id) : undefined
            }
            onAnnotate={
              onAnnotateSession
                ? () => onAnnotateSession(rightSum.id)
                : undefined
            }
          />

          {/* Delta Metrics Pill */}
          <span
            title="Разница времени и размера ответа (B относительно A)"
            className="hidden items-center gap-1.5 rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[10px] text-muted tabular-nums 2xl:inline-flex"
          >
            <span>
              ΔTime: {deltaDuration >= 0 ? "+" : ""}
              {formatDuration(Math.abs(deltaDuration)).replace(
                /^/,
                deltaDuration < 0 ? "-" : ""
              )}
            </span>
            <span>•</span>
            <span>
              ΔSize: {deltaSize >= 0 ? "+" : "-"}
              {formatBytes(Math.abs(deltaSize))}
            </span>
          </span>
        </div>

        {/* Right Actions: Expand / Close */}
        <div className="flex shrink-0 items-center gap-1.5">
          {onExpandModal && (
            <button
              type="button"
              onClick={onExpandModal}
              title="Развернуть Session Diff в широком модальном окне (Ctrl+D)"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] font-medium text-fg transition-colors hover:border-sky-500/50 hover:text-sky-300"
            >
              <Maximize2 className="h-3 w-3" />
              <span className="hidden xl:inline">На весь экран</span>
            </button>
          )}
          {onCloseDiff && (
            <button
              type="button"
              onClick={onCloseDiff}
              title={closeLabel}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{closeLabel}</span>
            </button>
          )}
        </div>
      </div>

      {/* Diff Scope Tabs & Normalization Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-2.5 py-1.5">
        <div className="flex items-center gap-1 overflow-x-auto">
          {DIFF_TABS.map((t) => {
            const hasDiff = bundle[t.id].hasDiff;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                title={t.hint}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  isActive
                    ? "bg-elevated text-fg ring-1 ring-strong"
                    : hasDiff
                      ? "text-amber-300 hover:bg-hover hover:text-fg"
                      : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <span>{t.label}</span>
                {hasDiff ? (
                  <span
                    title="Обнаружены различия"
                    className="h-1.5 w-1.5 rounded-full bg-amber-400"
                  />
                ) : (
                  <span
                    title="Идентично"
                    className="font-mono text-[9px] text-emerald-400/80"
                  >
                    =
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Normalization & Diff Navigation Controls */}
        <div className="flex items-center gap-1">
          {/* Diff Hunk Stepper */}
          <div className="mr-1 inline-flex items-center rounded-md border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted tabular-nums">
            <span
              className={
                activeSection.hasDiff ? "text-amber-300" : "text-emerald-400"
              }
            >
              {activeSection.hasDiff
                ? `${diffHunkCount || "•"} diff`
                : "Identical"}
            </span>
            <button
              type="button"
              disabled={!activeSection.hasDiff}
              onClick={() => diffEditorRef.current?.goToDiff("previous")}
              title="Предыдущее отличие"
              className="ml-1 rounded p-0.5 hover:bg-hover hover:text-fg disabled:opacity-35"
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={!activeSection.hasDiff}
              onClick={() => diffEditorRef.current?.goToDiff("next")}
              title="Следующее отличие"
              className="rounded p-0.5 hover:bg-hover hover:text-fg disabled:opacity-35"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setSortKeysAndHeaders((v) => !v)}
            aria-pressed={sortKeysAndHeaders}
            title="Сортировать ключи JSON, куки и HTTP-заголовки по алфавиту для чистого структурного сравнения"
            className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors ${
              sortKeysAndHeaders
                ? "border-sky-500/40 bg-sky-500/15 text-sky-300"
                : "border-hairline bg-canvas text-muted hover:text-fg"
            }`}
          >
            <ArrowDownAz className="h-3 w-3" />
            <span className="hidden lg:inline">Sort Keys</span>
          </button>

          <button
            type="button"
            onClick={() => setIgnoreVolatileHeaders((v) => !v)}
            aria-pressed={ignoreVolatileHeaders}
            title="Скрывать шумовые заголовки (Date, X-Request-Id, Age, ETag, Content-Length)"
            className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors ${
              ignoreVolatileHeaders
                ? "border-teal-500/40 bg-teal-500/15 text-teal-300"
                : "border-hairline bg-canvas text-muted hover:text-fg"
            }`}
          >
            <FilterX className="h-3 w-3" />
            <span className="hidden lg:inline">No-Noise</span>
          </button>

          <button
            type="button"
            onClick={() => setSideBySide((v) => !v)}
            aria-pressed={sideBySide}
            title={
              sideBySide
                ? "Переключить в компактный Inline Diff"
                : "Переключить в двухколоночный Side-by-Side Diff"
            }
            className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors ${
              sideBySide
                ? "border-violet-500/40 bg-violet-500/15 text-violet-300"
                : "border-hairline bg-canvas text-muted hover:text-fg"
            }`}
          >
            {sideBySide ? (
              <Columns2 className="h-3 w-3" />
            ) : (
              <Rows2 className="h-3 w-3" />
            )}
            <span className="hidden xl:inline">
              {sideBySide ? "Split" : "Inline"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setWordWrap((w) => (w === "on" ? "off" : "on"))}
            aria-pressed={wordWrap === "on"}
            title="Перенос длинных строк (Word Wrap)"
            className={`inline-flex h-6 items-center rounded border px-1.5 text-[10px] transition-colors ${
              wordWrap === "on"
                ? "border-strong bg-elevated text-fg"
                : "border-hairline bg-canvas text-muted hover:text-fg"
            }`}
          >
            <WrapText className="h-3 w-3" />
          </button>

          <button
            type="button"
            onClick={() => void handleCopyContent("right")}
            title="Скопировать правую панель (B)"
            className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-canvas px-1.5 text-[10px] text-muted hover:text-fg"
          >
            {copiedSide === "right" ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {/* Monaco DiffEditor Surface */}
      <div className="flex-1 overflow-hidden bg-canvas">
        <DiffEditor
          height="100%"
          theme={monacoTheme}
          language={activeSection.language}
          original={activeSection.original}
          modified={activeSection.modified}
          originalModelPath={origModelPath}
          modifiedModelPath={modModelPath}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          onMount={(editor, monaco) => {
            diffEditorRef.current = editor;
            setDiffHunkCount(editor.getLineChanges()?.length ?? 0);
            const sub = editor.onDidUpdateDiff(() => {
              setDiffHunkCount(editor.getLineChanges()?.length ?? 0);
            });
            editor.onDidDispose(() => {
              sub.dispose();
              diffEditorRef.current = null;
              // Dispose text models strictly AFTER DiffEditorWidget has detached them
              monaco.editor
                .getModel(monaco.Uri.parse(origModelPath))
                ?.dispose();
              monaco.editor
                .getModel(monaco.Uri.parse(modModelPath))
                ?.dispose();
            });
          }}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: sideBySide,
            useInlineViewWhenSpaceIsLimited: true,
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap,
            diffWordWrap: wordWrap,
            scrollBeyondLastLine: false,
            renderIndicators: true,
            ignoreTrimWhitespace: false,
          }}
        />
      </div>
    </div>
  );
};

const SessionEndpointPill: React.FC<{
  badge: string;
  badgeClass: string;
  summary: SessionSummary;
  sessions?: SessionSummary[];
  onSelectId?: (id: number) => void;
  onAnnotate?: () => void;
}> = ({ badge, badgeClass, summary, sessions, onSelectId, onAnnotate }) => {
  const statusTone =
    summary.status >= 400
      ? "bg-rose-500/20 text-rose-300"
      : summary.status >= 300
        ? "bg-amber-500/20 text-amber-300"
        : "bg-emerald-500/15 text-emerald-400";

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2 py-1 font-mono text-[11px]">
      <span
        style={
          summary.markedColor
            ? { boxShadow: `0 0 0 2px ${summary.markedColor}` }
            : undefined
        }
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${badgeClass}`}
      >
        {badge}
      </span>

      {sessions && sessions.length > 0 && onSelectId ? (
        <select
          value={summary.id}
          onChange={(e) => onSelectId(Number(e.target.value))}
          aria-label={`Выбрать сессию ${badge} для сравнения`}
          className="max-w-[240px] truncate bg-transparent text-[11px] text-fg focus:outline-none"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id} className="bg-surface text-fg">
              #{s.id} [{s.status}] {s.method} {s.host}
              {s.path.slice(0, 36)}
              {s.comment ? ` — 💬 ${s.comment}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <span
          className="max-w-[180px] truncate text-fg"
          title={`#${summary.id} ${summary.method} ${summary.url}${summary.comment ? ` • ${summary.comment}` : ""}`}
        >
          <span className="text-subtle">#{summary.id}</span>{" "}
          <span className="font-semibold">{summary.method}</span>{" "}
          <span>{summary.path}</span>
        </span>
      )}

      <span className={`shrink-0 rounded px-1 py-0.2 text-[10px] font-semibold ${statusTone}`}>
        {summary.status}
      </span>

      {summary.comment && (
        <span
          title={summary.comment}
          className="hidden max-w-[130px] truncate rounded bg-amber-500/15 px-1.5 py-0.2 font-sans text-[10px] text-amber-300 xl:inline"
        >
          💬 {summary.comment}
        </span>
      )}

      {onAnnotate && (
        <button
          type="button"
          onClick={onAnnotate}
          title={`Добавить или изменить заметку сессии #${summary.id} (M)`}
          className="shrink-0 rounded p-0.5 text-subtle hover:bg-hover hover:text-amber-300"
        >
          <MessageSquarePlus className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

interface SessionDiffModalProps {
  open: boolean;
  leftDetail: SessionDetail | null;
  rightDetail: SessionDetail | null;
  sessions: SessionSummary[];
  resolvedTheme: "dark" | "light";
  onSelectPair: (leftId: number, rightId: number) => void;
  onSwapPair: () => void;
  onAnnotateSession: (id: number) => void;
  onClose: () => void;
}

export const SessionDiffModal: React.FC<SessionDiffModalProps> = ({
  open,
  leftDetail,
  rightDetail,
  sessions,
  resolvedTheme,
  onSelectPair,
  onSwapPair,
  onAnnotateSession,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto h-[90vh] w-[95vw] max-w-7xl overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-sky-400" />
          <h2 id={titleId} className="text-sm font-semibold">
            Session Diff — Сравнение двух HTTP/HTTPS сессий (Monaco DiffEditor)
          </h2>
          <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            Ctrl+D
          </kbd>
        </div>

        <form method="dialog">
          <button
            ref={closeBtnRef}
            value="cancel"
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            aria-label="Закрыть окно Session Diff"
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-elevated px-2.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
            <span>Esc</span>
          </button>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {open && (
          <SessionDiffView
            leftDetail={leftDetail}
            rightDetail={rightDetail}
            sessions={sessions}
            resolvedTheme={resolvedTheme}
            defaultSideBySide
            onSelectPair={onSelectPair}
            onSwapPair={onSwapPair}
            onAnnotateSession={onAnnotateSession}
          />
        )}
      </div>
    </dialog>
  );
};
