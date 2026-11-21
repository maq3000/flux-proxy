import React from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { USER_AGENT_PRESETS } from "../../lib/filterEngine";
import type {
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
  ProxyFilterBackendConfig,
} from "../../types/proxy";

export interface HeaderMutationsTabProps {
  backendConfig: ProxyFilterBackendConfig;
  onBackendConfigChange: (next: ProxyFilterBackendConfig) => Promise<void>;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
}

export const HeaderMutationsTab: React.FC<HeaderMutationsTabProps> = ({
  backendConfig,
  onBackendConfigChange,
  isForceNoCacheActive,
  onToggleForceNoCache,
}) => {
  const addHeaderMutationRule = () => {
    const nextRule: HeaderMutationRule = {
      id: `hm-${Date.now()}`,
      enabled: true,
      name: "Новое правило заголовка",
      direction: "request",
      operation: "set",
      headerName: "X-Debug-Trace",
      headerValue: "enabled",
      urlPattern: "*",
    };
    void onBackendConfigChange({
      ...backendConfig,
      headerMutationsEnabled: true,
      headerMutations: [...backendConfig.headerMutations, nextRule],
    });
  };

  const activeUaRule = backendConfig.headerMutations.find(
    (m) => m.id === "hm-ua-override"
  );
  const currentUaSelectValue =
    activeUaRule && activeUaRule.enabled ? activeUaRule.headerValue : "";

  const handleQuickUserAgentSelect = (uaValue: string) => {
    if (!uaValue) {
      const next = backendConfig.headerMutations.map((m) =>
        m.id === "hm-ua-override" ? { ...m, enabled: false } : m
      );
      void onBackendConfigChange({
        ...backendConfig,
        headerMutations: next,
      });
      return;
    }

    const exists = backendConfig.headerMutations.some(
      (m) => m.id === "hm-ua-override"
    );
    const next = exists
      ? backendConfig.headerMutations.map((m) =>
          m.id === "hm-ua-override"
            ? { ...m, enabled: true, headerValue: uaValue }
            : m
        )
      : [
          {
            id: "hm-ua-override",
            enabled: true,
            name: "Подмена User-Agent",
            direction: "request" as const,
            operation: "set" as const,
            headerName: "User-Agent",
            headerValue: uaValue,
            urlPattern: "*",
          },
          ...backendConfig.headerMutations,
        ];

    void onBackendConfigChange({
      ...backendConfig,
      headerMutationsEnabled: true,
      headerMutations: next,
    });
  };

  return (
          <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                <input
                  type="checkbox"
                  checked={backendConfig.headerMutationsEnabled}
                  onChange={(e) =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      headerMutationsEnabled: e.target.checked,
                    })
                  }
                  className="checkbox-native"
                />
                <Wand2 className="h-4 w-4 text-amber-400" />
                <span>Легкая мутация HTTP-заголовков на лету (без создания моков)</span>
              </label>

              <button
                type="button"
                onClick={addHeaderMutationRule}
                className="inline-flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Добавить правило</span>
              </button>
            </div>

            {/* One-Click Quick Controls: HTTP/3 QUIC Block + Cache Bypass + User-Agent Spoofing */}
            <div className="grid grid-cols-1 gap-3 rounded-md border border-hairline bg-canvas p-3 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-2.5 sm:col-span-2 border-b border-hairline pb-2.5">
                <input
                  type="checkbox"
                  checked={backendConfig.stripAltSvc ?? true}
                  onChange={(e) =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      stripAltSvc: e.target.checked,
                    })
                  }
                  className="checkbox-native mt-0.5"
                />
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-fg">
                    Блокировать переход на HTTP/3 (QUIC / UDP 443)
                  </span>
                  <span className="block text-[11px] text-muted">
                    Автоматически удаляет заголовки{" "}
                    <code className="font-mono">Alt-Svc</code> и{" "}
                    <code className="font-mono">Alternate-Protocol</code> из HTTP/1.1 и HTTP/2 ответов, предотвращая обход локального TCP-прокси браузерами
                  </span>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={isForceNoCacheActive}
                  onChange={() => void onToggleForceNoCache()}
                  className="checkbox-native mt-0.5"
                />
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-fg">
                    Принудительный обход кэша (Force No-Cache)
                  </span>
                  <span className="block text-[11px] text-muted">
                    Удаляет <code className="font-mono">If-Modified-Since</code>,{" "}
                    <code className="font-mono">If-None-Match</code> из запроса и{" "}
                    <code className="font-mono">ETag</code>,{" "}
                    <code className="font-mono">Last-Modified</code> из ответа
                  </span>
                </div>
              </label>

              <div>
                <label className="mb-1 block text-xs font-semibold text-fg">
                  Быстрая подмена User-Agent
                </label>
                <select
                  value={currentUaSelectValue}
                  onChange={(e) => handleQuickUserAgentSelect(e.target.value)}
                  aria-label="Профиль подмены User-Agent"
                  className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                >
                  <option value="">Не подменять (оригинальный User-Agent клиента)</option>
                  {USER_AGENT_PRESETS.map((ua) => (
                    <option key={ua.label} value={ua.value}>
                      {ua.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Full Header Mutations Table */}
            <div className="filter-table-wrapper rounded-md border border-hairline">
              <table
                className="filter-data-table text-left text-xs"
                style={
                  {
                    "--label-2": '"Этап"',
                    "--label-3": '"Заголовок"',
                    "--label-4": '"Значение"',
                  } as React.CSSProperties
                }
              >
                <thead>
                  <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-2.5 py-2">Вкл</th>
                    <th className="px-2 py-2">Этап</th>
                    <th className="px-2 py-2">Операция</th>
                    <th className="px-2 py-2">Заголовок(и)</th>
                    <th className="px-2 py-2">Новое значение</th>
                    <th className="px-2 py-2">URL Scope</th>
                    <th className="px-2 py-2 text-right">Удалить</th>
                  </tr>
                </thead>
                <tbody>
                  {backendConfig.headerMutations.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                        !m.enabled || !backendConfig.headerMutationsEnabled
                          ? "opacity-55"
                          : ""
                      }`}
                    >
                      <th scope="row" className="px-2.5 py-1.5 font-normal">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, enabled: e.target.checked }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          aria-label={`Включить мутацию ${m.headerName}`}
                          className="checkbox-native"
                        />
                      </th>

                      <td data-col="2" className="px-2 py-1.5">
                        <select
                          value={m.direction}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? {
                                      ...item,
                                      direction: e.target
                                        .value as HeaderMutationDirection,
                                    }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          className="h-7 rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                        >
                          <option value="request">Request</option>
                          <option value="response">Response</option>
                        </select>
                      </td>

                      <td className="px-2 py-1.5">
                        <select
                          value={m.operation}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? {
                                      ...item,
                                      operation: e.target
                                        .value as HeaderMutationOp,
                                    }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          className="h-7 rounded border border-strong bg-surface px-1.5 font-mono text-xs text-fg"
                        >
                          <option value="remove">Remove (Удалить)</option>
                          <option value="set">Set (Заменить)</option>
                          <option value="append">Append (Добавить)</option>
                        </select>
                      </td>

                      <td data-col="3" className="px-2 py-1.5">
                        <input
                          type="text"
                          value={m.headerName}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, headerName: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder="If-Modified-Since, ETag"
                          className="h-7 w-full min-w-[155px] rounded border border-strong bg-surface px-2 font-mono text-xs text-sky-400"
                        />
                      </td>

                      <td data-col="4" className="px-2 py-1.5">
                        <input
                          type="text"
                          disabled={m.operation === "remove"}
                          value={m.headerValue}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, headerValue: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder={
                            m.operation === "remove"
                              ? "— удаляется —"
                              : "Значение заголовка..."
                          }
                          className="h-7 w-full min-w-[170px] rounded border border-strong bg-surface px-2 font-mono text-xs text-fg disabled:opacity-45"
                        />
                      </td>

                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          value={m.urlPattern}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, urlPattern: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder="* или api.host"
                          className="h-7 w-28 rounded border border-strong bg-surface px-2 font-mono text-xs text-muted"
                        />
                      </td>

                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            const next = backendConfig.headerMutations.filter(
                              (item) => item.id !== m.id
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          title="Удалить правило мутации"
                          className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
  );
};
