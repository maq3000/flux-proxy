import React, { useEffect, useState } from "react";
import { Check, Database, Trash2 } from "lucide-react";
import { HelpTooltip } from "../ui/HelpTooltip";
import { BindConfigSection, type BindConfigSectionProps } from "./BindConfigSection";
import {
  SESSION_RETENTION_PRESETS,
  type ProxyStatus,
  type StorageStats,
} from "../../types/proxy";

function validatePortString(raw: string): number | null {
  const clean = raw.trim();
  if (!/^\d+$/.test(clean)) return null;
  const num = Number(clean);
  if (!Number.isInteger(num) || num < 1 || num > 65535) return null;
  return num;
}

export interface GeneralSettingsTabProps {
  baseId: string;
  followTail: boolean;
  onSetFollowTail: (follow: boolean) => void;
  status: ProxyStatus;
  activeEndpointsSummary: string;
  sysProxyTargetHost: string;
  onSetProxyPort: (port: number) => Promise<void>;
  onSetAutoSystemProxy: (auto: boolean) => Promise<void>;
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => Promise<void> | void;
  dropNonMatching: boolean;
  onSetDropNonMatching: (drop: boolean) => Promise<void> | void;
  clearDbOnExit: boolean;
  onSetClearDbOnExit: (enabled: boolean) => Promise<boolean | void> | void;
  storageStats: StorageStats;
  isPurgingSqlite: boolean;
  setConfirmPurgeSqliteOpen: (open: boolean) => void;
  bindConfigProps: Omit<BindConfigSectionProps, "sectionKey">;
}

export const GeneralSettingsTab: React.FC<GeneralSettingsTabProps> = ({
  baseId,
  followTail,
  onSetFollowTail,
  status,
  activeEndpointsSummary,
  sysProxyTargetHost,
  onSetProxyPort,
  onSetAutoSystemProxy,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  dropNonMatching,
  onSetDropNonMatching,
  clearDbOnExit,
  onSetClearDbOnExit,
  storageStats,
  isPurgingSqlite,
  setConfirmPurgeSqliteOpen,
  bindConfigProps,
}) => {
  const [portDraft, setPortDraft] = useState<string>(() => String(status.port));
  const [portError, setPortError] = useState<string | null>(null);

  useEffect(() => {
    setPortDraft(String(status.port));
    setPortError(null);
  }, [status.port]);

  const handlePortSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = validatePortString(portDraft);
    if (parsed === null) {
      setPortError("Укажите корректный TCP-порт от 1 до 65535.");
      return;
    }
    setPortError(null);
    await onSetProxyPort(parsed);
  };

  return (
    <div className="space-y-4">
      {/* Local Proxy Server, SysProxy & Network Interface Binding */}
      <section
        id="general-proxy-section"
        className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5"
      >
        <div className="flex items-center gap-1.5">
          <h3 className="text-xs font-semibold text-fg">
            Локальный прокси-сервер и сетевые подключения
          </h3>
          <HelpTooltip
            label="Подробнее о прокси-сервере и интерфейсах"
            title="Порт и привязка слушателя FluxProxy"
            content="Задаёт TCP-порт, автоматическую регистрацию в системном прокси ОС и сетевые адаптеры, на которых прокси принимает входящие подключения."
            example="127.0.0.1:8888 (по умолчанию)"
          />
        </div>

        <form
          onSubmit={(e) => void handlePortSubmit(e)}
          className="flex flex-wrap items-start gap-2.5"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={`${baseId}-proxy-port`}
                className="text-[11px] font-medium text-muted"
              >
                Порт прокси-сервера (1–65535)
              </label>
              <HelpTooltip
                label="Подробнее о TCP-порте прокси"
                content="Локальный порт прослушивания HTTP/HTTPS/WS-прокси. Если порт занят другой программой, FluxProxy автоматически вернёт предыдущий рабочий порт."
                example="8888 или 9090"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`${baseId}-proxy-port`}
                type="text"
                inputMode="numeric"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={portDraft}
                aria-invalid={portError ? "true" : undefined}
                aria-errormessage={
                  portError ? `${baseId}-port-err` : undefined
                }
                onChange={(e) => {
                  setPortDraft(e.target.value);
                  if (portError) setPortError(null);
                }}
                onBlur={(e) => {
                  if (validatePortString(e.currentTarget.value) === null) {
                    setPortError("Укажите корректный TCP-порт от 1 до 65535.");
                  }
                }}
                className="h-8 w-28 rounded-md border border-strong bg-surface px-2.5 font-mono text-xs text-fg tabular-nums focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-selected px-3 text-xs font-medium text-fg hover:brightness-110"
              >
                <Check className="h-3.5 w-3.5 text-accent" />
                <span>Применить порт</span>
              </button>
              <span className="font-mono text-[11px] text-muted">
                Активен: {activeEndpointsSummary}
              </span>
            </div>
            {portError && (
              <span
                id={`${baseId}-port-err`}
                role="status"
                aria-live="polite"
                className="text-[11px] font-medium text-status5xx-fg"
              >
                {portError}
              </span>
            )}
          </div>
        </form>

        <div className="space-y-2 border-t border-hairline pt-2.5">
          <div className="flex items-start gap-2.5">
            <label
              htmlFor={`${baseId}-auto-sysproxy`}
              className="flex flex-1 cursor-pointer items-start gap-2.5"
            >
              <input
                id={`${baseId}-auto-sysproxy`}
                type="checkbox"
                checked={status.autoSystemProxy}
                onChange={(e) => void onSetAutoSystemProxy(e.target.checked)}
                className="checkbox-native mt-0.5"
              />
              <div>
                <div className="flex items-center gap-1.5 font-medium text-fg">
                  <span>
                    Автоматически включать системный прокси ОС (Act as System Proxy)
                  </span>
                  <HelpTooltip
                    label="Подробнее о Act as System Proxy"
                    title="Системный прокси операционной системы"
                    content="При запуске захвата автоматически прописывает адрес прокси в настройках WinINet/macOS/GNOME и восстанавливает исходные параметры сети при паузе или выходе."
                    example={`http=${sysProxyTargetHost}:${status.port}`}
                  />
                </div>
                <div className="text-[11px] text-muted">
                  При запуске захвата перенаправляет системный HTTP/HTTPS трафик на{" "}
                  <code className="font-mono">
                    {sysProxyTargetHost}:{status.port}
                  </code>{" "}
                  и откатывает при выходе.
                </div>
              </div>
            </label>
          </div>

          <BindConfigSection sectionKey="general" {...bindConfigProps} />
        </div>
      </section>

      {/* Traffic Stream, Ring Buffer & SQLite Storage */}
      <section
        id="general-storage-section"
        className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5"
      >
        <div className="flex items-center gap-1.5">
          <h3 className="text-xs font-semibold text-fg">
            Поток трафика, кольцевой буфер памяти и архив SQLite
          </h3>
          <HelpTooltip
            label="Подробнее о Ring Buffer и SQLite"
            title="Управление памятью и диском"
            content="Ограничивает число активных сессий в RAM (вытесняя старые в SQLite), управляет автопрокруткой таблицы и размером файла sessions.sqlite."
          />
        </div>

        <label
          htmlFor={`${baseId}-follow-tail`}
          className="flex cursor-pointer items-start gap-2.5"
        >
          <input
            id={`${baseId}-follow-tail`}
            type="checkbox"
            checked={followTail}
            onChange={(e) => onSetFollowTail(e.target.checked)}
            className="checkbox-native mt-0.5"
          />
          <div>
            <div className="flex items-center gap-1.5 font-medium text-fg">
              <span>Автопрокрутка к новым запросам (Follow Tail)</span>
              <HelpTooltip
                label="Подробнее о Follow Tail"
                content="Автоматически прокручивает таблицу трафика к самой свежей записи по мере поступления запросов. Удобно отключать при изучении старых ответов."
              />
            </div>
            <div className="text-[11px] text-muted">
              Автоматически удерживает нижний край таблицы при поступлении новых
              HTTP/WS сессий.
            </div>
          </div>
        </label>

        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-2.5">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor={`${baseId}-retention-select`}
              className="text-[11px] font-medium text-muted"
            >
              Хранить сессий в RAM (Ring Buffer Keep):
            </label>
            <HelpTooltip
              label="Подробнее о Ring Buffer (Keep)"
              title="Кольцевой буфер памяти (FIFO)"
              content="Когда число сессий в памяти превышает лимит, самые старые сессии автоматически выгружаются в SQLite (не теряясь при поиске), удерживая стабильное потребление ОЗУ."
              example="10 000 сессий (рекомендуется для длительных сеансов)"
            />
          </div>
          <select
            id={`${baseId}-retention-select`}
            value={
              sessionRetentionLimit === null
                ? "all"
                : String(sessionRetentionLimit)
            }
            onChange={(e) => {
              const val = e.target.value;
              void onSetSessionRetentionLimit(
                val === "all" ? null : Number(val)
              );
            }}
            className="h-8 rounded-md border border-strong bg-surface px-2.5 font-mono text-xs text-fg"
          >
            <option value="all">All Sessions (Без лимита)</option>
            {SESSION_RETENTION_PRESETS.map((preset) => (
              <option key={preset} value={String(preset)}>
                {preset.toLocaleString()} сессий
              </option>
            ))}
            {sessionRetentionLimit !== null &&
              !(SESSION_RETENTION_PRESETS as readonly number[]).includes(
                sessionRetentionLimit
              ) && (
                <option value={String(sessionRetentionLimit)}>
                  {sessionRetentionLimit.toLocaleString()} (Custom)
                </option>
              )}
          </select>
        </div>

        <label
          htmlFor={`${baseId}-drop-non-matching`}
          className="flex cursor-pointer items-start gap-2.5"
        >
          <input
            id={`${baseId}-drop-non-matching`}
            type="checkbox"
            checked={dropNonMatching}
            onChange={(e) => void onSetDropNonMatching(e.target.checked)}
            className="checkbox-native mt-0.5"
          />
          <div>
            <div className="flex items-center gap-1.5 font-medium text-fg">
              <span>
                Отбрасывать несовпадающие с фильтром запросы при захвате (Drop Non-Matching)
              </span>
              <HelpTooltip
                label="Подробнее о Drop Non-Matching"
                title="Отсев трафика на этапе захвата"
                content="В отличие от обычных фильтров отображения, несоответствующие Host-листу или матрице запросы сразу проксируются мимо TrafficStore и вообще не попадают в RAM/SQLite."
                example="Whitelist *.my-api.com + Drop Non-Matching → в таблице только ваш API"
              />
            </div>
            <div className="text-[11px] text-muted">
              Экономит ОЗУ на высоконагруженных стендах — отсеянные сессии не
              сохраняются в буфер.
            </div>
          </div>
        </label>

        <div className="mt-3 space-y-3 rounded-lg border border-hairline bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-fg">
              <Database className="h-3.5 w-3.5 text-accent" />
              <span>Архив SQLite (sessions.sqlite + WAL)</span>
              <HelpTooltip
                label="Подробнее об архиве SQLite"
                title="Локальное хранилище сессий на диске"
                content="Хранит выгруженные из кольцевого буфера сессии и крупные тела (> 2 MiB) для ленивой подгрузки. Очистка VACUUM освобождает место на диске, не удаляя активные сессии в таблице ОЗУ."
              />
            </div>
            <div className="font-mono text-xs tabular-nums text-fg">
              {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(2)} MB
              <span className="ml-1.5 text-[11px] text-muted">
                (
                {Math.round(storageStats.sqliteSizeBytes / 1024).toLocaleString(
                  "en-US"
                )}{" "}
                KB)
              </span>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs">
            <input
              type="checkbox"
              checked={clearDbOnExit}
              onChange={(e) => void onSetClearDbOnExit(e.target.checked)}
              className="checkbox-native mt-0.5"
            />
            <div>
              <div className="font-medium text-fg">
                Очищать базу SQLite при выходе (Clear DB on App Exit)
              </div>
              <div className="text-[11px] text-muted">
                При закрытии приложения автоматически удаляет все архивные сессии
                и сжимает файл базы через VACUUM.
              </div>
            </div>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-1">
            <div className="text-[11px] text-muted">
              Полная очистка удаляет все сохранённые сессии с диска (сессии в
              ОЗУ сохраняются).
            </div>
            <button
              type="button"
              disabled={isPurgingSqlite}
              onClick={() => setConfirmPurgeSqliteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-status5xx-fg/40 bg-status5xx-bg/40 px-2.5 py-1.5 text-xs font-medium text-status5xx-fg transition-colors hover:bg-status5xx-bg disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>
                {isPurgingSqlite
                  ? "Сжатие SQLite..."
                  : "Очистить архив SQLite сейчас (VACUUM)"}
              </span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
