import React, { useEffect, useId, useRef } from "react";
import { Keyboard, X } from "lucide-react";
import { SectionHeader } from "./ui/SectionHeader";

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
      { keys: "↑ / ↓", description: "Перемещение по строкам таблицы Traffic" },
      {
        keys: "Shift + ↑ / ↓",
        description: "Множественное выделение диапазона строк",
      },
      {
        keys: "Ctrl+A / Cmd+A",
        description: "Выделить все видимые сессии в таблице",
      },
      { keys: "PageUp / PageDown", description: "Прокрутка на экран вверх / вниз" },
      { keys: "Home / End", description: "Переход к первой / последней сессии" },
      {
        keys: "Space / Enter",
        description: "Открыть и переключить фокус на Session Inspector",
      },
      {
        keys: "Ctrl+1 … Ctrl+6",
        description:
          "Вкладки активной панели Inspector: 1 Headers, 2 JSON/Raw, 3 Cookies/Params, 4 Auth, 5 Raw, 6 Hex",
      },
      { keys: "Esc", description: "Сбросить множественное выделение / вернуться к таблице" },
    ],
  },
  {
    title: "Действия с сессиями",
    items: [
      { keys: "R / Ctrl+R", description: "Повторить выбранный запрос в upstream (Replay)" },
      {
        keys: "E",
        description: "Открыть и отредактировать выбранную сессию в Composer",
      },
      { keys: "Ctrl+S / Cmd+S", description: "Сохранить все сессии в архив (.har, .saz, .json)" },
      {
        keys: "Ctrl+Shift+S",
        description: "Открыть Sanitized Export (очистка токенов и PII)",
      },
      { keys: "Ctrl+O / Cmd+O", description: "Открыть / импортировать архив (.har, .saz, .json)" },
      { keys: "M", description: "Открыть Comment & Mark для выбранных сессий" },
      { keys: "U", description: "Снять цветовую метку (Unmark)" },
      { keys: "Ctrl+C / Cmd+C", description: "Скопировать URL выбранной сессии" },
      { keys: "Delete / Backspace", description: "Удалить выбранные сессии из списка" },
      { keys: "Ctrl+X / Cmd+X", description: "Очистить все захваченные сессии" },
      { keys: "Ctrl+D", description: "Переключить вкладку Session Diff" },
    ],
  },
  {
    title: "Вкладки, прокси и инструменты",
    items: [
      { keys: "F12", description: "Включить / приостановить захват трафика (Capture)" },
      { keys: "Ctrl+F", description: "Фокус на строку быстрого поиска и фильтрации" },
      { keys: "F11 / Alt+F11", description: "Переключить Break Before Request / After Response" },
      { keys: "Shift+F11", description: "Снять все точки останова" },
      { keys: "Ctrl+B", description: "Свернуть / развернуть боковую панель (Sidebar)" },
      {
        keys: "Ctrl+Shift+T",
        description: "Переключить компактный режим тулбара",
      },
      { keys: "Ctrl+Shift+M", description: "Открыть Settings → Mobile Setup" },
      { keys: "Ctrl+Shift+C", description: "Открыть Settings → Client Certificates" },
      { keys: "Ctrl+Shift+H", description: "Открыть Settings → HOSTS Remapping" },
      { keys: "Ctrl+Shift+U", description: "Открыть Settings → Upstream Proxy" },
      { keys: "Ctrl+Shift+D", description: "Открыть Settings → Proxy Doctor" },
      { keys: "Ctrl+E", description: "Переключить вкладку TextWizard" },
      {
        keys: "Alt+1 … Alt+6",
        description:
          "Разделы: 1 Traffic, 2 Composer, 3 AutoResponder, 4 Settings → Filters, 5 Scripts, 6 Breakpoints",
      },
      {
        keys: "Ctrl+, / Cmd+,",
        description: "Открыть Settings",
      },
      { keys: "Ctrl+K", description: "Открыть Command Palette" },
      { keys: "?", description: "Открыть / закрыть Shortcuts" },
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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="fixed inset-0 m-0 h-screen w-screen max-h-none max-w-none overflow-hidden rounded-none border-0 bg-surface p-0 text-fg open:flex open:flex-col"
    >
      <SectionHeader
        sectionId="shortcuts"
        titleId={titleId}
        headingLevel={1}
        icon={<Keyboard className="h-4 w-4 text-accent" />}
        actions={
          <button
            type="button"
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            onClick={() => dialogRef.current?.close()}
            aria-label="Закрыть Shortcuts"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:border-strong hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6 text-xs">
        <div className="mx-auto grid max-w-6xl gap-4 md:grid-cols-2 lg:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <div
              key={group.title}
              className="space-y-2 rounded-lg border border-hairline bg-canvas p-4"
            >
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                {group.title}
              </h2>
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
      </div>
    </dialog>
  );
};
