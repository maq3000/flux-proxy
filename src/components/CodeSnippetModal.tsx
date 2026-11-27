import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Check, Code2, Copy, WrapText, X } from "lucide-react";
import {
  CODE_GENERATOR_TARGETS,
  CODE_LANGUAGE_GROUPS,
  generateCodeSnippet,
  getCodeGeneratorTarget,
  type CodeGeneratorId,
  type CodeGenRequest,
  type CodeLanguageGroupId,
} from "../lib/codeGenerators";
import { getMonacoThemeName } from "../lib/monaco";
import { SectionHeader } from "./ui/SectionHeader";

interface CodeSnippetModalProps {
  open: boolean;
  request: CodeGenRequest | null;
  resolvedTheme: "dark" | "light";
  onClose: () => void;
  onNotify?: (message: string) => void;
}

const TARGET_STORAGE_KEY = "fluxproxy.codeGenerator.target";

function loadPersistedTargetId(): CodeGeneratorId {
  try {
    const raw = window.localStorage.getItem(TARGET_STORAGE_KEY);
    if (raw && CODE_GENERATOR_TARGETS.some((t) => t.id === raw)) {
      return raw as CodeGeneratorId;
    }
  } catch {
    // ignore storage read errors
  }
  return "js-fetch";
}

function savePersistedTargetId(id: CodeGeneratorId): void {
  try {
    window.localStorage.setItem(TARGET_STORAGE_KEY, id);
  } catch {
    // ignore storage write errors
  }
}

export const CodeSnippetModal: React.FC<CodeSnippetModalProps> = ({
  open,
  request,
  resolvedTheme,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const copyTimerRef = useRef<number | null>(null);

  const [targetId, setTargetId] = useState<CodeGeneratorId>(() =>
    loadPersistedTargetId()
  );
  const [groupLastTarget, setGroupLastTarget] = useState<
    Record<CodeLanguageGroupId, CodeGeneratorId>
  >(() => {
    const initial = loadPersistedTargetId();
    const initialTarget = getCodeGeneratorTarget(initial);
    return {
      javascript:
        initialTarget.group === "javascript" ? initial : "js-fetch",
      python:
        initialTarget.group === "python" ? initial : "python-requests",
      go: "go-net-http",
      rust: "rust-reqwest",
      curl: initialTarget.group === "curl" ? initial : "curl-bash",
    };
  });
  const [copied, setCopied] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);

  const activeTarget = useMemo(
    () => getCodeGeneratorTarget(targetId),
    [targetId]
  );
  const activeGroup = useMemo(
    () =>
      CODE_LANGUAGE_GROUPS.find((g) => g.id === activeTarget.group) ??
      CODE_LANGUAGE_GROUPS[0],
    [activeTarget.group]
  );

  const generatedCode = useMemo(() => {
    if (!request) return "";
    return generateCodeSnippet(request, targetId);
  }, [request, targetId]);

  const lineCount = useMemo(
    () => (generatedCode ? generatedCode.split("\n").length : 0),
    [generatedCode]
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && request) {
      setCopied(false);
      if (!dialog.open) {
        dialog.showModal();
      }
      copyBtnRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, request]);

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
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const selectTarget = (nextId: CodeGeneratorId) => {
    const nextTarget = getCodeGeneratorTarget(nextId);
    setTargetId(nextId);
    setGroupLastTarget((prev) => ({
      ...prev,
      [nextTarget.group]: nextId,
    }));
    savePersistedTargetId(nextId);
    setCopied(false);
  };

  const selectLanguageGroup = (groupId: CodeLanguageGroupId) => {
    const preferred = groupLastTarget[groupId];
    const group = CODE_LANGUAGE_GROUPS.find((g) => g.id === groupId);
    const fallback = group?.targets[0]?.id ?? "js-fetch";
    selectTarget(preferred ?? fallback);
  };

  const handleCopyCode = async () => {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1800);
      onNotify?.(`Скопирован код: ${activeTarget.fullLabel}`);
    } catch {
      onNotify?.("Не удалось скопировать код в буфер обмена");
    }
  };

  const monacoTheme = getMonacoThemeName(resolvedTheme);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) {
          dialogRef.current.returnValue = "";
        }
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="fixed inset-0 m-0 h-screen w-screen max-h-none max-w-none overflow-hidden rounded-none border-0 bg-surface p-0 text-fg open:flex open:flex-col"
    >
      <SectionHeader
        sectionId="codeGenerator"
        titleId={titleId}
        headingLevel={1}
        icon={<Code2 className="h-4 w-4 text-accent" />}
        badges={
          <>
            {request?.sourceLabel && (
              <span className="shrink-0 rounded bg-canvas px-2 py-0.5 font-mono text-[10px] font-medium text-muted ring-1 ring-hairline">
                {request.sourceLabel}
              </span>
            )}
            {request && (
              <div className="hidden min-w-0 max-w-xl items-center gap-1.5 rounded bg-canvas/80 px-2 py-0.5 font-mono text-[11px] ring-1 ring-hairline sm:flex">
                <span className="shrink-0 font-bold text-sky-400">
                  {request.method}
                </span>
                <span className="truncate text-muted" title={request.url}>
                  {request.url}
                </span>
              </div>
            )}
          </>
        }
        actions={
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Закрыть Code Generator"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:border-strong hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        }
      />

      {/* Language & Library Switcher Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* 5 Primary Language Tabs */}
          <div
            role="tablist"
            aria-label="Целевой язык программирования"
            className="flex flex-wrap items-center gap-1 rounded-lg border border-hairline bg-canvas p-0.5"
          >
            {CODE_LANGUAGE_GROUPS.map((group) => {
              const isSelected = activeGroup.id === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => selectLanguageGroup(group.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    isSelected
                      ? "bg-elevated text-fg shadow-sm ring-1 ring-strong/70"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  {group.label}
                </button>
              );
            })}
          </div>

          {/* Library / Shell Variant Selector */}
          {activeGroup.targets.length > 1 ? (
            <div
              role="group"
              aria-label={`Библиотека для ${activeGroup.label}`}
              className="flex items-center gap-1 rounded-lg border border-hairline bg-canvas p-0.5"
            >
              {activeGroup.targets.map((variant) => {
                const isActiveVariant = variant.id === activeTarget.id;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    aria-pressed={isActiveVariant}
                    onClick={() => selectTarget(variant.id)}
                    className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
                      isActiveVariant
                        ? "bg-sky-500/15 font-semibold text-sky-400 ring-1 ring-sky-500/40"
                        : "text-muted hover:text-fg"
                    }`}
                  >
                    {variant.variantLabel}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-mono text-[11px] text-muted">
              {activeTarget.variantLabel}
            </span>
          )}
        </div>

        <button
          ref={copyBtnRef}
          type="button"
          autoFocus
          disabled={!generatedCode}
          onClick={() => void handleCopyCode()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{copied ? "Copied!" : "Copy Code"}</span>
        </button>
      </div>

      {/* Read-Only Monaco Editor */}
      <div className="min-h-0 flex-1 overflow-hidden bg-canvas">
        {open && request && (
          <Editor
            height="100%"
            language={activeTarget.monacoLanguage}
            theme={monacoTheme}
            value={generatedCode}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              wordWrap: wordWrap ? "on" : "off",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 10, bottom: 10 },
            }}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/50 px-4 py-2 text-[11px] text-muted">
        <div className="flex flex-wrap items-center gap-2 font-mono">
          <span className="text-fg">{activeTarget.fullLabel}</span>
          <span aria-hidden="true">•</span>
          <span>{lineCount} lines</span>
          {request?.isBinaryBody && (
            <>
              <span aria-hidden="true">•</span>
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-300">
                Бинарное тело запроса (Base64)
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={wordWrap}
            onClick={() => setWordWrap((v) => !v)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
              wordWrap
                ? "border-sky-500/50 bg-sky-500/15 text-sky-400"
                : "border-hairline bg-surface text-muted hover:text-fg"
            }`}
          >
            <WrapText className="h-3 w-3" aria-hidden="true" />
            <span>Word Wrap</span>
          </button>

          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded border border-strong bg-surface px-3 py-1 text-xs font-medium text-fg hover:bg-hover"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
};
