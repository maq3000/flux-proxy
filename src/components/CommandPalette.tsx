import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { getSectionMeta } from "../lib/sectionRegistry";

export type PaletteCategoryGroupId =
  | "all"
  | "capture"
  | "network"
  | "filters"
  | "tools"
  | "settings";

export type PaletteSectionId =
  | "quickexec"
  | Exclude<PaletteCategoryGroupId, "all">;

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  group?: PaletteSectionId;
  description?: string;
  statusBadge?: string;
  shortcut?: string;
  keywords?: string[];
  perform: () => void;
}

export const PALETTE_CATEGORY_TABS: readonly {
  id: PaletteCategoryGroupId;
  label: string;
}[] = [
  { id: "all", label: "Все" },
  { id: "capture", label: "Захват" },
  { id: "network", label: "Сеть и Троттлинг" },
  { id: "filters", label: "Фильтры и TLS" },
  { id: "tools", label: "Инструменты" },
  { id: "settings", label: "Настройки" },
] as const;

const PALETTE_SECTION_META: Record<
  PaletteSectionId,
  { title: string; order: number }
> = {
  quickexec: { title: "Быстрые команды QuickExec", order: 0 },
  capture: { title: "Захват и Управление сессиями", order: 1 },
  network: { title: "Сеть, Троттлинг и Маршрутизация", order: 2 },
  filters: { title: "Фильтрация и HTTPS MITM", order: 3 },
  tools: { title: "Инструменты и Экспорт", order: 4 },
  settings: { title: "Настройки и Внешний вид", order: 5 },
};

const QUICK_EXEC_CHIPS: readonly {
  label: string;
  value: string;
  hint: string;
}[] = [
  {
    label: "bpu /api",
    value: "bpu ",
    hint: "Установить точку останова Before Request",
  },
  {
    label: "bpafter /graphql",
    value: "bpafter ",
    hint: "Установить точку останова After Response",
  },
  {
    label: "jwt <токен>",
    value: "jwt ",
    hint: "Декодировать JWT в TextWizard",
  },
  {
    label: "doctor",
    value: "doctor",
    hint: "Запустить диагностику Proxy Doctor",
  },
  {
    label: "mtls",
    value: "mtls",
    hint: "Открыть клиентские сертификаты (mTLS)",
  },
  {
    label: "waterfall",
    value: "waterfall",
    hint: "Переключить Traffic в режим Waterfall Timeline",
  },
  {
    label: "stats",
    value: "stats",
    hint: "Открыть сводную статистику трафика и Markdown-отчёт",
  },
] as const;

export function resolveCommandGroup(
  cmd: Pick<PaletteCommand, "category" | "group">
): PaletteSectionId {
  if (cmd.group) return cmd.group;
  const cat = cmd.category.trim().toLowerCase();
  if (cat === "quickexec") return "quickexec";
  if (
    cat === "traffic" ||
    cat === "annotations" ||
    cat === "inspector" ||
    cat === "storage" ||
    cat === "захват"
  ) {
    return "capture";
  }
  if (
    cat === "proxy" ||
    cat === "throttling" ||
    cat === "dns / routing" ||
    cat === "network" ||
    cat === "сеть"
  ) {
    return "network";
  }
  if (
    cat === "filters" ||
    cat === "preset" ||
    cat === "breakpoints" ||
    cat === "tls / ca" ||
    cat === "tls / mtls" ||
    cat === "фильтры"
  ) {
    return "filters";
  }
  if (
    cat === "tools" ||
    cat === "session diff" ||
    cat === "textwizard" ||
    cat === "autoresponder" ||
    cat === "scripting" ||
    cat === "diagnostics" ||
    cat === "security" ||
    cat === "benchmark" ||
    cat === "инструменты"
  ) {
    return "tools";
  }
  if (
    cat === "view" ||
    cat === "theme" ||
    cat === "settings" ||
    cat === "help" ||
    cat === "настройки"
  ) {
    return "settings";
  }
  return "tools";
}

function getStatusBadgeToneClass(badge: string): string {
  const normalized = badge.trim().toLowerCase();
  if (
    normalized.includes("ошибка") ||
    normalized.includes("error") ||
    normalized === "offline"
  ) {
    return "border-status5xx-fg/35 bg-status5xx-bg text-status5xx-fg";
  }
  if (
    normalized.includes("пауза") ||
    normalized.includes("в очереди") ||
    normalized.startsWith("block")
  ) {
    return "border-status4xx-fg/35 bg-status4xx-bg text-status4xx-fg";
  }
  if (
    normalized === "on" ||
    normalized.startsWith("on ") ||
    normalized === "активно" ||
    normalized.startsWith("активно:") ||
    normalized.startsWith("lan") ||
    normalized.startsWith("allow")
  ) {
    return "border-status2xx-fg/35 bg-status2xx-bg text-status2xx-fg";
  }
  if (
    normalized === "off" ||
    normalized.startsWith("off ") ||
    normalized === "выкл" ||
    normalized === "свёрнут" ||
    normalized === "0 правил" ||
    normalized === "0" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("local ") ||
    normalized.startsWith("clear ")
  ) {
    return "border-hairline bg-elevated text-subtle";
  }
  return "border-accent/35 bg-accent/15 text-accent";
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  onQuickExecBpu?: (stage: "request" | "response", pattern: string) => void;
  onQuickOpenJwt?: (token: string) => void;
  onQuickOpenSanitizedExport?: () => void;
  onQuickOpenProxyDoctor?: () => void;
  onQuickOpenClientCerts?: () => void;
  onQuickOpenTrafficStatistics?: () => void;
  onQuickOpenWaterfall?: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  commands,
  onQuickExecBpu,
  onQuickOpenJwt,
  onQuickOpenSanitizedExport,
  onQuickOpenProxyDoctor,
  onQuickOpenClientCerts,
  onQuickOpenTrafficStatistics,
  onQuickOpenWaterfall,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] =
    useState<PaletteCategoryGroupId>("all");
  const [activeIndex, setActiveIndex] = useState(0);

  const dynamicQuickExec = useMemo<PaletteCommand[]>(() => {
    const rawTrimmed = query.trim();
    const q = rawTrimmed.toLowerCase();
    if (!q) return [];

    const items: PaletteCommand[] = [];

    // Fiddler Classic QuickExec: `bpu <pattern>` or `bpu`
    if (onQuickExecBpu && (q === "bpu" || q.startsWith("bpu "))) {
      const arg = rawTrimmed.slice(3).trim();
      items.push({
        id: `quickexec-bpu-${arg || "clear"}`,
        category: "QuickExec",
        group: "quickexec",
        label: arg
          ? `Установить точку останова Before Request (bpu): «${arg}»`
          : "Очистить все условные точки останова Before Request (bpu)",
        description: arg
          ? "Приостанавливает запросы, чей URL содержит шаблон, для правки перед отправкой"
          : "Удаляет все активные правила условной паузы перед отправкой запроса",
        statusBadge: arg ? "Before Request" : "Clear BPU",
        shortcut: "Enter",
        perform: () => onQuickExecBpu("request", arg),
      });
    }

    // Fiddler Classic QuickExec: `bpafter <pattern>` or `bpafter`
    if (onQuickExecBpu && (q === "bpafter" || q.startsWith("bpafter "))) {
      const arg = rawTrimmed.slice(7).trim();
      items.push({
        id: `quickexec-bpafter-${arg || "clear"}`,
        category: "QuickExec",
        group: "quickexec",
        label: arg
          ? `Установить точку останова After Response (bpafter): «${arg}»`
          : "Очистить все условные точки останова After Response (bpafter)",
        description: arg
          ? "Перехватывает ответы сервера по шаблону URL для изменения статуса и тела"
          : "Удаляет все активные правила условной паузы после ответа сервера",
        statusBadge: arg ? "After Response" : "Clear BPAfter",
        shortcut: "Enter",
        perform: () => onQuickExecBpu("response", arg),
      });
    }

    // Instant JWT paste in QuickExec (`eyJ...` or `jwt eyJ...` or `jwt`)
    const jwtCandidate = q.startsWith("jwt ")
      ? rawTrimmed.slice(4).trim()
      : rawTrimmed;
    if (
      onQuickOpenJwt &&
      jwtCandidate.startsWith("eyJ") &&
      jwtCandidate.split(".").length >= 2
    ) {
      items.push({
        id: "quickexec-jwt-decode",
        category: "TextWizard",
        group: "quickexec",
        label:
          "Декодировать вставленный JWT-токен в TextWizard (Header + Claims + exp)",
        description:
          "Разберёт Base64URL-сегменты токена и проверит время истечения exp",
        statusBadge: "JWT",
        shortcut: "Enter",
        perform: () => onQuickOpenJwt(jwtCandidate),
      });
    } else if (onQuickOpenJwt && (q === "jwt" || q.startsWith("jwt "))) {
      items.push({
        id: "quickexec-jwt-open",
        category: "TextWizard",
        group: "quickexec",
        label: "Открыть JWT Inspector (или вставьте токен eyJ… после jwt )",
        description:
          "Откроет TextWizard на вкладке JWT Decoder для анализа токена",
        statusBadge: "JWT",
        shortcut: "Enter",
        perform: () => onQuickOpenJwt(""),
      });
    }

    if (
      onQuickOpenSanitizedExport &&
      (q.startsWith("sanitize") || q.startsWith("redact"))
    ) {
      items.push({
        id: "quickexec-sanitized-export",
        category: "Security",
        group: "quickexec",
        label: getSectionMeta("sanitizedExport").title,
        description: getSectionMeta("sanitizedExport").summary,
        statusBadge: "Security",
        shortcut: "Ctrl+Shift+S",
        perform: () => onQuickOpenSanitizedExport(),
      });
    }

    if (
      onQuickOpenProxyDoctor &&
      (q === "doctor" || q.startsWith("doctor ") || q === "health")
    ) {
      items.push({
        id: "quickexec-proxy-doctor",
        category: "Diagnostics",
        group: "quickexec",
        label: "Proxy Doctor",
        description:
          "Проверяет сокет прокси, доверие Root CA, системный прокси, VPN и loopback",
        statusBadge: "Диагностика",
        shortcut: "Ctrl+Shift+D",
        perform: () => onQuickOpenProxyDoctor(),
      });
    }

    if (
      onQuickOpenClientCerts &&
      (q === "mtls" ||
        q.startsWith("mtls ") ||
        q.startsWith("client cert") ||
        q === "p12" ||
        q === "pfx")
    ) {
      items.push({
        id: "quickexec-client-certs",
        category: "TLS / mTLS",
        group: "quickexec",
        label: "Client Certificates",
        description:
          "Управление клиентскими сертификатами mTLS для защищённых корпоративных API",
        statusBadge: "mTLS",
        shortcut: "Ctrl+Shift+C",
        perform: () => onQuickOpenClientCerts(),
      });
    }

    if (
      onQuickOpenTrafficStatistics &&
      (q === "stats" ||
        q.startsWith("stats ") ||
        q === "statistics" ||
        q === "report")
    ) {
      items.push({
        id: "quickexec-traffic-statistics",
        category: "Traffic",
        group: "quickexec",
        label: "Traffic Statistics — сводная статистика и Markdown-отчёт",
        description:
          "2xx–5xx/Pending, объём wire/decoded, Avg/Median/P95 Latency и TTFB, MIME, хосты, топ-5 URL",
        statusBadge: "Report",
        shortcut: "Enter",
        perform: () => onQuickOpenTrafficStatistics(),
      });
    }

    if (
      onQuickOpenWaterfall &&
      (q === "waterfall" || q.startsWith("waterfall ") || q === "timeline")
    ) {
      items.push({
        id: "quickexec-waterfall-timeline",
        category: "View",
        group: "quickexec",
        label: "Waterfall Timeline — многофазная каскадная диаграмма",
        description:
          "Переключить Traffic на виртуализированный таймлайн с фазами DNS / TCP / TLS / TTFB / Download",
        statusBadge: "Waterfall",
        shortcut: "Enter",
        perform: () => onQuickOpenWaterfall(),
      });
    }

    return items;
  }, [
    query,
    onQuickExecBpu,
    onQuickOpenJwt,
    onQuickOpenSanitizedExport,
    onQuickOpenProxyDoctor,
    onQuickOpenClientCerts,
    onQuickOpenTrafficStatistics,
    onQuickOpenWaterfall,
  ]);

  const matchedStatic = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        Boolean(c.description?.toLowerCase().includes(q)) ||
        Boolean(c.statusBadge?.toLowerCase().includes(q)) ||
        Boolean(c.keywords?.some((kw) => kw.toLowerCase().includes(q)))
    );
  }, [commands, query]);

  const categoryCounts = useMemo(() => {
    const counts: Record<PaletteCategoryGroupId, number> = {
      all: matchedStatic.length + dynamicQuickExec.length,
      capture: 0,
      network: 0,
      filters: 0,
      tools: 0,
      settings: 0,
    };
    for (const cmd of matchedStatic) {
      const grp = resolveCommandGroup(cmd);
      if (grp !== "quickexec") {
        counts[grp] += 1;
      }
    }
    return counts;
  }, [matchedStatic, dynamicQuickExec.length]);

  const { sections, flatItems } = useMemo(() => {
    const categoryFilteredStatic =
      activeCategory === "all"
        ? matchedStatic
        : matchedStatic.filter((c) => resolveCommandGroup(c) === activeCategory);

    const grouped = new Map<PaletteSectionId, PaletteCommand[]>();
    if (dynamicQuickExec.length > 0) {
      grouped.set("quickexec", dynamicQuickExec);
    }
    for (const cmd of categoryFilteredStatic) {
      const grp = resolveCommandGroup(cmd);
      const bucket = grouped.get(grp);
      if (bucket) {
        bucket.push(cmd);
      } else {
        grouped.set(grp, [cmd]);
      }
    }

    const orderedSectionIds = Array.from(grouped.keys()).sort(
      (a, b) => PALETTE_SECTION_META[a].order - PALETTE_SECTION_META[b].order
    );

    const builtSections: {
      id: PaletteSectionId;
      title: string;
      items: { cmd: PaletteCommand; flatIndex: number }[];
    }[] = [];
    const builtFlat: PaletteCommand[] = [];

    for (const secId of orderedSectionIds) {
      const cmds = grouped.get(secId) ?? [];
      if (cmds.length === 0) continue;
      const itemsWithIndex = cmds.map((cmd) => {
        const flatIndex = builtFlat.length;
        builtFlat.push(cmd);
        return { cmd, flatIndex };
      });
      builtSections.push({
        id: secId,
        title: PALETTE_SECTION_META[secId].title,
        items: itemsWithIndex,
      });
    }

    return { sections: builtSections, flatItems: builtFlat };
  }, [activeCategory, dynamicQuickExec, matchedStatic]);

  const clampedActiveIndex =
    flatItems.length === 0 ? 0 : Math.min(activeIndex, flatItems.length - 1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setQuery("");
      setActiveCategory("all");
      setActiveIndex(0);
      if (!dialog.open) {
        dialog.showModal();
      }
      inputRef.current?.focus();
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

  useEffect(() => {
    if (!open || flatItems.length === 0) return;
    const targetEl = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${clampedActiveIndex}"]`
    );
    targetEl?.scrollIntoView?.({ block: "nearest" });
  }, [open, clampedActiveIndex, flatItems.length]);

  const handleSelectCategory = (tabId: PaletteCategoryGroupId) => {
    setActiveCategory(tabId);
    setActiveIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleApplyQuickChip = (value: string) => {
    setQuery(value);
    setActiveCategory("all");
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange?.(value.length, value.length);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) =>
        Math.min(Math.max(flatItems.length - 1, 0), i + 1)
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Tab") {
      e.preventDefault();
      const idx = PALETTE_CATEGORY_TABS.findIndex(
        (t) => t.id === activeCategory
      );
      const delta = e.shiftKey ? -1 : 1;
      const nextIdx =
        (idx + delta + PALETTE_CATEGORY_TABS.length) %
        PALETTE_CATEGORY_TABS.length;
      setActiveCategory(PALETTE_CATEGORY_TABS[nextIdx].id);
      setActiveIndex(0);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } else if (e.key === "Enter" && flatItems[clampedActiveIndex]) {
      e.preventDefault();
      const target = flatItems[clampedActiveIndex];
      dialogRef.current?.close();
      target.perform();
    }
  };

  const isFiltered = query.trim().length > 0 || activeCategory !== "all";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="mx-auto mt-[8vh] mb-auto w-[min(92vw,820px)] max-w-3xl overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <h1 id={titleId} className="sr-only">
        Command Palette
      </h1>

      {/* Search Input Bar */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Команда, `bpu /api`, `bpafter /graphql` или вставьте JWT…"
          aria-label="Search commands"
          className="h-12 w-full bg-transparent text-base text-fg placeholder:text-subtle focus:outline-none"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setActiveIndex(0);
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
            aria-label="Очистить поиск"
            className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <kbd className="shrink-0 rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-subtle">
          ESC
        </kbd>
      </div>

      {/* Category Filter Pills & QuickExec Syntax Chips */}
      <div className="shrink-0 space-y-2 border-b border-hairline bg-canvas/40 px-4 py-2">
        <div
          role="group"
          aria-label="Категории команд"
          className="flex flex-wrap items-center gap-1.5"
        >
          {PALETTE_CATEGORY_TABS.map((tab) => {
            const isActive = activeCategory === tab.id;
            const count = categoryCounts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                data-category-tab={tab.id}
                aria-pressed={isActive}
                onClick={() => handleSelectCategory(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-accent/50 bg-selected text-fg"
                    : "border-hairline bg-surface/70 text-muted hover:border-strong hover:bg-hover hover:text-fg"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded px-1 font-mono text-[10px] tabular-nums ${
                    isActive
                      ? "bg-accent/15 text-accent"
                      : "bg-canvas text-subtle"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-medium text-subtle">Быстрые команды:</span>
          {QUICK_EXEC_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              data-quick-chip={chip.value}
              title={chip.hint}
              onClick={() => handleApplyQuickChip(chip.value)}
              className="inline-flex items-center rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[11px] text-muted transition-colors hover:border-accent/50 hover:bg-hover hover:text-fg"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped Results List */}
      <div ref={listRef} className="max-h-[62vh] overflow-y-auto px-2 py-2">
        {flatItems.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-muted">
              Подходящие команды не найдены.
            </p>
            <p className="mt-1 text-xs text-subtle">
              Попробуйте другой запрос, переключите категорию клавишей Tab или
              введите{" "}
              <code className="rounded bg-canvas px-1 py-0.5 font-mono">
                bpu /api
              </code>
              .
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {sections.map((section) => (
              <section key={section.id} aria-label={section.title}>
                <div className="sticky top-0 z-10 flex items-center justify-between bg-surface/95 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-subtle backdrop-blur-sm">
                  <span>{section.title}</span>
                  <span className="font-mono text-[10px] tabular-nums">
                    {section.items.length}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {section.items.map(({ cmd, flatIndex }) => {
                    const isSelected = flatIndex === clampedActiveIndex;
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        data-palette-index={flatIndex}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => {
                          dialogRef.current?.close();
                          cmd.perform();
                        }}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-left transition-colors ${
                          isSelected
                            ? "bg-selected text-fg ring-1 ring-accent/35"
                            : "text-muted hover:bg-hover hover:text-fg"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
                              {cmd.category}
                            </span>
                            <span className="truncate text-[13px] font-medium text-fg">
                              {cmd.label}
                            </span>
                          </div>
                          {cmd.description && (
                            <p className="mt-0.5 truncate text-xs text-muted">
                              {cmd.description}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {cmd.statusBadge && (
                            <span
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${getStatusBadgeToneClass(
                                cmd.statusBadge
                              )}`}
                            >
                              {cmd.statusBadge}
                            </span>
                          )}
                          {cmd.shortcut && (
                            <kbd className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                              {cmd.shortcut}
                            </kbd>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {/* Footer Navigation Hints & Counter */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas/60 px-4 py-2 text-[11px] text-subtle">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-fg">
              ↑↓
            </kbd>
            <span>Навигация</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-fg">
              Enter
            </kbd>
            <span>Выполнить</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-fg">
              Tab
            </kbd>
            <span>Категория</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-fg">
              Esc
            </kbd>
            <span>Закрыть</span>
          </span>
        </div>

        <span className="font-mono tabular-nums text-muted">
          {isFiltered
            ? `Найдено: ${flatItems.length} из ${commands.length}`
            : `Найдено: ${flatItems.length}`}
        </span>
      </div>
    </dialog>
  );
};
