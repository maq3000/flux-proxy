import React, { useId, useMemo, useRef } from "react";
import {
  AlertTriangle,
  ClipboardPaste,
  Download,
  Eye,
  EyeOff,
  FileUp,
  Globe,
  Plus,
  Shield,
  Trash2,
} from "lucide-react";
import type { CompiledHostListFilter } from "../lib/filterEngine";
import type {
  HostListFilterConfig,
  HostListFilterMode,
  SessionSummary,
} from "../types/proxy";

const HOSTS_LIST_PLACEHOLDER = `# Вставьте домены, пути или маски (по одному на строку или через запятую/точку с запятой):
*.my-api.com
api.partner.org
https://auth.internal.corp:8443
regex:^https:\\/\\/(dev|stage)\\.app\\.com`;

interface HostFiltersTabProps {
  config: HostListFilterConfig;
  compiled: CompiledHostListFilter;
  sessions: SessionSummary[];
  onChange: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onNotify?: (message: string) => void;
}

export const HostFiltersTab: React.FC<HostFiltersTabProps> = ({
  config,
  compiled,
  sessions,
  onChange,
  onNotify,
}) => {
  const textareaId = useId();
  const hintId = useId();
  const errorId = useId();
  const tlsSyncDescId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectedHosts = useMemo(() => {
    const counts = new Map<string, number>();
    for (let i = 0; i < sessions.length; i++) {
      const raw = sessions[i].host?.trim().toLowerCase();
      if (!raw) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14);
  }, [sessions]);

  const handleModeChange = (mode: HostListFilterMode) => {
    onChange((prev) => ({
      ...prev,
      mode,
    }));
  };

  const handleRawTextChange = (nextText: string) => {
    onChange((prev) => {
      const autoEnable =
        !prev.enabled &&
        prev.rawText.trim().length === 0 &&
        nextText.trim().length > 0;
      return {
        ...prev,
        enabled: autoEnable ? true : prev.enabled,
        rawText: nextText,
      };
    });
  };

  const appendBlockToRawText = (incoming: string, sourceLabel: string) => {
    const normalized = incoming.replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      onNotify?.(`Буфер / файл пуст (${sourceLabel})`);
      return;
    }
    onChange((prev) => {
      const existing = prev.rawText.trimEnd();
      const combinedText = existing ? `${existing}\n${normalized}` : normalized;
      return {
        ...prev,
        enabled: true,
        rawText: combinedText,
      };
    });
    onNotify?.(`Список хостов обновлен (${sourceLabel})`);
  };

  const handlePasteFromClipboard = async () => {
    if (!navigator.clipboard?.readText) {
      onNotify?.("Чтение буфера обмена недоступно в текущем окружении");
      return;
    }
    try {
      const clipText = await navigator.clipboard.readText();
      if (!clipText.trim()) {
        onNotify?.("Буфер обмена пуст");
        return;
      }
      appendBlockToRawText(clipText, "буфер обмена");
    } catch {
      onNotify?.(
        "Не удалось прочитать буфер обмена — используйте Ctrl+V прямо в текстовом поле"
      );
    }
  };

  const handleImportFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      appendBlockToRawText(text, file.name);
    } catch {
      onNotify?.(`Не удалось прочитать файл «${file.name}»`);
    }
  };

  const handleExportTxt = () => {
    const content =
      config.rawText.trim().length > 0
        ? config.rawText
        : `${HOSTS_LIST_PLACEHOLDER}\n`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fluxproxy-hosts-${config.mode}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onNotify?.(`Экспортирован файл fluxproxy-hosts-${config.mode}.txt`);
  };

  const handleClear = () => {
    onChange((prev) => ({
      ...prev,
      rawText: "",
    }));
    onNotify?.("Список хостов очищен");
  };

  const handleQuickAppendHost = (host: string) => {
    onChange((prev) => {
      const lines = prev.rawText
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase());
      if (lines.includes(host.toLowerCase())) {
        return { ...prev, enabled: true };
      }
      const existing = prev.rawText.trimEnd();
      return {
        ...prev,
        enabled: true,
        rawText: existing ? `${existing}\n${host}` : host,
      };
    });
  };

  const isBackendSyncLive =
    config.enabled && config.applyToTlsPassthrough && compiled.activeCount > 0;

  const describedByIds =
    compiled.errors.length > 0 ? `${hintId} ${errorId}` : hintId;

  return (
    <div className="space-y-4">
      {/* Header & Master Toggle */}
      <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30">
              <Globe className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-fg">
                Массовый фильтр хостов и URL (Hosts List)
              </h3>
              <p className="mt-0.5 text-[11px] text-muted">
                Аналог вкладки Filters в Fiddler Classic: вставьте список из
                20–50+ доменов, URL, масок{" "}
                <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
                  *
                </code>{" "}
                или{" "}
                <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
                  regex:
                </code>{" "}
                для мгновенной фильтрации 50 000+ сессий за O(1).
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md border px-2 py-1 font-mono text-[11px] font-semibold tabular-nums ${
                config.enabled && compiled.activeCount > 0
                  ? config.mode === "whitelist"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  : "border-hairline bg-canvas text-muted"
              }`}
            >
              Правил: {compiled.activeCount}
            </span>

            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-strong bg-canvas px-2.5 py-1 text-xs font-medium text-fg hover:bg-hover">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) =>
                  onChange((prev) => ({ ...prev, enabled: e.target.checked }))
                }
                className="checkbox-native"
              />
              <span>Фильтр активен</span>
            </label>
          </div>
        </div>

        {/* Action Mode Radio Group (<fieldset> + <legend> + visible radio buttons) */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Режим действия
          </legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
                config.mode === "whitelist"
                  ? "border-emerald-500/60 bg-emerald-500/10"
                  : "border-hairline bg-canvas hover:border-strong hover:bg-hover"
              }`}
            >
              <input
                type="radio"
                name="hosts-list-mode"
                value="whitelist"
                checked={config.mode === "whitelist"}
                onChange={() => handleModeChange("whitelist")}
                className="mt-0.5 accent-emerald-500"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Eye
                    className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                    aria-hidden="true"
                  />
                  <span>Show only (Whitelist)</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  Отображать только указанные хосты и URL (скрывать весь
                  остальной фоновый трафик).
                </p>
              </div>
            </label>

            <label
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
                config.mode === "blacklist"
                  ? "border-amber-500/60 bg-amber-500/10"
                  : "border-hairline bg-canvas hover:border-strong hover:bg-hover"
              }`}
            >
              <input
                type="radio"
                name="hosts-list-mode"
                value="blacklist"
                checked={config.mode === "blacklist"}
                onChange={() => handleModeChange("blacklist")}
                className="mt-0.5 accent-amber-500"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <EyeOff
                    className="h-3.5 w-3.5 shrink-0 text-amber-400"
                    aria-hidden="true"
                  />
                  <span>Hide (Blacklist)</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  Скрывать указанные хосты, телеметрию и шумные домены из
                  таблицы сессий.
                </p>
              </div>
            </label>
          </div>
        </fieldset>
      </section>

      {/* Bulk Editable Textarea + Quick Management Toolbar */}
      <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor={textareaId}
            className="text-xs font-semibold text-fg"
          >
            Список доменов, URL, масок и регулярных выражений
          </label>

          {/* Quick Management Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.list,.conf,.hosts,text/plain"
              onChange={(e) => void handleImportFileChange(e)}
              className="hidden"
              tabIndex={-1}
            />

            <button
              type="button"
              onClick={() => void handlePasteFromClipboard()}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
            >
              <ClipboardPaste
                className="h-3.5 w-3.5 text-sky-400"
                aria-hidden="true"
              />
              <span>Вставить из буфера</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
            >
              <FileUp
                className="h-3.5 w-3.5 text-teal-400"
                aria-hidden="true"
              />
              <span>Импорт из .txt</span>
            </button>

            <button
              type="button"
              onClick={handleExportTxt}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
            >
              <Download
                className="h-3.5 w-3.5 text-indigo-400"
                aria-hidden="true"
              />
              <span>Экспорт в .txt</span>
            </button>

            <button
              type="button"
              onClick={handleClear}
              disabled={config.rawText.length === 0}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-hairline bg-canvas px-2.5 text-xs font-medium text-muted transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300 disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Очистить</span>
            </button>
          </div>
        </div>

        <p id={hintId} className="text-[11px] text-muted">
          Разделители: новая строка, запятая{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            ,
          </code>{" "}
          или точка с запятой{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            ;
          </code>
          . Строки, начинающиеся с{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            #
          </code>{" "}
          или{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            //
          </code>
          , игнорируются. Поддерживаются порты (
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            domain.com:8080
          </code>
          ), подстановочные знаки{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            *
          </code>{" "}
          (
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            *.example.com
          </code>
          ,{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            api.*.company.ru/*
          </code>
          ) и{" "}
          <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
            regex:
          </code>
          .
        </p>

        <textarea
          id={textareaId}
          value={config.rawText}
          onChange={(e) => handleRawTextChange(e.target.value)}
          placeholder={HOSTS_LIST_PLACEHOLDER}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={describedByIds}
          aria-invalid={compiled.errors.length > 0}
          className={`hosts-list-textarea rounded-md border bg-canvas p-3 font-mono text-xs leading-relaxed text-fg placeholder:text-subtle focus:outline-none ${
            compiled.errors.length > 0
              ? "border-rose-500/70 focus:border-rose-500"
              : "border-strong focus:border-sky-500"
          }`}
        />

        {/* Compiled Cache Breakdown Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-muted">
          <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
            <span>Exact Set: {compiled.exactCount}</span>
            <span>Wildcard *: {compiled.wildcardCount}</span>
            <span>RegExp: {compiled.regexCount}</span>
          </div>
          {!config.enabled && compiled.activeCount > 0 && (
            <span className="text-amber-300">
              Список заполнен ({compiled.activeCount}), но переключатель «Фильтр
              активен» выключен
            </span>
          )}
        </div>

        {/* Validation Errors for malformed `regex:` rules */}
        {compiled.errors.length > 0 && (
          <div
            id={errorId}
            role="alert"
            className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-300 space-y-1"
          >
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>
                Ошибки синтаксиса RegExp ({compiled.errors.length}) — остальные
                правила продолжают работать:
              </span>
            </div>
            <ul className="list-disc pl-5 font-mono text-[11px] space-y-0.5">
              {compiled.errors.map((err, idx) => (
                <li key={`${err.line}-${idx}`}>
                  Строка {err.line} ({err.token}): {err.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Backend TLS Passthrough (Bypass) Sync Checkbox */}
      <section className="rounded-lg border border-hairline bg-surface p-3.5">
        <div className="flex items-start justify-between gap-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={config.applyToTlsPassthrough}
              aria-describedby={tlsSyncDescId}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  applyToTlsPassthrough: e.target.checked,
                }))
              }
              className="checkbox-native mt-0.5"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-fg">
                  Применять также к TLS Passthrough (Bypass) на бэкенде
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                    isBackendSyncLive
                      ? "bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/30"
                      : "bg-elevated text-subtle"
                  }`}
                >
                  <Shield className="h-3 w-3" aria-hidden="true" />
                  {isBackendSyncLive ? "Rust Sync ON" : "UI Only"}
                </span>
              </div>
              <p
                id={tlsSyncDescId}
                className="mt-1 text-[11px] leading-relaxed text-muted"
              >
                {config.mode === "whitelist"
                  ? "В режиме Show only (Whitelist) Rust ProxyFilterEngine будет расшифровывать (MITM) только хосты из этого списка, а все остальные HTTPS CONNECT-туннели пробрасывать напрямую через TCP (tokio::io::copy_bidirectional) без подмены сертификата."
                  : "В режиме Hide (Blacklist) указанные в списке хосты будут автоматически добавлены в прямой TLS Passthrough (Bypass) на бэкенде без генерации MITM-сертификата (сохраняя Certificate Pinning и mTLS)."}
              </p>
            </div>
          </label>
        </div>
      </section>

      {/* Quick 1-click Host Picker from Captured Sessions */}
      {detectedHosts.length > 0 && (
        <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-muted">
              Быстрое добавление доменов из захваченных сессий (
              {detectedHosts.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {detectedHosts.map(([host, count]) => (
              <button
                key={host}
                type="button"
                onClick={() => handleQuickAppendHost(host)}
                title={`Добавить ${host} в список`}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[11px] text-fg transition-colors hover:border-sky-500/50 hover:bg-hover"
              >
                <Plus
                  className="h-3 w-3 text-sky-400 shrink-0"
                  aria-hidden="true"
                />
                <span className="max-w-[220px] truncate">{host}</span>
                <span className="text-[10px] text-subtle tabular-nums">
                  ({count})
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
