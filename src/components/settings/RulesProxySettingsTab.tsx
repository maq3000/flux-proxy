import React, { useState } from "react";
import { ExternalLink, Plus, Sliders, Trash2 } from "lucide-react";
import { BindConfigSection, type BindConfigSectionProps } from "./BindConfigSection";
import type {
  AutoResponderRule,
  ProxyFilterBackendConfig,
  TlsBypassRule,
  TlsInterceptMode,
} from "../../types/proxy";

export interface RulesProxySettingsTabProps {
  bindConfigProps: Omit<BindConfigSectionProps, "sectionKey">;
  backendFilterConfig: ProxyFilterBackendConfig;
  onUpdateBackendFilterConfig: (next: ProxyFilterBackendConfig) => Promise<void>;
  onSetTlsInterceptMode: (mode: TlsInterceptMode) => Promise<void> | void;
  onOpenTlsDrawer: () => void;
  onOpenHeadersDrawer: () => void;
  autoResponderEnabled: boolean;
  onSetAutoResponderEnabled: (enabled: boolean) => Promise<void>;
  autoResponderRules: AutoResponderRule[];
  onUpsertAutoResponderRule: (rule: AutoResponderRule) => Promise<void>;
  onDeleteAutoResponderRule: (id: string) => Promise<void>;
  onOpenAutoResponderStudio: () => void;
  onCloseDialog: () => void;
}

export const RulesProxySettingsTab: React.FC<RulesProxySettingsTabProps> = ({
  bindConfigProps,
  backendFilterConfig,
  onUpdateBackendFilterConfig,
  onSetTlsInterceptMode,
  onOpenTlsDrawer,
  onOpenHeadersDrawer,
  autoResponderEnabled,
  onSetAutoResponderEnabled,
  autoResponderRules,
  onUpsertAutoResponderRule,
  onDeleteAutoResponderRule,
  onOpenAutoResponderStudio,
  onCloseDialog,
}) => {
  const baseId = bindConfigProps.baseId;
  const [newBypassPattern, setNewBypassPattern] = useState("");
  const [newTargetPattern, setNewTargetPattern] = useState("");

  const handleAddTlsRule = async (
    listKind: "bypass" | "target",
    patternRaw: string
  ) => {
    const clean = patternRaw.trim();
    if (!clean) return;
    const newRule: TlsBypassRule = {
      id: `tls-${listKind}-${Date.now()}`,
      enabled: true,
      pattern: clean,
      category: "Custom",
      description:
        listKind === "bypass"
          ? "Пользовательское правило TLS Bypass"
          : "Целевой хост Selective MITM",
    };
    if (listKind === "bypass") {
      await onUpdateBackendFilterConfig({
        ...backendFilterConfig,
        tlsBypassRules: [newRule, ...backendFilterConfig.tlsBypassRules],
      });
      setNewBypassPattern("");
    } else {
      await onUpdateBackendFilterConfig({
        ...backendFilterConfig,
        tlsTargetRules: [newRule, ...(backendFilterConfig.tlsTargetRules ?? [])],
      });
      setNewTargetPattern("");
    }
  };

  return (
              <>
                <BindConfigSection sectionKey="rules" {...bindConfigProps} />

                <fieldset className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <legend className="px-1 text-xs font-semibold text-fg">
                    Режим расшифровки HTTPS (TLS MITM Mode)
                  </legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        {
                          value: "interceptAll",
                          title: "Intercept All (кроме Bypass-списка)",
                          desc: "Расшифровывает весь HTTPS трафик за исключением доменов TLS Bypass",
                        },
                        {
                          value: "targetedOnly",
                          title: "Targeted Only (Selective MITM)",
                          desc: "Расшифровывает только домены из Target Rules; остальное идёт напрямую",
                        },
                      ] as const
                    ).map((opt) => {
                      const rId = `${baseId}-tls-mode-${opt.value}`;
                      const checked =
                        backendFilterConfig.tlsInterceptMode === opt.value;
                      return (
                        <label
                          key={opt.value}
                          htmlFor={rId}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                            checked
                              ? "border-accent/50 bg-selected"
                              : "border-hairline bg-surface hover:bg-hover"
                          }`}
                        >
                          <input
                            id={rId}
                            type="radio"
                            name={`${baseId}-tls-mode`}
                            value={opt.value}
                            checked={checked}
                            onChange={() => void onSetTlsInterceptMode(opt.value)}
                            className="mt-0.5 cursor-pointer accent-[var(--accent-primary)]"
                          />
                          <div>
                            <div className="font-semibold text-fg">
                              {opt.title}
                            </div>
                            <div className="text-[11px] text-muted">
                              {opt.desc}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <label
                        htmlFor={`${baseId}-tls-bypass-on`}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-fg"
                      >
                        <input
                          id={`${baseId}-tls-bypass-on`}
                          type="checkbox"
                          checked={backendFilterConfig.tlsBypassEnabled}
                          onChange={(e) =>
                            void onUpdateBackendFilterConfig({
                              ...backendFilterConfig,
                              tlsBypassEnabled: e.target.checked,
                            })
                          }
                          className="checkbox-native"
                        />
                        <span>TLS Bypass активен</span>
                      </label>

                      <label
                        htmlFor={`${baseId}-strip-altsvc`}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-fg"
                      >
                        <input
                          id={`${baseId}-strip-altsvc`}
                          type="checkbox"
                          checked={backendFilterConfig.stripAltSvc}
                          onChange={(e) =>
                            void onUpdateBackendFilterConfig({
                              ...backendFilterConfig,
                              stripAltSvc: e.target.checked,
                            })
                          }
                          className="checkbox-native"
                        />
                        <span>Удалять Alt-Svc (блокировка ухода в QUIC/H3)</span>
                      </label>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        onCloseDialog();
                        onOpenTlsDrawer();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-fg hover:bg-hover"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Полный редактор TLS…</span>
                    </button>
                  </div>
                </fieldset>

                {/* TLS Bypass & Target Rules */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3">
                    <h3 className="text-xs font-semibold text-fg">
                      TLS Bypass Rules ({backendFilterConfig.tlsBypassRules.length})
                    </h3>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddTlsRule("bypass", newBypassPattern);
                      }}
                      className="flex gap-1.5"
                    >
                      <label htmlFor={`${baseId}-add-bypass`} className="sr-only">
                        Добавить домен в TLS Bypass
                      </label>
                      <input
                        id={`${baseId}-add-bypass`}
                        type="text"
                        placeholder="*.apple.com"
                        value={newBypassPattern}
                        onChange={(e) => setNewBypassPattern(e.target.value)}
                        className="h-7 flex-1 rounded border border-strong bg-surface px-2 font-mono text-xs text-fg"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-7 items-center gap-1 rounded bg-elevated px-2 text-[11px] font-medium text-fg hover:bg-hover"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add</span>
                      </button>
                    </form>
                    <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                      {backendFilterConfig.tlsBypassRules.map((rule) => {
                        const rChk = `${baseId}-byp-${rule.id}`;
                        return (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2 py-1"
                          >
                            <label
                              htmlFor={rChk}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
                            >
                              <input
                                id={rChk}
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={(e) =>
                                  void onUpdateBackendFilterConfig({
                                    ...backendFilterConfig,
                                    tlsBypassRules:
                                      backendFilterConfig.tlsBypassRules.map(
                                        (x) =>
                                          x.id === rule.id
                                            ? { ...x, enabled: e.target.checked }
                                            : x
                                      ),
                                  })
                                }
                                className="checkbox-native"
                              />
                              <span className="truncate font-mono text-[11px] text-fg">
                                {rule.pattern}
                              </span>
                            </label>
                            <button
                              type="button"
                              aria-label={`Удалить правило ${rule.pattern}`}
                              onClick={() =>
                                void onUpdateBackendFilterConfig({
                                  ...backendFilterConfig,
                                  tlsBypassRules:
                                    backendFilterConfig.tlsBypassRules.filter(
                                      (x) => x.id !== rule.id
                                    ),
                                })
                              }
                              className="rounded p-0.5 text-subtle hover:text-rose-400"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3">
                    <h3 className="text-xs font-semibold text-fg">
                      TLS Target Rules ({backendFilterConfig.tlsTargetRules.length})
                    </h3>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddTlsRule("target", newTargetPattern);
                      }}
                      className="flex gap-1.5"
                    >
                      <label htmlFor={`${baseId}-add-target`} className="sr-only">
                        Добавить целевой домен для расшифровки
                      </label>
                      <input
                        id={`${baseId}-add-target`}
                        type="text"
                        placeholder="api.myapp.dev"
                        value={newTargetPattern}
                        onChange={(e) => setNewTargetPattern(e.target.value)}
                        className="h-7 flex-1 rounded border border-strong bg-surface px-2 font-mono text-xs text-fg"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-7 items-center gap-1 rounded bg-elevated px-2 text-[11px] font-medium text-fg hover:bg-hover"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add</span>
                      </button>
                    </form>
                    <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                      {backendFilterConfig.tlsTargetRules.length === 0 ? (
                        <p className="py-3 text-center text-[11px] text-subtle">
                          Список целевых MITM-хостов пуст
                        </p>
                      ) : (
                        backendFilterConfig.tlsTargetRules.map((rule) => {
                          const rChk = `${baseId}-tgt-${rule.id}`;
                          return (
                            <div
                              key={rule.id}
                              className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2 py-1"
                            >
                              <label
                                htmlFor={rChk}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
                              >
                                <input
                                  id={rChk}
                                  type="checkbox"
                                  checked={rule.enabled}
                                  onChange={(e) =>
                                    void onUpdateBackendFilterConfig({
                                      ...backendFilterConfig,
                                      tlsTargetRules:
                                        backendFilterConfig.tlsTargetRules.map(
                                          (x) =>
                                            x.id === rule.id
                                              ? {
                                                  ...x,
                                                  enabled: e.target.checked,
                                                }
                                              : x
                                        ),
                                    })
                                  }
                                  className="checkbox-native"
                                />
                                <span className="truncate font-mono text-[11px] text-fg">
                                  {rule.pattern}
                                </span>
                              </label>
                              <button
                                type="button"
                                aria-label={`Удалить целевой хост ${rule.pattern}`}
                                onClick={() =>
                                  void onUpdateBackendFilterConfig({
                                    ...backendFilterConfig,
                                    tlsTargetRules:
                                      backendFilterConfig.tlsTargetRules.filter(
                                        (x) => x.id !== rule.id
                                      ),
                                  })
                                }
                                className="rounded p-0.5 text-subtle hover:text-rose-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Header Mutations */}
                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-hm-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-hm-enabled`}
                        type="checkbox"
                        checked={backendFilterConfig.headerMutationsEnabled}
                        onChange={(e) =>
                          void onUpdateBackendFilterConfig({
                            ...backendFilterConfig,
                            headerMutationsEnabled: e.target.checked,
                          })
                        }
                        className="checkbox-native"
                      />
                      <span>
                        Header Mutations ({backendFilterConfig.headerMutations.length})
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        onCloseDialog();
                        onOpenHeadersDrawer();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-fg hover:bg-hover"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Редактор мутаций заголовков…</span>
                    </button>
                  </div>

                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {backendFilterConfig.headerMutations.map((hm) => {
                      const hmChk = `${baseId}-hm-${hm.id}`;
                      return (
                        <div
                          key={hm.id}
                          className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <label
                            htmlFor={hmChk}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                          >
                            <input
                              id={hmChk}
                              type="checkbox"
                              checked={hm.enabled}
                              onChange={(e) =>
                                void onUpdateBackendFilterConfig({
                                  ...backendFilterConfig,
                                  headerMutations:
                                    backendFilterConfig.headerMutations.map(
                                      (x) =>
                                        x.id === hm.id
                                          ? { ...x, enabled: e.target.checked }
                                          : x
                                    ),
                                })
                              }
                              className="checkbox-native"
                            />
                            <span className="truncate font-medium text-fg">
                              {hm.name}
                            </span>
                            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted">
                              {hm.direction} • {hm.operation} {hm.headerName}
                            </span>
                          </label>
                          <button
                            type="button"
                            aria-label={`Удалить мутацию ${hm.name}`}
                            onClick={() =>
                              void onUpdateBackendFilterConfig({
                                ...backendFilterConfig,
                                headerMutations:
                                  backendFilterConfig.headerMutations.filter(
                                    (x) => x.id !== hm.id
                                  ),
                              })
                            }
                            className="rounded p-0.5 text-subtle hover:text-rose-400"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* AutoResponder */}
                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-ar-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-ar-enabled`}
                        type="checkbox"
                        checked={autoResponderEnabled}
                        onChange={(e) =>
                          void onSetAutoResponderEnabled(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <Sliders className="h-3.5 w-3.5 text-amber-400" />
                      <span>
                        AutoResponder ({autoResponderRules.length} правил)
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        onCloseDialog();
                        onOpenAutoResponderStudio();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-selected px-2.5 py-1 text-[11px] font-medium text-fg hover:brightness-110"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Открыть AutoResponder Studio</span>
                    </button>
                  </div>

                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {autoResponderRules.length === 0 ? (
                      <p className="py-2 text-center text-[11px] text-subtle">
                        Нет настроенных правил AutoResponder
                      </p>
                    ) : (
                      autoResponderRules.map((rule) => {
                        const arChk = `${baseId}-ar-${rule.id}`;
                        return (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                          >
                            <label
                              htmlFor={arChk}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                            >
                              <input
                                id={arChk}
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={(e) =>
                                  void onUpsertAutoResponderRule({
                                    ...rule,
                                    enabled: e.target.checked,
                                  })
                                }
                                className="checkbox-native"
                              />
                              <span className="truncate font-medium text-fg">
                                {rule.name}
                              </span>
                              <span className="truncate font-mono text-[10px] text-muted">
                                {rule.pattern}
                              </span>
                            </label>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-amber-400">
                                {rule.action === "delayOnly"
                                  ? `+${rule.latencyMs}ms`
                                  : `${rule.statusCode} • +${rule.latencyMs}ms`}
                              </span>
                              <button
                                type="button"
                                aria-label={`Удалить правило ${rule.name}`}
                                onClick={() =>
                                  void onDeleteAutoResponderRule(rule.id)
                                }
                                className="rounded p-0.5 text-subtle hover:text-rose-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
  );
};
