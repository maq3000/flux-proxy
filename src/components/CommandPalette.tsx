import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  perform: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  onQuickExecBpu?: (stage: "request" | "response", pattern: string) => void;
  onQuickOpenJwt?: (token: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  commands,
  onQuickExecBpu,
  onQuickOpenJwt,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const rawTrimmed = query.trim();
    const q = rawTrimmed.toLowerCase();
    if (!q) return commands;

    const dynamicQuickExec: PaletteCommand[] = [];

    // Fiddler Classic QuickExec: `bpu <pattern>` or `bpu`
    if (onQuickExecBpu && (q === "bpu" || q.startsWith("bpu "))) {
      const arg = rawTrimmed.slice(3).trim();
      dynamicQuickExec.push({
        id: `quickexec-bpu-${arg || "clear"}`,
        category: "QuickExec",
        label: arg
          ? `Установить точку останова Before Request (bpu): «${arg}»`
          : "Очистить все условные точки останова Before Request (bpu)",
        shortcut: "Enter",
        perform: () => onQuickExecBpu("request", arg),
      });
    }

    // Fiddler Classic QuickExec: `bpafter <pattern>` or `bpafter`
    if (onQuickExecBpu && (q === "bpafter" || q.startsWith("bpafter "))) {
      const arg = rawTrimmed.slice(7).trim();
      dynamicQuickExec.push({
        id: `quickexec-bpafter-${arg || "clear"}`,
        category: "QuickExec",
        label: arg
          ? `Установить точку останова After Response (bpafter): «${arg}»`
          : "Очистить все условные точки останова After Response (bpafter)",
        shortcut: "Enter",
        perform: () => onQuickExecBpu("response", arg),
      });
    }

    // Instant JWT paste in QuickExec (`eyJ...` or `jwt eyJ...`)
    const jwtCandidate = q.startsWith("jwt ")
      ? rawTrimmed.slice(4).trim()
      : rawTrimmed;
    if (
      onQuickOpenJwt &&
      jwtCandidate.startsWith("eyJ") &&
      jwtCandidate.split(".").length >= 2
    ) {
      dynamicQuickExec.push({
        id: "quickexec-jwt-decode",
        category: "TextWizard",
        label: "Декодировать вставленный JWT-токен в TextWizard (Header + Claims + exp)",
        shortcut: "Enter",
        perform: () => onQuickOpenJwt(jwtCandidate),
      });
    }

    const matchedStatic = commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    );

    return [...dynamicQuickExec, ...matchedStatic];
  }, [commands, query, onQuickExecBpu, onQuickOpenJwt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setQuery("");
      setActiveIndex(0);
      if (!dialog.open) {
        dialog.showModal();
      }
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is missing
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      e.preventDefault();
      const target = filtered[activeIndex];
      dialogRef.current?.close();
      target.perform();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="mx-auto mt-[13vh] mb-auto w-full max-w-xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <h2 id={titleId} className="sr-only">
        Command Palette
      </h2>

      <div className="flex items-center border-b border-hairline px-3.5 py-2.5">
        <Search className="mr-2.5 h-4 w-4 text-subtle" />
        <input
          ref={inputRef}
          type="text"
          autoFocus
          {...({ autofocus: "" } as Record<string, string>)}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Команда, `bpu /api`, `bpafter /graphql` или вставьте JWT..."
          aria-label="Search commands"
          className="w-full bg-transparent text-sm text-fg placeholder:text-subtle focus:outline-none"
        />
        <kbd className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-subtle">
          ESC
        </kbd>
      </div>

      <div className="max-h-80 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-xs text-subtle">
            No matching commands found.
          </p>
        ) : (
          filtered.map((cmd, idx) => (
            <button
              key={cmd.id}
              type="button"
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => {
                dialogRef.current?.close();
                cmd.perform();
              }}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${
                idx === activeIndex
                  ? "bg-selected text-fg"
                  : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] uppercase text-sky-400">
                  {cmd.category}
                </span>
                <span className="font-medium text-fg">{cmd.label}</span>
              </div>
              {cmd.shortcut && (
                <kbd className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                  {cmd.shortcut}
                </kbd>
              )}
            </button>
          ))
        )}
      </div>
    </dialog>
  );
};
