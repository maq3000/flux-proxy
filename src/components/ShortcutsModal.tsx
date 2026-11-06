import React, { useEffect, useId, useRef } from "react";
import { Keyboard, X } from "lucide-react";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUT_GROUPS: {
  title: string;
  items: { keys: string; description: string }[];
}[] = [
  {
    title: "Навигация и выделение сессий",
    items: [
      { keys: "↑ / ↓", description: "Перемещение по строкам таблицы сессий" },
      {
        keys: "Shift + ↑ / ↓",
        description: "Множественное выделение диапазона строк",
      },
      { keys: "PageUp / PageDown", description: "Прокрутка на экран вверх / вниз" },
      { keys: "Home / End", description: "Переход к первой / последней сессии" },
      {
        keys: "Space / Enter",
        description: "Открыть и переключить фокус на Session Inspector",
      },
      { keys: "Esc", description: "Сбросить множественное выделение / вернуться к таблице" },
    ],
  },
  {
    title: "Действия с сессиями",
    items: [
      { keys: "R / Ctrl+R", description: "Replay — повторить запрос в upstream" },
      { keys: "M", description: "Добавить / изменить комментарий и маркер сессии" },
      { keys: "U", description: "Снять цветовую метку (Unmark)" },
      { keys: "Ctrl+C / Cmd+C", description: "Скопировать URL выбранной сессии" },
      { keys: "Delete / Backspace", description: "Удалить выбранные сессии из списка" },
      { keys: "Ctrl+X / Cmd+X", description: "Очистить все захваченные сессии (Clear All)" },
      { keys: "Ctrl+D", description: "Открыть сравнение двух сессий (Session Diff)" },
    ],
  },
  {
    title: "Прокси, поиск и интерфейс",
    items: [
      { keys: "F12", description: "Включить / приостановить захват трафика (Capture)" },
      { keys: "Ctrl+F", description: "Фокус на строку быстрого поиска и фильтрации" },
      { keys: "F11 / Alt+F11", description: "Точки останова Break on Request / Response" },
      { keys: "Shift+F11", description: "Снять все точки останова" },
      { keys: "Ctrl+B", description: "Свернуть / развернуть боковую панель (Sidebar)" },
      { keys: "Ctrl+Shift+M", description: "Connect Mobile Device — iOS / Android Wi-Fi Proxy + QR" },
      { keys: "Ctrl+E", description: "Открыть Text Wizard & JWT Decoder" },
      { keys: "Ctrl+K", description: "Открыть палитру команд (Command Palette)" },
    ],
  },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({
  open,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

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
      onClose={onClose}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-2xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-accent" />
          <h2 id={titleId} className="text-sm font-semibold">
            Горячие клавиши FluxProxy
          </h2>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть справку по горячим клавишам"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid max-h-[75vh] gap-4 overflow-y-auto p-4 text-xs md:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <div
            key={group.title}
            className="space-y-2 rounded-lg border border-hairline bg-canvas p-3 md:last:col-span-2"
          >
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              {group.title}
            </h3>
            <div className="divide-y divide-hairline/70">
              {group.items.map((item) => (
                <div
                  key={item.keys}
                  className="flex items-center justify-between gap-3 py-1.5"
                >
                  <span className="text-muted">{item.description}</span>
                  <kbd className="shrink-0 rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-fg">
                    {item.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </dialog>
  );
};
