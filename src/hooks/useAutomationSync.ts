import { useCallback, useEffect } from "react";
import { DEFAULT_PYTHON_SCRIPT_CODE } from "../lib/appDefaults";
import {
  SETTINGS_APPLIED_EVENT,
  SETTINGS_STORAGE_KEYS,
} from "../lib/settingsManager";
import { proxyBridge } from "../lib/tauriBridge";
import { useProxyStore } from "../stores/proxyStore";
import type {
  ActiveNavSection,
  AutoResponderRule,
  PythonScriptPreset,
  SessionSummary,
} from "../types/proxy";
import type { FluxUserSettingsProfile } from "../types/settings";

export interface UseAutomationSyncOptions {
  showToast: (msg: string) => void;
  setActiveSection: (section: ActiveNavSection) => void;
}

export function persistAutoResponderStorage(
  enabledVal: boolean,
  rulesVal: AutoResponderRule[]
): void {
  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.autoResponder,
      JSON.stringify({ enabled: enabledVal, rules: rulesVal })
    );
  } catch {
    // ignore storage quota errors
  }
}

export function persistPythonScriptStorage(
  enabledVal: boolean,
  codeVal: string,
  presetIdVal: string | null
): void {
  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.pythonScript,
      JSON.stringify({
        enabled: enabledVal,
        code: codeVal,
        activePresetId: presetIdVal,
      })
    );
  } catch {
    // ignore storage quota errors
  }
}

export function useAutomationSync({
  showToast,
  setActiveSection,
}: UseAutomationSyncOptions) {
  const setAutoResponderEnabled = useProxyStore(
    (s) => s.setAutoResponderEnabled
  );
  const setRules = useProxyStore((s) => s.setRules);
  const setScriptCode = useProxyStore((s) => s.setScriptCode);
  const setScriptEnabled = useProxyStore((s) => s.setScriptEnabled);
  const setScriptActivePresetId = useProxyStore(
    (s) => s.setScriptActivePresetId
  );
  const setPythonRunnerStatus = useProxyStore((s) => s.setPythonRunnerStatus);
  const setScriptConsoleLogs = useProxyStore((s) => s.setScriptConsoleLogs);
  const setIsApplyingScript = useProxyStore((s) => s.setIsApplyingScript);

  const handleSetAutoResponderEnabled = useCallback(
    async (nextEnabled: boolean) => {
      try {
        const applied = await proxyBridge.setAutoResponderEnabled(nextEnabled);
        setAutoResponderEnabled(applied);
        persistAutoResponderStorage(
          applied,
          useProxyStore.getState().rules
        );
        showToast(
          applied
            ? "▶ AutoResponder включён"
            : "⏸ AutoResponder отключён глобально"
        );
      } catch (err) {
        showToast(
          `⚠️ Не удалось переключить AutoResponder: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [setAutoResponderEnabled, showToast]
  );

  useEffect(() => {
    let active = true;

    const initAutoResponder = async () => {
      try {
        const rawStored = window.localStorage.getItem(
          SETTINGS_STORAGE_KEYS.autoResponder
        );
        if (rawStored) {
          const parsed = JSON.parse(rawStored) as {
            enabled?: boolean;
            rules?: AutoResponderRule[];
          };
          if (parsed && Array.isArray(parsed.rules)) {
            const enabledFlag =
              typeof parsed.enabled === "boolean" ? parsed.enabled : true;
            const syncedRules = await proxyBridge.setAutoResponderConfig(
              enabledFlag,
              parsed.rules
            );
            if (!active) return;
            setAutoResponderEnabled(enabledFlag);
            setRules(syncedRules);
            return;
          }
        }
      } catch {
        // fallback to backend defaults
      }

      try {
        const [initialEnabled, initialRules] = await Promise.all([
          proxyBridge.getAutoResponderEnabled(),
          proxyBridge.listRules(),
        ]);
        if (!active) return;
        setAutoResponderEnabled(initialEnabled);
        setRules(initialRules);
        persistAutoResponderStorage(initialEnabled, initialRules);
      } catch (err) {
        if (!active) return;
        showToast(
          `⚠️ Не удалось загрузить состояние AutoResponder: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    };

    void initAutoResponder();

    const onSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.autoResponder) return;
      setAutoResponderEnabled(Boolean(detail.autoResponder.enabled));
      setRules(structuredClone(detail.autoResponder.rules));
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    return () => {
      active = false;
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    };
  }, [setAutoResponderEnabled, setRules, showToast]);

  const handleApplyPythonScript = useCallback(
    async (nextCode: string, nextEnabled: boolean) => {
      setIsApplyingScript(true);
      try {
        const nextStatus = await proxyBridge.setPythonScript(
          nextCode,
          nextEnabled
        );
        setPythonRunnerStatus(nextStatus);
        const appliedEnabled = nextStatus.isSimulator
          ? nextEnabled
          : nextStatus.enabled;
        setScriptCode(nextCode);
        setScriptEnabled(appliedEnabled);
        persistPythonScriptStorage(
          appliedEnabled,
          nextCode,
          useProxyStore.getState().scriptActivePresetId
        );
        if (nextStatus.lastError) {
          showToast("⚠️ Ошибка в Python-скрипте — см. консоль скрипта");
        } else if (nextStatus.isSimulator) {
          showToast(
            appliedEnabled
              ? "🐍 Скрипт сохранён (Browser Preview Simulator)"
              : "⏸ Python-скрипт отключён (Simulator)"
          );
        } else {
          showToast(
            appliedEnabled
              ? "✅ Python-скрипт применён к MITM-прокси"
              : "⏸ Python-скрипт отключён"
          );
        }
      } catch (err) {
        showToast(
          `⚠️ Не удалось применить Python-скрипт: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        setIsApplyingScript(false);
      }
    },
    [
      setIsApplyingScript,
      setPythonRunnerStatus,
      setScriptCode,
      setScriptEnabled,
      showToast,
    ]
  );

  const handleTogglePythonScript = useCallback(
    async (nextEnabled: boolean) => {
      await handleApplyPythonScript(
        useProxyStore.getState().scriptCode,
        nextEnabled
      );
    },
    [handleApplyPythonScript]
  );

  const handleRefreshPythonStatus = useCallback(async () => {
    try {
      const nextStatus = await proxyBridge.getPythonRunnerStatus();
      setPythonRunnerStatus(nextStatus);
    } catch (err) {
      showToast(
        `⚠️ Не удалось проверить Python: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [setPythonRunnerStatus, showToast]);

  const handleSelectPythonPreset = useCallback(
    (preset: PythonScriptPreset) => {
      setScriptCode(preset.code);
      setScriptActivePresetId(preset.id);
      persistPythonScriptStorage(
        useProxyStore.getState().scriptEnabled,
        preset.code,
        preset.id
      );
      showToast(`Загружен шаблон «${preset.name}» — нажмите Apply Script`);
    },
    [setScriptActivePresetId, setScriptCode, showToast]
  );

  useEffect(() => {
    let active = true;
    let unlistenLogs: (() => void) | null = null;

    const initScripting = async () => {
      let initialCode = DEFAULT_PYTHON_SCRIPT_CODE;
      let initialEnabled = false;
      let initialPresetId: string | null = "hmac-header-injection";
      try {
        const rawStored = window.localStorage.getItem(
          SETTINGS_STORAGE_KEYS.pythonScript
        );
        if (rawStored) {
          const parsed = JSON.parse(rawStored) as {
            enabled?: unknown;
            code?: unknown;
            activePresetId?: unknown;
          };
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.code === "string") {
              initialCode = parsed.code;
            }
            if (typeof parsed.enabled === "boolean") {
              initialEnabled = parsed.enabled;
            }
            if (
              parsed.activePresetId === null ||
              typeof parsed.activePresetId === "string"
            ) {
              initialPresetId = parsed.activePresetId;
            }
          }
        }
      } catch {
        // fallback to default script
      }

      if (!active) return;
      setScriptCode(initialCode);
      setScriptEnabled(initialEnabled);
      setScriptActivePresetId(initialPresetId);

      try {
        const nextStatus = await proxyBridge.setPythonScript(
          initialCode,
          initialEnabled
        );
        if (!active) return;
        setPythonRunnerStatus(nextStatus);
        if (!nextStatus.isSimulator) {
          setScriptEnabled(nextStatus.enabled);
        }
      } catch {
        try {
          const fallbackStatus = await proxyBridge.getPythonRunnerStatus();
          if (active) setPythonRunnerStatus(fallbackStatus);
        } catch {
          // ignore status fallback error on boot
        }
      }
    };

    void proxyBridge
      .subscribeScriptConsoleLogs((entry) => {
        if (!active) return;
        setScriptConsoleLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      })
      .then((fn) => {
        if (active) {
          unlistenLogs = fn;
        } else {
          fn();
        }
      });

    void initScripting();

    const onSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.scripting) return;
      setScriptEnabled(Boolean(detail.scripting.enabled));
      setScriptCode(detail.scripting.code);
      setScriptActivePresetId(detail.scripting.activePresetId ?? null);
      void proxyBridge
        .getPythonRunnerStatus()
        .then((st) => {
          if (active) setPythonRunnerStatus(st);
        })
        .catch(() => undefined);
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    return () => {
      active = false;
      if (unlistenLogs) unlistenLogs();
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    };
  }, [
    setPythonRunnerStatus,
    setScriptActivePresetId,
    setScriptCode,
    setScriptConsoleLogs,
    setScriptEnabled,
  ]);

  const handleCreateRuleFromSession = useCallback(
    async (session: SessionSummary) => {
      const detail = await proxyBridge.getSessionDetail(session.id);
      const newRule: AutoResponderRule = {
        id: `rule-${Date.now()}`,
        enabled: true,
        name: `Mock ${session.method} ${session.path.split("?")[0]}`,
        matchTarget: "urlContains",
        pattern: session.path.split("?")[0] || session.host,
        methodFilter: session.method,
        headerName: null,
        action: "mockResponse",
        statusCode: session.status,
        latencyMs: 50,
        responseHeaders: detail?.responseHeaders ?? [
          { name: "Content-Type", value: session.contentType },
        ],
        responseBody:
          detail?.responseBodyText ??
          JSON.stringify({ mockedFromSession: session.id }, null, 2),
      };
      const updated = await proxyBridge.upsertRule(newRule);
      setRules(updated);
      persistAutoResponderStorage(
        useProxyStore.getState().autoResponderEnabled,
        updated
      );
      setActiveSection("rules");
      showToast(`Created AutoResponder rule from Session #${session.id}`);
    },
    [setActiveSection, setRules, showToast]
  );

  return {
    handleSetAutoResponderEnabled,
    handleApplyPythonScript,
    handleTogglePythonScript,
    handleRefreshPythonStatus,
    handleSelectPythonPreset,
    handleCreateRuleFromSession,
  };
}
