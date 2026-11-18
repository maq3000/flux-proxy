import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookmarkPlus,
  CheckSquare,
  ClipboardPaste,
  Code2,
  Cpu,
  Download,
  FileUp,
  Flame,
  Gauge,
  Globe,
  ListFilter,
  Plus,
  RotateCcw,
  Shield,
  ShieldOff,
  Sparkles,
  Table2,
  Target,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { HostFiltersTab } from "./HostFiltersTab";
import {
  type CompiledHostListFilter,
  FILTER_FIELD_OPTIONS,
  FILTER_OPERATOR_OPTIONS,
  parseBulkTextToTlsRules,
  TLS_BYPASS_QUICK_PACKS,
  tlsRulesToBulkText,
  USER_AGENT_PRESETS,
} from "../lib/filterEngine";
import { formatBytes } from "../lib/formatters";
import { proxyBridge } from "../lib/tauriBridge";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  FilterDrawerTab,
  FilterField,
  FilterLogicalOp,
  FilterOperator,
  FilterPreset,
  FilterRuleAction,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  SessionSummary,
  TlsBypassRule,
} from "../types/proxy";

interface FilterDrawerProps {
  open: boolean;
  initialTab?: FilterDrawerTab;
  onClose: () => void;
  totalCount: number;
  filteredCount: number;
  sessions: SessionSummary[];
  // Bulk Hosts & URL Filter (Hosts List)
  hostListFilter: HostListFilterConfig;
  compiledHostList: CompiledHostListFilter;
  onHostListFilterChange: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onNotify?: (message: string) => void;
  // Matrix & Presets
  matrixEnabled: boolean;
  onMatrixEnabledChange: (enabled: boolean) => void;
  rules: FilterConditionRule[];
  onRulesChange: (
    updater:
      | FilterConditionRule[]
      | ((prev: FilterConditionRule[]) => FilterConditionRule[])
  ) => void;
  ruleErrors: Record<string, string>;
  presets: FilterPreset[];
  activePresetId: string | null;
  onApplyPreset: (presetId: string) => void;
  onSavePreset: (name: string, description?: string) => void;
  onDeletePreset: (presetId: string) => void;
  onResetAll: () => void;
  // Processes
  detectedProcesses: DetectedProcessItem[];
  onQuickProcessFilter: (
    processName: string,
    action: "include" | "exclude"
  ) => void;
  // Thresholds & Time Heat
  thresholds: NoiseThresholdsConfig;
  onThresholdsChange: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  // TLS Bypass & Header Mutations (Synced to Rust)
  backendConfig: ProxyFilterBackendConfig;
  onBackendConfigChange: (next: ProxyFilterBackendConfig) => Promise<void>;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  open,
  initialTab = "matrix",
  onClose,
  totalCount,
  filteredCount,
  sessions,
  hostListFilter,
  compiledHostList,
  onHostListFilterChange,
  onNotify,
  matrixEnabled,
  onMatrixEnabledChange,
  rules,
  onRulesChange,
  ruleErrors,
  presets,
  activePresetId,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onResetAll,
  detectedProcesses,
  onQuickProcessFilter,
  thresholds,
  onThresholdsChange,
  backendConfig,
  onBackendConfigChange,
  isForceNoCacheActive,
  onToggleForceNoCache,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const quickPasteDialogRef = useRef<HTMLDialogElement>(null);
  const tlsImportInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const quickPasteTitleId = useId();
  const quickPasteTextareaId = useId();
  const processDatalistId = useId();

  const [activeTab, setActiveTab] = useState<FilterDrawerTab>(initialTab);
  const [newPresetName, setNewPresetName] = useState("");
  const [newTargetPattern, setNewTargetPattern] = useState("");
  const [newTargetCategory, setNewTargetCategory] = useState("Target Service");
  const [newTargetDesc, setNewTargetDesc] = useState("");
  const [newBypassPattern, setNewBypassPattern] = useState("");
  const [newBypassCategory, setNewBypassCategory] = useState("Payment Gateways");
  const [newBypassDesc, setNewBypassDesc] = useState("");

  // Selective MITM & Bypass modernization state
  const [tlsViewMode, setTlsViewMode] = useState<"table" | "bulk">("table");
  const [bulkBypassText, setBulkBypassText] = useState(() =>
    tlsRulesToBulkText(backendConfig.tlsBypassRules)
  );
  const [bulkTargetText, setBulkTargetText] = useState(() =>
    tlsRulesToBulkText(backendConfig.tlsTargetRules ?? [])
  );
  const [selectedBypassIds, setSelectedBypassIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(
    () => new Set()
  );
  const [tlsHitCounts, setTlsHitCounts] = useState<Record<string, number>>({});
  const [quickPasteOpen, setQuickPasteOpen] = useState(false);
  const [quickPasteTarget, setQuickPasteTarget] = useState<"bypass" | "target">(
    "bypass"
  );
  const [quickPasteText, setQuickPasteText] = useState("");
  const [quickPasteCategory, setQuickPasteCategory] =
    useState("Custom Pinning");
  const [quickPasteDesc, setQuickPasteDesc] = useState("");
  const [isResettingDefaults, setIsResettingDefaults] = useState(false);

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
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

  // Quick Paste modal dialog lifecycle + pointer-bounds light-dismiss fallback
  useEffect(() => {
    const dialog = quickPasteDialogRef.current;
    if (!dialog) return;

    if (quickPasteOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [quickPasteOpen]);

  useEffect(() => {
    const dialog = quickPasteDialogRef.current;
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

  // Keep bulk editor text synchronized while in Table View
  useEffect(() => {
    if (tlsViewMode === "table") {
      setBulkBypassText(tlsRulesToBulkText(backendConfig.tlsBypassRules));
      setBulkTargetText(tlsRulesToBulkText(backendConfig.tlsTargetRules ?? []));
    }
  }, [
    tlsViewMode,
    backendConfig.tlsBypassRules,
    backendConfig.tlsTargetRules,
  ]);

  // Prune stale row selections if rules are deleted/reset
  useEffect(() => {
    const bypassIdSet = new Set(backendConfig.tlsBypassRules.map((r) => r.id));
    setSelectedBypassIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (bypassIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    const targetIdSet = new Set(
      (backendConfig.tlsTargetRules ?? []).map((r) => r.id)
    );
    setSelectedTargetIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (targetIdSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [backendConfig.tlsBypassRules, backendConfig.tlsTargetRules]);

  // Poll lock-free Rust hit_counts when tlsBypass tab is open
  useEffect(() => {
    if (!open || activeTab !== "tlsBypass") return;
    let cancelled = false;
    const refreshHits = async () => {
      try {
        const counts = await proxyBridge.getTlsRuleHitCounts();
        if (!cancelled) {
          setTlsHitCounts(counts);
        }
      } catch {
        // ignore transient error
      }
    };
    void refreshHits();
    const intervalId = window.setInterval(() => {
      void refreshHits();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, activeTab, sessions.length]);

  // Counts for tab badges
  const activeMatrixCount = useMemo(
    () =>
      matrixEnabled
        ? rules.filter((r) => r.enabled && r.value.trim()).length
        : 0,
    [matrixEnabled, rules]
  );

  const activeHostListCount = hostListFilter.enabled
    ? compiledHostList.activeCount
    : 0;

  const activeThresholdCount = useMemo(() => {
    let n = 0;
    if (thresholds.hide304NotModified) n++;
    if (thresholds.hideOptionsPreflight) n++;
    if (thresholds.hideConnectTunnels) n++;
    if (thresholds.hideStaticAssets) n++;
    if (thresholds.minBodySizeBytes !== null) n++;
    if (thresholds.maxBodySizeBytes !== null) n++;
    if (thresholds.onlySlowRequests) n++;
    return n;
  }, [thresholds]);

  const activeBypassCount = useMemo(
    () =>
      backendConfig.tlsInterceptMode === "targetedOnly"
        ? (backendConfig.tlsTargetRules ?? []).filter((r) => r.enabled).length
        : backendConfig.tlsBypassEnabled
          ? backendConfig.tlsBypassRules.filter((r) => r.enabled).length
          : 0,
    [backendConfig]
  );

  const activeHeaderMutCount = useMemo(
    () =>
      backendConfig.headerMutationsEnabled
        ? backendConfig.headerMutations.filter((m) => m.enabled).length
        : 0,
    [backendConfig]
  );

  // Track first active Include and first active Exclude row so we render "WHERE" vs "AND/OR" cleanly
  const firstIncludeId = rules.find((r) => r.action === "include")?.id ?? null;
  const firstExcludeId = rules.find((r) => r.action === "exclude")?.id ?? null;

  const addMatrixRule = (
    action: FilterRuleAction,
    field: FilterField = "host",
    operator: FilterOperator = "contains",
    value = ""
  ) => {
    const nextRule: FilterConditionRule = {
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: true,
      action,
      logicalOp: "OR",
      field,
      operator,
      value,
    };
    onMatrixEnabledChange(true);
    onRulesChange((prev) => [...prev, nextRule]);
  };

  const updateMatrixRule = (
    id: string,
    patch: Partial<FilterConditionRule>
  ) => {
    onRulesChange((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  const removeMatrixRule = (id: string) => {
    onRulesChange((prev) => prev.filter((r) => r.id !== id));
  };

  const handleAddTlsTarget = (e: React.FormEvent) => {
    e.preventDefault();
    const pat = newTargetPattern.trim();
    if (!pat) return;
    const rule: TlsBypassRule = {
      id: `target-${Date.now()}`,
      enabled: true,
      pattern: pat,
      category: newTargetCategory,
      description:
        newTargetDesc.trim() ||
        "Целевой сервис для MITM-расшифровки (Allowlist)",
    };
    void onBackendConfigChange({
      ...backendConfig,
      tlsTargetRules: [rule, ...(backendConfig.tlsTargetRules ?? [])],
    });
    setNewTargetPattern("");
    setNewTargetDesc("");
  };

  const handleAddTlsBypass = (e: React.FormEvent) => {
    e.preventDefault();
    const pat = newBypassPattern.trim();
    if (!pat) return;
    const rule: TlsBypassRule = {
      id: `bypass-${Date.now()}`,
      enabled: true,
      pattern: pat,
      category: newBypassCategory,
      description:
        newBypassDesc.trim() || "Пользовательское правило обхода MITM (Pinning)",
    };
    void onBackendConfigChange({
      ...backendConfig,
      tlsBypassEnabled: true,
      tlsBypassRules: [rule, ...backendConfig.tlsBypassRules],
    });
    setNewBypassPattern("");
    setNewBypassDesc("");
  };

  const sessionDomainChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (let i = 0; i < sessions.length; i++) {
      const rawHost = sessions[i].host?.trim();
      if (!rawHost) continue;
      const hostClean = rawHost
        .split(":")[0]
        .trim()
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
      if (!hostClean) continue;
      counts.set(hostClean, (counts.get(hostClean) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14);
  }, [sessions]);

  const totalBypassHits = useMemo(
    () =>
      backendConfig.tlsBypassRules.reduce(
        (acc, r) => acc + (tlsHitCounts[r.id] ?? 0),
        0
      ),
    [backendConfig.tlsBypassRules, tlsHitCounts]
  );

  const totalTargetHits = useMemo(
    () =>
      (backendConfig.tlsTargetRules ?? []).reduce(
        (acc, r) => acc + (tlsHitCounts[r.id] ?? 0),
        0
      ),
    [backendConfig.tlsTargetRules, tlsHitCounts]
  );

  const parsedBulkBypassPreview = useMemo(
    () =>
      parseBulkTextToTlsRules(bulkBypassText, backendConfig.tlsBypassRules, {
        defaultCategory: "Custom Pinning",
        defaultDescription: "Пакетное правило обхода MITM",
        idPrefix: "bypass-bulk",
      }),
    [bulkBypassText, backendConfig.tlsBypassRules]
  );

  const parsedBulkTargetPreview = useMemo(
    () =>
      parseBulkTextToTlsRules(
        bulkTargetText,
        backendConfig.tlsTargetRules ?? [],
        {
          defaultCategory: "Target Service",
          defaultDescription: "Целевой сервис для MITM-расшифровки",
          idPrefix: "target-bulk",
        }
      ),
    [bulkTargetText, backendConfig.tlsTargetRules]
  );

  const quickPastePreviewRules = useMemo(
    () =>
      parseBulkTextToTlsRules(
        quickPasteText,
        quickPasteTarget === "target"
          ? (backendConfig.tlsTargetRules ?? [])
          : backendConfig.tlsBypassRules,
        {
          defaultCategory: quickPasteCategory,
          defaultDescription:
            quickPasteDesc.trim() ||
            (quickPasteTarget === "target"
              ? "Импорт через Quick Paste (Target Allowlist)"
              : "Импорт через Quick Paste (TLS Bypass)"),
          idPrefix:
            quickPasteTarget === "target" ? "target-paste" : "bypass-paste",
        }
      ),
    [
      quickPasteText,
      quickPasteTarget,
      quickPasteCategory,
      quickPasteDesc,
      backendConfig.tlsTargetRules,
      backendConfig.tlsBypassRules,
    ]
  );

  const commitBulkTextEditor = useCallback(
    (notifyOnCommit = false) => {
      const nextBypass = parseBulkTextToTlsRules(
        bulkBypassText,
        backendConfig.tlsBypassRules,
        {
          defaultCategory: "Custom Pinning",
          defaultDescription: "Пакетное правило обхода MITM",
          idPrefix: "bypass-bulk",
        }
      );
      const nextTarget = parseBulkTextToTlsRules(
        bulkTargetText,
        backendConfig.tlsTargetRules ?? [],
        {
          defaultCategory: "Target Service",
          defaultDescription: "Целевой сервис для MITM-расшифровки",
          idPrefix: "target-bulk",
        }
      );

      const changed =
        JSON.stringify(nextBypass) !==
          JSON.stringify(backendConfig.tlsBypassRules) ||
        JSON.stringify(nextTarget) !==
          JSON.stringify(backendConfig.tlsTargetRules ?? []);

      if (changed) {
        void onBackendConfigChange({
          ...backendConfig,
          tlsBypassRules: nextBypass,
          tlsTargetRules: nextTarget,
        });
        if (notifyOnCommit) {
          onNotify?.(
            `Применено правил: Bypass ${nextBypass.length}, Target ${nextTarget.length}`
          );
        }
      } else if (notifyOnCommit) {
        onNotify?.("Изменений в пакетном редакторе нет");
      }
    },
    [
      bulkBypassText,
      bulkTargetText,
      backendConfig,
      onBackendConfigChange,
      onNotify,
    ]
  );

  const handleTlsViewModeChange = (mode: "table" | "bulk") => {
    if (mode === tlsViewMode) return;
    if (mode === "bulk") {
      setBulkBypassText(tlsRulesToBulkText(backendConfig.tlsBypassRules));
      setBulkTargetText(tlsRulesToBulkText(backendConfig.tlsTargetRules ?? []));
      setTlsViewMode("bulk");
    } else {
      commitBulkTextEditor(false);
      setTlsViewMode("table");
    }
  };

  const handleSwitchTab = (tab: FilterDrawerTab) => {
    if (activeTab === "tlsBypass" && tab !== "tlsBypass" && tlsViewMode === "bulk") {
      commitBulkTextEditor(false);
      setTlsViewMode("table");
    }
    setActiveTab(tab);
  };

  const handleQuickSessionDomain = (
    host: string,
    target: "bypass" | "target"
  ) => {
    const clean = host.trim().toLowerCase();
    if (!clean) return;
    const list =
      target === "target"
        ? (backendConfig.tlsTargetRules ?? [])
        : backendConfig.tlsBypassRules;

    const existing = list.find((r) =>
      r.pattern
        .split(/[,;]/)
        .some((tok) => tok.trim().toLowerCase() === clean)
    );
    if (existing) {
      if (!existing.enabled) {
        const updated = list.map((r) =>
          r.id === existing.id ? { ...r, enabled: true } : r
        );
        void onBackendConfigChange({
          ...backendConfig,
          ...(target === "target"
            ? { tlsTargetRules: updated }
            : { tlsBypassEnabled: true, tlsBypassRules: updated }),
        });
        onNotify?.(
          `Включено существующее правило для ${clean} (${
            target === "target" ? "Target" : "Bypass"
          })`
        );
      } else {
        onNotify?.(
          `Домен ${clean} уже присутствует в ${
            target === "target" ? "Target Allowlist" : "TLS Bypass"
          }`
        );
      }
      return;
    }

    const rule: TlsBypassRule = {
      id: `${target}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      enabled: true,
      pattern: clean,
      category: target === "target" ? "Target Service" : "Custom Pinning",
      description:
        target === "target"
          ? "Добавлено из списка доменов текущей сессии (Allowlist)"
          : "Добавлено из списка доменов текущей сессии (Bypass)",
    };

    if (target === "target") {
      const nextTarget = [rule, ...(backendConfig.tlsTargetRules ?? [])];
      if (tlsViewMode === "bulk") {
        setBulkTargetText(tlsRulesToBulkText(nextTarget));
      }
      void onBackendConfigChange({
        ...backendConfig,
        tlsTargetRules: nextTarget,
      });
      onNotify?.(`+ Target Allowlist: ${clean}`);
    } else {
      const nextBypass = [rule, ...backendConfig.tlsBypassRules];
      if (tlsViewMode === "bulk") {
        setBulkBypassText(tlsRulesToBulkText(nextBypass));
      }
      void onBackendConfigChange({
        ...backendConfig,
        tlsBypassEnabled: true,
        tlsBypassRules: nextBypass,
      });
      onNotify?.(`+ TLS Bypass: ${clean}`);
    }
  };

  const handleBulkRowAction = (
    which: "bypass" | "target",
    action: "enable" | "disable" | "delete"
  ) => {
    const selectedSet = which === "target" ? selectedTargetIds : selectedBypassIds;
    if (selectedSet.size === 0) return;

    const sourceList =
      which === "target"
        ? (backendConfig.tlsTargetRules ?? [])
        : backendConfig.tlsBypassRules;

    let nextList: TlsBypassRule[];
    if (action === "delete") {
      nextList = sourceList.filter((r) => !selectedSet.has(r.id));
    } else {
      const nextEnabled = action === "enable";
      nextList = sourceList.map((r) =>
        selectedSet.has(r.id) ? { ...r, enabled: nextEnabled } : r
      );
    }

    if (which === "target") {
      void onBackendConfigChange({
        ...backendConfig,
        tlsTargetRules: nextList,
      });
      setSelectedTargetIds(new Set());
    } else {
      void onBackendConfigChange({
        ...backendConfig,
        tlsBypassRules: nextList,
      });
      setSelectedBypassIds(new Set());
    }

    const label =
      action === "delete"
        ? "Удалено"
        : action === "enable"
          ? "Включено"
          : "Выключено";
    onNotify?.(`${label} правил: ${selectedSet.size}`);
  };

  const toggleSelectAllRules = (which: "bypass" | "target") => {
    const list =
      which === "target"
        ? (backendConfig.tlsTargetRules ?? [])
        : backendConfig.tlsBypassRules;
    const current = which === "target" ? selectedTargetIds : selectedBypassIds;
    const allSelected =
      list.length > 0 && list.every((item) => current.has(item.id));
    const next = allSelected ? new Set<string>() : new Set(list.map((r) => r.id));
    if (which === "target") {
      setSelectedTargetIds(next);
    } else {
      setSelectedBypassIds(next);
    }
  };

  const toggleSelectRule = (which: "bypass" | "target", id: string) => {
    const setter =
      which === "target" ? setSelectedTargetIds : setSelectedBypassIds;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const triggerTextDownload = (
    content: string,
    fileName: string,
    mimeType: string
  ) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleExportTlsTxt = () => {
    const isTargeted = backendConfig.tlsInterceptMode === "targetedOnly";
    const rulesToExport = isTargeted
      ? (backendConfig.tlsTargetRules ?? [])
      : backendConfig.tlsBypassRules;
    const text =
      tlsViewMode === "bulk"
        ? isTargeted
          ? bulkTargetText
          : bulkBypassText
        : tlsRulesToBulkText(rulesToExport);
    const fileName = isTargeted
      ? "fluxproxy-tls-target-rules.txt"
      : "fluxproxy-tls-bypass-rules.txt";
    triggerTextDownload(
      text || "# Empty FluxProxy TLS rule list\n",
      fileName,
      "text/plain;charset=utf-8"
    );
    onNotify?.(`Экспортирован ${fileName} (${rulesToExport.length} правил)`);
  };

  const handleExportTlsJson = () => {
    const bypassRules =
      tlsViewMode === "bulk"
        ? parsedBulkBypassPreview
        : backendConfig.tlsBypassRules;
    const targetRules =
      tlsViewMode === "bulk"
        ? parsedBulkTargetPreview
        : (backendConfig.tlsTargetRules ?? []);
    const payload = {
      tlsInterceptMode: backendConfig.tlsInterceptMode,
      tlsBypassEnabled: backendConfig.tlsBypassEnabled,
      tlsBypassRules: bypassRules,
      tlsTargetRules: targetRules,
    };
    triggerTextDownload(
      JSON.stringify(payload, null, 2),
      "fluxproxy-tls-rules.json",
      "application/json;charset=utf-8"
    );
    onNotify?.(
      `Экспортирован fluxproxy-tls-rules.json (Bypass: ${payload.tlsBypassRules.length}, Target: ${payload.tlsTargetRules.length})`
    );
  };

  const handleImportTlsFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = (await file.text()).replace(/^\uFEFF/, "");
      const trimmed = raw.trim();
      if (!trimmed) {
        onNotify?.(`Файл «${file.name}» пуст`);
        return;
      }

      if (
        file.name.toLowerCase().endsWith(".json") ||
        trimmed.startsWith("{") ||
        trimmed.startsWith("[")
      ) {
        const parsed = JSON.parse(trimmed) as unknown;
        const sanitizeRuleArray = (arr: unknown): TlsBypassRule[] => {
          if (!Array.isArray(arr)) return [];
          const out: TlsBypassRule[] = [];
          for (let i = 0; i < arr.length; i++) {
            const item = arr[i];
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const pattern =
              typeof rec.pattern === "string" ? rec.pattern.trim() : "";
            if (!pattern) continue;
            out.push({
              id:
                typeof rec.id === "string" && rec.id.trim()
                  ? rec.id.trim()
                  : `imported-${Date.now()}-${i}`,
              enabled: typeof rec.enabled === "boolean" ? rec.enabled : true,
              pattern,
              category:
                typeof rec.category === "string" && rec.category.trim()
                  ? rec.category.trim()
                  : "Imported",
              description:
                typeof rec.description === "string" ? rec.description : "",
            });
          }
          return out;
        };

        if (Array.isArray(parsed)) {
          const imported = sanitizeRuleArray(parsed);
          if (imported.length === 0) {
            onNotify?.(`В файле «${file.name}» не найдено корректных TLS-правил`);
            return;
          }
          const isTargeted = backendConfig.tlsInterceptMode === "targetedOnly";
          const nextConfig: ProxyFilterBackendConfig = isTargeted
            ? { ...backendConfig, tlsTargetRules: imported }
            : {
                ...backendConfig,
                tlsBypassEnabled: true,
                tlsBypassRules: imported,
              };
          if (tlsViewMode === "bulk") {
            if (isTargeted) setBulkTargetText(tlsRulesToBulkText(imported));
            else setBulkBypassText(tlsRulesToBulkText(imported));
          }
          await onBackendConfigChange(nextConfig);
          onNotify?.(`Импортировано ${imported.length} правил из ${file.name}`);
          return;
        }

        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const nextBypass = obj.tlsBypassRules
            ? sanitizeRuleArray(obj.tlsBypassRules)
            : backendConfig.tlsBypassRules;
          const nextTarget = obj.tlsTargetRules
            ? sanitizeRuleArray(obj.tlsTargetRules)
            : (backendConfig.tlsTargetRules ?? []);
          const nextMode =
            obj.tlsInterceptMode === "targetedOnly" ||
            obj.tlsInterceptMode === "interceptAll"
              ? obj.tlsInterceptMode
              : backendConfig.tlsInterceptMode;
          const nextEnabled =
            typeof obj.tlsBypassEnabled === "boolean"
              ? obj.tlsBypassEnabled
              : backendConfig.tlsBypassEnabled;

          if (tlsViewMode === "bulk") {
            setBulkBypassText(tlsRulesToBulkText(nextBypass));
            setBulkTargetText(tlsRulesToBulkText(nextTarget));
          }
          await onBackendConfigChange({
            ...backendConfig,
            tlsInterceptMode: nextMode,
            tlsBypassEnabled: nextEnabled,
            tlsBypassRules: nextBypass,
            tlsTargetRules: nextTarget,
          });
          onNotify?.(
            `Импортированы TLS-правила из ${file.name} (Bypass: ${nextBypass.length}, Target: ${nextTarget.length})`
          );
          return;
        }
      }

      // Plain text import
      const isTargeted = backendConfig.tlsInterceptMode === "targetedOnly";
      const existing = isTargeted
        ? (backendConfig.tlsTargetRules ?? [])
        : backendConfig.tlsBypassRules;
      const importedRules = parseBulkTextToTlsRules(trimmed, existing, {
        defaultCategory: isTargeted ? "Target Service" : "Imported TXT",
        defaultDescription: `Импортировано из ${file.name}`,
        idPrefix: isTargeted ? "target-txt" : "bypass-txt",
      });
      if (importedRules.length === 0) {
        onNotify?.(`В файле «${file.name}» не найдено доменов или масок`);
        return;
      }

      const merged = [...importedRules];
      const importedIds = new Set(importedRules.map((r) => r.id));
      for (const oldRule of existing) {
        if (!importedIds.has(oldRule.id)) {
          merged.push(oldRule);
        }
      }

      if (tlsViewMode === "bulk") {
        if (isTargeted) setBulkTargetText(tlsRulesToBulkText(merged));
        else setBulkBypassText(tlsRulesToBulkText(merged));
      }

      await onBackendConfigChange({
        ...backendConfig,
        ...(isTargeted
          ? { tlsTargetRules: merged }
          : { tlsBypassEnabled: true, tlsBypassRules: merged }),
      });
      onNotify?.(
        `Импортировано ${importedRules.length} правил из ${file.name}`
      );
    } catch (err) {
      onNotify?.(
        `Ошибка импорта TLS-правил: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const handleResetRecommendedDefaults = async () => {
    setIsResettingDefaults(true);
    try {
      const resetCfg = await proxyBridge.resetTlsBypassRulesToRecommended();
      await onBackendConfigChange(resetCfg);
      if (tlsViewMode === "bulk") {
        setBulkBypassText(tlsRulesToBulkText(resetCfg.tlsBypassRules));
      }
      setSelectedBypassIds(new Set());
      onNotify?.(
        `Восстановлены рекомендуемые PKI/OCSP & System дефолты (${resetCfg.tlsBypassRules.length} правил)`
      );
    } catch (err) {
      onNotify?.(
        `Ошибка сброса дефолтов: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setIsResettingDefaults(false);
    }
  };

  const openQuickPasteModal = () => {
    setQuickPasteTarget(
      backendConfig.tlsInterceptMode === "targetedOnly" ? "target" : "bypass"
    );
    setQuickPasteCategory(
      backendConfig.tlsInterceptMode === "targetedOnly"
        ? "Target Service"
        : "Custom Pinning"
    );
    setQuickPasteDesc("");
    setQuickPasteText("");
    setQuickPasteOpen(true);
  };

  const handleQuickPasteFromClipboard = async () => {
    if (!navigator.clipboard?.readText) {
      onNotify?.("Буфер обмена недоступен — вставьте текст через Ctrl+V");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        onNotify?.("Буфер обмена пуст");
        return;
      }
      setQuickPasteText((prev) =>
        prev.trim() ? `${prev.trimEnd()}\n${text.trim()}` : text.trim()
      );
    } catch {
      onNotify?.("Нет доступа к буферу — вставьте список через Ctrl+V");
    }
  };

  const handleSubmitQuickPaste = (e: React.FormEvent) => {
    e.preventDefault();
    if (quickPastePreviewRules.length === 0) return;

    const targetList =
      quickPasteTarget === "target"
        ? (backendConfig.tlsTargetRules ?? [])
        : backendConfig.tlsBypassRules;

    const existingPatternKeys = new Set(
      targetList.map((r) => r.pattern.trim().toLowerCase())
    );
    const toAdd: TlsBypassRule[] = [];
    let reenabledCount = 0;
    const enabledExistingIds = new Set<string>();

    for (const candidate of quickPastePreviewRules) {
      const key = candidate.pattern.trim().toLowerCase();
      if (existingPatternKeys.has(key)) {
        const match = targetList.find(
          (r) => r.pattern.trim().toLowerCase() === key
        );
        if (match && !match.enabled) {
          enabledExistingIds.add(match.id);
          reenabledCount += 1;
        }
        continue;
      }
      existingPatternKeys.add(key);
      toAdd.push({
        ...candidate,
        id: `${quickPasteTarget}-paste-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`,
      });
    }

    const updatedTarget = [
      ...toAdd,
      ...targetList.map((r) =>
        enabledExistingIds.has(r.id) ? { ...r, enabled: true } : r
      ),
    ];

    if (quickPasteTarget === "target") {
      if (tlsViewMode === "bulk") {
        setBulkTargetText(tlsRulesToBulkText(updatedTarget));
      }
      void onBackendConfigChange({
        ...backendConfig,
        tlsTargetRules: updatedTarget,
      });
    } else {
      if (tlsViewMode === "bulk") {
        setBulkBypassText(tlsRulesToBulkText(updatedTarget));
      }
      void onBackendConfigChange({
        ...backendConfig,
        tlsBypassEnabled: true,
        tlsBypassRules: updatedTarget,
      });
    }

    setQuickPasteOpen(false);
    onNotify?.(
      `Quick Paste: добавлено ${toAdd.length}${
        reenabledCount > 0 ? `, включено ${reenabledCount}` : ""
      } правил`
    );
  };

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
    <>
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        if (activeTab === "tlsBypass" && tlsViewMode === "bulk") {
          commitBulkTextEditor(false);
          setTlsViewMode("table");
        }
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="drawer-dialog m-0 ml-auto h-dvh max-h-dvh w-full max-w-4xl rounded-l-xl border-l border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      {/* Top Drawer Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline bg-elevated/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30">
            <ListFilter className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-fg">
              Таблицы фильтров, Hosts List &amp; TLS Bypass
            </h2>
            <p className="truncate text-[11px] text-muted">
              Массовый фильтр хостов (Whitelist/Blacklist), матрица Include/Exclude, фильтр по PID, пороги шума и SSL Passthrough
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            title="Количество сессий после применения всех активных фильтров"
            className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-sky-400 tabular-nums"
          >
            {filteredCount.toLocaleString()} / {totalCount.toLocaleString()} сессий
          </span>

          <button
            type="button"
            onClick={onResetAll}
            title="Сбросить все табличные правила и пороги"
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-strong hover:text-fg"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Сброс</span>
          </button>

          <form method="dialog">
            <button
              value="cancel"
              autoFocus
              {...({ autofocus: "" } as Record<string, string>)}
              aria-label="Закрыть панель фильтров"
              className="rounded-md border border-hairline bg-surface p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline bg-surface px-4 pt-2">
        <TabButton
          active={activeTab === "matrix"}
          onClick={() => handleSwitchTab("matrix")}
          icon={<ListFilter className="h-3.5 w-3.5" />}
          label="Матрица правил & Пресеты"
          badge={activeMatrixCount}
        />
        <TabButton
          active={activeTab === "hostsList"}
          onClick={() => handleSwitchTab("hostsList")}
          icon={<Globe className="h-3.5 w-3.5" />}
          label="Массовый фильтр хостов (Hosts List)"
          badge={activeHostListCount}
        />
        <TabButton
          active={activeTab === "thresholds"}
          onClick={() => handleSwitchTab("thresholds")}
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Пороги, Шум & Time Heat"
          badge={activeThresholdCount}
        />
        <TabButton
          active={activeTab === "tlsBypass"}
          onClick={() => handleSwitchTab("tlsBypass")}
          icon={<Target className="h-3.5 w-3.5" />}
          label={
            backendConfig.tlsInterceptMode === "targetedOnly"
              ? "MITM: Targeted Only"
              : "Selective MITM & Bypass"
          }
          badge={activeBypassCount}
          tone="teal"
        />
        <TabButton
          active={activeTab === "headers"}
          onClick={() => handleSwitchTab("headers")}
          icon={<Wand2 className="h-3.5 w-3.5" />}
          label="Мутация заголовков"
          badge={activeHeaderMutCount}
          tone="amber"
        />
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto bg-canvas p-4 space-y-4">
        {/* ================================================================ */}
        {/* TAB 1: FILTER RULES MATRIX, PRESETS & PROCESS FILTER             */}
        {/* ================================================================ */}
        {activeTab === "matrix" && (
          <>
            {/* Quick Callout to Bulk Hosts & URL List */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-fg">
                <Globe className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
                <span>
                  Нужно вставить 20–50 доменов или URL списком (как во вкладке Filters в Fiddler)?
                  {activeHostListCount > 0 && (
                    <span className="ml-1.5 font-mono text-[11px] font-semibold text-sky-400">
                      [Активно правил: {activeHostListCount} ({hostListFilter.mode === "whitelist" ? "Whitelist" : "Blacklist"})]
                    </span>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("hostsList")}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
              >
                <span>Открыть Hosts List</span>
              </button>
            </div>

            {/* Presets Bar */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Sparkles className="h-3.5 w-3.5 text-sky-400" />
                  <span>Пресеты фильтрации (Presets)</span>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newPresetName.trim()) return;
                    onSavePreset(newPresetName);
                    setNewPresetName("");
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="Имя нового пресета..."
                    aria-label="Имя нового пресета"
                    className="h-7 w-48 rounded border border-strong bg-canvas px-2 text-xs text-fg placeholder:text-subtle focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!newPresetName.trim()}
                    className="inline-flex h-7 items-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    <span>Сохранить</span>
                  </button>
                </form>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {presets.map((p) => {
                  const isSelected = p.id === activePresetId;
                  return (
                    <div
                      key={p.id}
                      onClick={() => onApplyPreset(p.id)}
                      className={`group flex cursor-pointer items-start justify-between gap-2 rounded-md border p-2.5 text-left transition-colors ${
                        isSelected
                          ? "border-sky-500/60 bg-selected"
                          : "border-hairline bg-canvas hover:border-strong hover:bg-hover"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold text-fg">
                            {p.name}
                          </span>
                          {p.builtIn && (
                            <span className="rounded bg-elevated px-1 py-0.2 font-mono text-[9px] uppercase text-subtle">
                              Built-in
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
                          {p.description}
                        </p>
                      </div>
                      {!p.builtIn && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeletePreset(p.id);
                          }}
                          title="Удалить пресет"
                          className="shrink-0 rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Local OS Process Quick Picker (PID / Process Name) */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Cpu className="h-3.5 w-3.5 text-violet-400" />
                  <span>Фильтр по локальному процессу (PID / Приложение)</span>
                </div>
                <span className="font-mono text-[10px] text-subtle">
                  Win32 GetExtendedTcpTable • macOS libproc • Linux /proc/net/tcp
                </span>
              </div>

              {detectedProcesses.length === 0 ? (
                <p className="text-[11px] text-muted">
                  Пока нет перехваченных локальных сокетов. Нажмите{" "}
                  <strong className="text-fg">+ Фильтр по процессу</strong> ниже, чтобы задать имя вручную (например,{" "}
                  <code className="font-mono text-sky-400">chrome.exe</code>,{" "}
                  <code className="font-mono text-sky-400">node.exe</code>,{" "}
                  <code className="font-mono text-sky-400">Postman.exe</code>).
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {detectedProcesses.map((proc) => {
                    const isIncluded = rules.some(
                      (r) =>
                        r.enabled &&
                        r.action === "include" &&
                        r.field === "processName" &&
                        r.value.toLowerCase() === proc.name.toLowerCase()
                    );
                    const isExcluded = rules.some(
                      (r) =>
                        r.enabled &&
                        r.action === "exclude" &&
                        r.field === "processName" &&
                        r.value.toLowerCase() === proc.name.toLowerCase()
                    );

                    return (
                      <div
                        key={`${proc.name}-${proc.pid ?? "any"}`}
                        className={`inline-flex items-center rounded-md border font-mono text-[11px] ${
                          isIncluded
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                            : isExcluded
                              ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                              : "border-hairline bg-canvas text-fg"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            onQuickProcessFilter(proc.name, "include")
                          }
                          title={`Показывать только трафик ${proc.name}${proc.pid ? ` (PID ${proc.pid})` : ""}`}
                          className="inline-flex items-center gap-1 px-2 py-1 hover:text-emerald-400"
                        >
                          <span className="font-semibold">{proc.name}</span>
                          {proc.pid !== null && (
                            <span className="text-[10px] text-muted">
                              :{proc.pid}
                            </span>
                          )}
                          <span className="rounded bg-elevated px-1 text-[10px] text-subtle">
                            {proc.count}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onQuickProcessFilter(proc.name, "exclude")
                          }
                          title={`Исключить шум от процесса ${proc.name}`}
                          className="border-l border-hairline px-1.5 py-1 text-[10px] text-muted hover:bg-rose-500/20 hover:text-rose-300"
                        >
                          скрыть
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <datalist id={processDatalistId}>
                {detectedProcesses.map((p) => (
                  <option
                    key={`${p.name}-${p.pid ?? "x"}`}
                    value={p.name}
                  />
                ))}
                <option value="chrome.exe" />
                <option value="node.exe" />
                <option value="python.exe" />
                <option value="Postman.exe" />
                <option value="svchost.exe" />
              </datalist>
            </section>

            {/* Filter Rules Matrix Table */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                  <input
                    type="checkbox"
                    checked={matrixEnabled}
                    onChange={(e) => onMatrixEnabledChange(e.target.checked)}
                    className="checkbox-native"
                  />
                  <span>Матрица условий (Include / Exclude + группировка AND / OR)</span>
                </label>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule("include", "path", "contains", "/api/")
                    }
                    className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Include условие</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule("exclude", "host", "contains", "telemetry")
                    }
                    className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/25"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Exclude условие</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule(
                        "include",
                        "processName",
                        "contains",
                        "chrome.exe"
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/15 px-2.5 py-1 text-xs font-medium text-violet-300 hover:bg-violet-500/25"
                  >
                    <Cpu className="h-3.5 w-3.5" />
                    <span>+ По процессу</span>
                  </button>
                </div>
              </div>

              {rules.length === 0 ? (
                <div className="rounded-md border border-dashed border-strong bg-canvas/60 px-4 py-6 text-center text-xs text-muted">
                  Таблица условий пуста — отображаются все перехваченные сессии. Выберите готовый пресет выше или добавьте правило{" "}
                  <strong className="text-emerald-400">Include</strong> /{" "}
                  <strong className="text-rose-400">Exclude</strong>.
                </div>
              ) : (
                <div className="filter-table-wrapper rounded-md border border-hairline">
                  <table
                    className="filter-data-table text-left text-xs"
                    style={
                      {
                        "--label-2": '"Логика"',
                        "--label-3": '"Поле"',
                        "--label-4": '"Значение"',
                      } as React.CSSProperties
                    }
                  >
                    <thead>
                      <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                        <th className="px-2.5 py-2">Вкл</th>
                        <th className="px-2 py-2">Связка</th>
                        <th className="px-2 py-2">Режим</th>
                        <th className="px-2 py-2">Поле (Field)</th>
                        <th className="px-2 py-2">Оператор</th>
                        <th className="px-2 py-2">Значение (Value)</th>
                        <th className="px-2 py-2 text-right">Действие</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r, idx) => {
                        const isFirstOfAction =
                          (r.action === "include" && r.id === firstIncludeId) ||
                          (r.action === "exclude" && r.id === firstExcludeId);
                        const err = ruleErrors[r.id];

                        return (
                          <tr
                            key={r.id}
                            className={`border-b border-hairline/60 bg-canvas transition-colors hover:bg-hover/40 ${
                              !r.enabled || !matrixEnabled ? "opacity-55" : ""
                            }`}
                          >
                            <th scope="row" className="px-2.5 py-1.5 font-normal">
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={r.enabled}
                                  onChange={(e) =>
                                    updateMatrixRule(r.id, {
                                      enabled: e.target.checked,
                                    })
                                  }
                                  aria-label={`Включить правило ${idx + 1}`}
                                  className="checkbox-native"
                                />
                                <span className="font-mono text-[10px] text-subtle">
                                  #{idx + 1}
                                </span>
                              </label>
                            </th>

                            <td data-col="2" className="px-2 py-1.5">
                              {isFirstOfAction ? (
                                <span className="inline-block rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-subtle">
                                  WHERE
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateMatrixRule(r.id, {
                                      logicalOp:
                                        r.logicalOp === "AND"
                                          ? ("OR" as FilterLogicalOp)
                                          : ("AND" as FilterLogicalOp),
                                    })
                                  }
                                  title="Переключить группировку: AND (внутри одной связки) / OR (новая альтернативная группа)"
                                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold transition-colors ${
                                    r.logicalOp === "AND"
                                      ? "bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40"
                                      : "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40"
                                  }`}
                                >
                                  {r.logicalOp}
                                </button>
                              )}
                            </td>

                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  updateMatrixRule(r.id, {
                                    action:
                                      r.action === "include"
                                        ? "exclude"
                                        : "include",
                                  })
                                }
                                className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase transition-colors ${
                                  r.action === "include"
                                    ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40"
                                    : "bg-rose-500/20 text-rose-400 ring-1 ring-rose-500/40"
                                }`}
                              >
                                {r.action}
                              </button>
                            </td>

                            <td data-col="3" className="px-2 py-1.5">
                              <select
                                value={r.field}
                                onChange={(e) =>
                                  updateMatrixRule(r.id, {
                                    field: e.target.value as FilterField,
                                  })
                                }
                                aria-label="Поле фильтрации"
                                className="h-7 w-full min-w-[145px] rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                              >
                                {FILTER_FIELD_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td className="px-2 py-1.5">
                              <select
                                value={r.operator}
                                onChange={(e) =>
                                  updateMatrixRule(r.id, {
                                    operator: e.target.value as FilterOperator,
                                  })
                                }
                                aria-label="Оператор сравнения"
                                className="h-7 w-full min-w-[140px] rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                              >
                                {FILTER_OPERATOR_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td data-col="4" className="px-2 py-1.5">
                              <div className="space-y-0.5">
                                <input
                                  type="text"
                                  list={
                                    r.field === "processName"
                                      ? processDatalistId
                                      : undefined
                                  }
                                  value={r.value}
                                  onChange={(e) =>
                                    updateMatrixRule(r.id, {
                                      value: e.target.value,
                                    })
                                  }
                                  placeholder={placeholderForField(r.field)}
                                  aria-label="Значение условия"
                                  className={`h-7 w-full min-w-[170px] rounded border bg-surface px-2 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none ${
                                    err
                                      ? "border-rose-500 ring-1 ring-rose-500/40"
                                      : "border-strong focus:border-sky-500"
                                  }`}
                                />
                                {err && (
                                  <span className="block font-mono text-[10px] text-rose-400">
                                    RegExp: {err}
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="px-2 py-1.5 text-right">
                              <button
                                type="button"
                                onClick={() => removeMatrixRule(r.id)}
                                title="Удалить условие"
                                className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="text-[11px] text-subtle">
                Группировка: соседние правила с оператором{" "}
                <code className="font-mono text-sky-400">AND</code> формируют единую конъюнкцию{" "}
                <code className="font-mono">(A &amp;&amp; B)</code>, а{" "}
                <code className="font-mono text-violet-300">OR</code> открывает альтернативную группу. Правила{" "}
                <code className="font-mono text-rose-400">Exclude</code> всегда имеют приоритет над{" "}
                <code className="font-mono text-emerald-400">Include</code>.
              </p>
            </section>
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 1B: BULK HOSTS & URL LIST (WHITELIST / BLACKLIST + TLS SYNC) */}
        {/* ================================================================ */}
        {activeTab === "hostsList" && (
          <HostFiltersTab
            config={hostListFilter}
            compiled={compiledHostList}
            sessions={sessions}
            onChange={onHostListFilterChange}
            onNotify={onNotify}
          />
        )}

        {/* ================================================================ */}
        {/* TAB 2: NOISE CLEANUP, SIZE THRESHOLDS & TIME HEAT                */}
        {/* ================================================================ */}
        {activeTab === "thresholds" && (
          <>
            {/* Noise Cleanup Checkboxes */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                <Gauge className="h-4 w-4 text-sky-400" />
                <span>Автоматическая очистка протокольного и браузерного шума</span>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <NoiseToggleCard
                  checked={thresholds.hide304NotModified}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hide304NotModified: v,
                    }))
                  }
                  title="Скрывать 304 Not Modified"
                  subtitle="Убирает условные ответы кэша браузера без тела ответа"
                />
                <NoiseToggleCard
                  checked={thresholds.hideOptionsPreflight}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideOptionsPreflight: v,
                    }))
                  }
                  title="Скрывать CORS OPTIONS preflight"
                  subtitle="Скрывает служебные preflight-запросы перед POST/PUT/DELETE"
                />
                <NoiseToggleCard
                  checked={thresholds.hideConnectTunnels}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideConnectTunnels: v,
                    }))
                  }
                  title="Скрывать CONNECT / TLS Bypass туннели"
                  subtitle="Оставляет только расшифрованные HTTP/HTTPS/WSS запросы"
                />
                <NoiseToggleCard
                  checked={thresholds.hideStaticAssets}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideStaticAssets: v,
                    }))
                  }
                  title="Скрывать статику (Images / Fonts / CSS)"
                  subtitle="Скрывает картинки, шрифты .woff2, иконки и таблицы стилей"
                />
              </div>
            </section>

            {/* Payload Size Thresholds */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-fg">
                  Пороги по объему тела ответа (Body Size)
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  {[
                    { label: "Любой объем", min: null, max: null },
                    { label: "> 10 KB", min: 10 * 1024, max: null },
                    { label: "> 100 KB", min: 100 * 1024, max: null },
                    { label: "> 1 MB", min: 1024 * 1024, max: null },
                    { label: "< 50 KB", min: null, max: 50 * 1024 },
                  ].map((chip) => {
                    const active =
                      thresholds.minBodySizeBytes === chip.min &&
                      thresholds.maxBodySizeBytes === chip.max;
                    return (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() =>
                          onThresholdsChange((prev) => ({
                            ...prev,
                            minBodySizeBytes: chip.min,
                            maxBodySizeBytes: chip.max,
                          }))
                        }
                        className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                          active
                            ? "bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40"
                            : "bg-canvas text-muted hover:text-fg"
                        }`}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Минимальный размер (байт, 0/пусто — без лимита)</span>
                    {thresholds.minBodySizeBytes !== null && (
                      <span className="font-mono text-sky-400">
                        &ge; {formatBytes(thresholds.minBodySizeBytes)}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    value={thresholds.minBodySizeBytes ?? ""}
                    placeholder="Например: 1048576 (1 MB)"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      onThresholdsChange((prev) => ({
                        ...prev,
                        minBodySizeBytes:
                          val === "" ? null : Math.max(0, Number(val)),
                      }));
                    }}
                    className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
                  />
                </div>

                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Максимальный размер (байт, пусто — без лимита)</span>
                    {thresholds.maxBodySizeBytes !== null && (
                      <span className="font-mono text-sky-400">
                        &le; {formatBytes(thresholds.maxBodySizeBytes)}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    value={thresholds.maxBodySizeBytes ?? ""}
                    placeholder="Например: 51200 (50 KB)"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      onThresholdsChange((prev) => ({
                        ...prev,
                        maxBodySizeBytes:
                          val === "" ? null : Math.max(0, Number(val)),
                      }));
                    }}
                    className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
                  />
                </div>
              </div>
            </section>

            {/* Time Heat Coloring & Slow Request Filter */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                  <input
                    type="checkbox"
                    checked={thresholds.timeHeatEnabled}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatEnabled: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <Flame className="h-4 w-4 text-amber-400" />
                  <span>Time Heat — тепловая индикация медленных запросов</span>
                </label>

                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
                  <input
                    type="checkbox"
                    checked={thresholds.onlySlowRequests}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        onlySlowRequests: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <span>
                    Только медленные (&ge; {thresholds.timeHeatWarningMs} ms)
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Порог Warning (желто-оранжевая метка)</span>
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-300 tabular-nums">
                      {thresholds.timeHeatWarningMs} ms
                    </span>
                  </label>
                  <input
                    type="range"
                    min={50}
                    max={3000}
                    step={50}
                    value={thresholds.timeHeatWarningMs}
                    onChange={(e) => {
                      const warn = Number(e.target.value);
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatWarningMs: warn,
                        timeHeatCriticalMs: Math.max(
                          prev.timeHeatCriticalMs,
                          warn + 100
                        ),
                      }));
                    }}
                    className="w-full cursor-pointer"
                  />
                </div>

                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Порог Critical (красная метка SLA)</span>
                    <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-rose-300 tabular-nums">
                      {thresholds.timeHeatCriticalMs} ms
                    </span>
                  </label>
                  <input
                    type="range"
                    min={200}
                    max={10000}
                    step={100}
                    value={thresholds.timeHeatCriticalMs}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatCriticalMs: Math.max(
                          prev.timeHeatWarningMs + 100,
                          Number(e.target.value)
                        ),
                      }))
                    }
                    className="w-full cursor-pointer"
                  />
                </div>
              </div>
            </section>
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 3: SELECTIVE TLS MITM MODE (TARGETED ALLOWLIST & BYPASS)     */}
        {/* ================================================================ */}
        {activeTab === "tlsBypass" && (
          <div className="space-y-4">
            {/* Mode Switcher Cards */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                  <Target className="h-4 w-4 text-teal-400" />
                  <span>
                    Режим работы TLS MITM («Чистый проброс» vs Полная инспекция)
                  </span>
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg">
                  <input
                    type="checkbox"
                    checked={thresholds.hideConnectTunnels}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        hideConnectTunnels: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <span>
                    Скрывать сквозные туннели{" "}
                    <code className="font-mono text-teal-300">TUNNEL</code>{" "}
                    в таблице сессий
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsInterceptMode: "interceptAll",
                    })
                  }
                  aria-pressed={
                    backendConfig.tlsInterceptMode !== "targetedOnly"
                  }
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    backendConfig.tlsInterceptMode !== "targetedOnly"
                      ? "border-sky-500/60 bg-sky-500/10 text-fg ring-1 ring-sky-500/30"
                      : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  <div className="flex w-full items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5">
                      <Shield className="h-4 w-4 text-sky-400" />
                      <span>Mode: Intercept All (Except Bypass List)</span>
                    </span>
                    {backendConfig.tlsInterceptMode !== "targetedOnly" && (
                      <span className="rounded bg-sky-500/25 px-1.5 py-0.5 font-mono text-[10px] text-sky-200">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    Стандартный режим: расшифровывает весь HTTPS/WSS трафик, кроме
                    хостов из таблицы <strong className="text-fg">TLS Bypass</strong>{" "}
                    ниже.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsInterceptMode: "targetedOnly",
                    })
                  }
                  aria-pressed={
                    backendConfig.tlsInterceptMode === "targetedOnly"
                  }
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    backendConfig.tlsInterceptMode === "targetedOnly"
                      ? "border-teal-500/60 bg-teal-500/10 text-fg ring-1 ring-teal-500/30"
                      : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  <div className="flex w-full items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5">
                      <Target className="h-4 w-4 text-teal-400" />
                      <span>Mode: Targeted Only (Allowlist)</span>
                    </span>
                    {backendConfig.tlsInterceptMode === "targetedOnly" && (
                      <span className="rounded bg-teal-500/25 px-1.5 py-0.5 font-mono text-[10px] text-teal-200">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    MITM-сертификаты генерируются{" "}
                    <strong className="text-teal-300">ТОЛЬКО</strong> для{" "}
                    <strong className="text-fg">Target Allowlist</strong>. Все
                    остальные <code className="font-mono">CONNECT</code>-запросы
                    (Telegram, Steam, банки, MS Teams, mTLS) уходят напрямую в{" "}
                    <code className="font-mono text-teal-300">
                      tokio::io::copy_bidirectional
                    </code>
                    !
                  </p>
                </button>
              </div>
            </section>

            {/* View Switcher + Quick Paste + Import/Export + Recommended Reset Toolbar */}
            <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-surface px-3.5 py-2.5">
              <div
                role="group"
                aria-label="Режим отображения правил TLS"
                className="inline-flex items-center rounded-md border border-strong bg-canvas p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={tlsViewMode === "table"}
                  onClick={() => handleTlsViewModeChange("table")}
                  className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    tlsViewMode === "table"
                      ? "bg-teal-600 text-white shadow-sm"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Table View</span>
                </button>
                <button
                  type="button"
                  aria-pressed={tlsViewMode === "bulk"}
                  onClick={() => handleTlsViewModeChange("bulk")}
                  className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    tlsViewMode === "bulk"
                      ? "bg-teal-600 text-white shadow-sm"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Bulk Text Editor</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  ref={tlsImportInputRef}
                  type="file"
                  accept=".txt,.json,.list,.conf,text/plain,application/json"
                  onChange={(e) => void handleImportTlsFile(e)}
                  className="hidden"
                  tabIndex={-1}
                />

                <button
                  type="button"
                  onClick={openQuickPasteModal}
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-teal-500/45 bg-teal-500/15 px-2.5 text-xs font-medium text-teal-300 transition-colors hover:bg-teal-500/25"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Quick Paste…</span>
                </button>

                <button
                  type="button"
                  onClick={() => tlsImportInputRef.current?.click()}
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
                >
                  <FileUp
                    className="h-3.5 w-3.5 text-sky-400"
                    aria-hidden="true"
                  />
                  <span>Импорт TXT/JSON</span>
                </button>

                <button
                  type="button"
                  onClick={handleExportTlsTxt}
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
                >
                  <Download
                    className="h-3.5 w-3.5 text-indigo-400"
                    aria-hidden="true"
                  />
                  <span>Экспорт TXT</span>
                </button>

                <button
                  type="button"
                  onClick={handleExportTlsJson}
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-strong bg-canvas px-2.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
                >
                  <Download
                    className="h-3.5 w-3.5 text-amber-400"
                    aria-hidden="true"
                  />
                  <span>Экспорт JSON</span>
                </button>

                <button
                  type="button"
                  disabled={isResettingDefaults}
                  onClick={() => void handleResetRecommendedDefaults()}
                  title="Сбросить таблицу TLS Bypass к рекомендуемому списку PKI / OCSP / CRL и системных служб"
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-hairline bg-canvas px-2.5 text-xs font-medium text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Сброс PKI/OCSP</span>
                </button>
              </div>
            </section>

            {/* Session Domain Chips (+ Target / + Bypass) */}
            {sessionDomainChips.length > 0 && (
              <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <Globe className="h-3.5 w-3.5 text-teal-400" aria-hidden="true" />
                    <span>
                      Домены текущей сессии ({sessionDomainChips.length}) — быстрое
                      добавление в Target или Bypass
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-subtle">
                    1-клик правило
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sessionDomainChips.map(([host, count]) => {
                    const inTarget = (backendConfig.tlsTargetRules ?? []).some(
                      (r) =>
                        r.enabled &&
                        r.pattern
                          .toLowerCase()
                          .split(/[,;]/)
                          .some((t) => t.trim() === host)
                    );
                    const inBypass = backendConfig.tlsBypassRules.some(
                      (r) =>
                        r.enabled &&
                        r.pattern
                          .toLowerCase()
                          .split(/[,;]/)
                          .some((t) => t.trim() === host)
                    );

                    return (
                      <div
                        key={host}
                        className="inline-flex items-center overflow-hidden rounded-md border border-hairline bg-canvas font-mono text-[11px]"
                      >
                        <span
                          className="max-w-[180px] truncate px-2 py-0.5 text-fg"
                          title={host}
                        >
                          {host}
                        </span>
                        <span className="pr-1.5 text-[10px] text-subtle tabular-nums">
                          ({count})
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleQuickSessionDomain(host, "target")
                          }
                          title={`Добавить ${host} в Target Allowlist (расшифровывать MITM)`}
                          className={`border-l border-hairline px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                            inTarget
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "text-muted hover:bg-emerald-500/15 hover:text-emerald-300"
                          }`}
                        >
                          + Target
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleQuickSessionDomain(host, "bypass")
                          }
                          title={`Добавить ${host} в TLS Bypass (туннелировать без MITM)`}
                          className={`border-l border-hairline px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                            inBypass
                              ? "bg-teal-500/20 text-teal-300"
                              : "text-muted hover:bg-teal-500/15 hover:text-teal-300"
                          }`}
                        >
                          + Bypass
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* BULK TEXT EDITOR VIEW */}
            {tlsViewMode === "bulk" ? (
              <div className="space-y-4">
                <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <h3 className="text-xs font-semibold text-fg">
                        Пакетный текстовый редактор (Bulk Text Editor)
                      </h3>
                      <p className="text-[11px] text-muted">
                        Формат строки:{" "}
                        <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
                          *.domain.com # [Category] Описание
                        </code>{" "}
                        или{" "}
                        <code className="rounded bg-elevated px-1 font-mono text-[10px] text-fg">
                          [disabled] host.com
                        </code>
                        . Метаданные (<code className="font-mono">id</code>,{" "}
                        <code className="font-mono">enabled</code>,{" "}
                        <code className="font-mono">category</code>,{" "}
                        <code className="font-mono">description</code>)
                        сохраняются при переключении в{" "}
                        <strong className="text-fg">Table View</strong>.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setBulkBypassText(
                            tlsRulesToBulkText(backendConfig.tlsBypassRules)
                          );
                          setBulkTargetText(
                            tlsRulesToBulkText(
                              backendConfig.tlsTargetRules ?? []
                            )
                          );
                          onNotify?.("Текст синхронизирован из таблиц");
                        }}
                        className="inline-flex h-7 items-center gap-1 rounded border border-strong bg-canvas px-2.5 text-xs text-muted hover:text-fg"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        <span>Сбросить правки</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => commitBulkTextEditor(true)}
                        className="inline-flex h-7 items-center gap-1 rounded bg-teal-600 px-3 text-xs font-semibold text-white hover:bg-teal-500"
                      >
                        <span>Применить изменения</span>
                      </button>
                    </div>
                  </div>

                  {/* TLS Bypass Rules Bulk Textarea */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="bulk-tls-bypass-textarea"
                        className="flex items-center gap-1.5 text-xs font-semibold text-fg"
                      >
                        <ShieldOff
                          className="h-3.5 w-3.5 text-teal-400"
                          aria-hidden="true"
                        />
                        <span>TLS / MITM Bypass (Intercept All исключения)</span>
                      </label>
                      <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal-300 tabular-nums">
                        Распознано правил: {parsedBulkBypassPreview.length}
                      </span>
                    </div>
                    <textarea
                      id="bulk-tls-bypass-textarea"
                      value={bulkBypassText}
                      onChange={(e) => setBulkBypassText(e.target.value)}
                      onBlur={() => commitBulkTextEditor(false)}
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder={
                        "ocsp.*, crl.*, *.digicert.com # [OCSP / CRL PKI] OCSP / CRL проверка сертификатов\n*.apple.com, *.icloud.com # [Apple & APNs] Apple Pinning"
                      }
                      className="hosts-list-textarea rounded-md border border-strong bg-canvas p-3 font-mono text-xs leading-relaxed text-teal-300 placeholder:text-subtle focus:border-teal-500 focus:outline-none"
                    />
                  </div>

                  {/* Target Allowlist Rules Bulk Textarea */}
                  <div className="space-y-1.5 pt-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor="bulk-tls-target-textarea"
                        className="flex items-center gap-1.5 text-xs font-semibold text-fg"
                      >
                        <Target
                          className="h-3.5 w-3.5 text-emerald-400"
                          aria-hidden="true"
                        />
                        <span>Target Allowlist (Targeted Only хосты)</span>
                      </label>
                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-300 tabular-nums">
                        Распознано правил: {parsedBulkTargetPreview.length}
                      </span>
                    </div>
                    <textarea
                      id="bulk-tls-target-textarea"
                      value={bulkTargetText}
                      onChange={(e) => setBulkTargetText(e.target.value)}
                      onBlur={() => commitBulkTextEditor(false)}
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder={
                        "*.mycompany.com, api.test.ru # [Target Service] Целевые домены для MITM\n!mtls.mycompany.com # [Exception] Исключение из Allowlist"
                      }
                      className="hosts-list-textarea rounded-md border border-strong bg-canvas p-3 font-mono text-xs leading-relaxed text-emerald-300 placeholder:text-subtle focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </section>
              </div>
            ) : (
              <>
                {/* Target Allowlist Section (Primary in Targeted Only mode, also usable anytime) */}
                <section
                  className={`rounded-lg border p-3.5 space-y-3 ${
                    backendConfig.tlsInterceptMode === "targetedOnly"
                      ? "border-teal-500/45 bg-surface"
                      : "border-hairline bg-surface"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                      <Target className="h-4 w-4 text-teal-400" />
                      <span>
                        Target Allowlist — Целевые хосты для расшифровки
                        (Targeted Only)
                      </span>
                      <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted tabular-nums">
                        Hits: {totalTargetHits.toLocaleString()}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const rule: TlsBypassRule = {
                            id: `target-local-${Date.now()}`,
                            enabled: true,
                            pattern: "localhost, 127.0.0.1, *.local",
                            category: "Local Dev",
                            description:
                              "Локальные стенды и ASP.NET / SignalR хабы",
                          };
                          void onBackendConfigChange({
                            ...backendConfig,
                            tlsTargetRules: [
                              rule,
                              ...(backendConfig.tlsTargetRules ?? []),
                            ],
                          });
                        }}
                        className="rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                      >
                        + localhost / 127.0.0.1
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const rule: TlsBypassRule = {
                            id: `target-corp-${Date.now()}`,
                            enabled: true,
                            pattern: "*.mycompany.com, api.test.ru",
                            category: "Staging / Prod",
                            description: "Шаблон целевых корпоративных доменов",
                          };
                          void onBackendConfigChange({
                            ...backendConfig,
                            tlsTargetRules: [
                              rule,
                              ...(backendConfig.tlsTargetRules ?? []),
                            ],
                          });
                        }}
                        className="rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                      >
                        + *.mycompany.com, api.test.ru
                      </button>
                    </div>
                  </div>

                  <p className="rounded-md border border-teal-500/25 bg-teal-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-muted">
                    Поддерживаются точные домены (
                    <code className="font-mono text-fg">api.test.ru</code>),
                    поддомены (
                    <code className="font-mono text-fg">*.mycompany.com</code>),{" "}
                    <code className="font-mono text-fg">regex:...</code> и
                    точечные исключения с префиксом{" "}
                    <code className="font-mono text-amber-300">
                      !mtls.mycompany.com
                    </code>
                    . Вы также можете кликнуть правой кнопкой мыши по любой
                    строке в таблице сессий →{" "}
                    <strong className="text-fg">«Always inspect this host»</strong>.
                  </p>

                  <form
                    onSubmit={handleAddTlsTarget}
                    className="grid grid-cols-1 gap-2 rounded-md border border-hairline bg-canvas p-2.5 sm:grid-cols-12"
                  >
                    <input
                      type="text"
                      value={newTargetPattern}
                      onChange={(e) => setNewTargetPattern(e.target.value)}
                      placeholder="*.mycompany.com, api.test.ru"
                      aria-label="Целевой хост или маска для Target Allowlist"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="h-8 rounded border border-strong bg-surface px-2.5 font-mono text-xs text-fg sm:col-span-5"
                    />
                    <select
                      value={newTargetCategory}
                      onChange={(e) => setNewTargetCategory(e.target.value)}
                      aria-label="Категория целевого хоста"
                      className="h-8 rounded border border-strong bg-surface px-2 text-xs text-fg sm:col-span-3"
                    >
                      <option value="Target Service">Target Service</option>
                      <option value="SignalR / API">SignalR / API</option>
                      <option value="Local Dev">Local Dev</option>
                      <option value="Staging / Prod">Staging / Prod</option>
                    </select>
                    <input
                      type="text"
                      value={newTargetDesc}
                      onChange={(e) => setNewTargetDesc(e.target.value)}
                      placeholder="Заметка (необязательно)"
                      aria-label="Описание целевого правила"
                      className="h-8 rounded border border-strong bg-surface px-2.5 text-xs text-fg sm:col-span-3"
                    />
                    <button
                      type="submit"
                      disabled={!newTargetPattern.trim()}
                      aria-label="Добавить целевой хост"
                      className="inline-flex h-8 items-center justify-center gap-1 rounded bg-teal-600 px-2.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-40 sm:col-span-1"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </form>

                  {/* Bulk Selection Toolbar for Target Allowlist */}
                  {(backendConfig.tlsTargetRules ?? []).length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-canvas/70 px-2.5 py-1.5 text-[11px]">
                      <div className="flex items-center gap-2 text-muted">
                        <CheckSquare
                          className="h-3.5 w-3.5 text-emerald-400"
                          aria-hidden="true"
                        />
                        <span className="font-mono tabular-nums">
                          Выбрано: {selectedTargetIds.size} /{" "}
                          {(backendConfig.tlsTargetRules ?? []).length}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={selectedTargetIds.size === 0}
                          onClick={() => handleBulkRowAction("target", "enable")}
                          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
                        >
                          Включить
                        </button>
                        <button
                          type="button"
                          disabled={selectedTargetIds.size === 0}
                          onClick={() =>
                            handleBulkRowAction("target", "disable")
                          }
                          className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-40"
                        >
                          Выключить
                        </button>
                        <button
                          type="button"
                          disabled={selectedTargetIds.size === 0}
                          onClick={() => handleBulkRowAction("target", "delete")}
                          className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-40"
                        >
                          Удалить
                        </button>
                        {selectedTargetIds.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedTargetIds(new Set())}
                            className="rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                          >
                            Снять выбор
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {(backendConfig.tlsTargetRules ?? []).length === 0 ? (
                    <div className="rounded-md border border-dashed border-strong bg-canvas/60 px-4 py-5 text-center text-xs text-muted">
                      Список <strong className="text-fg">Target Allowlist</strong>{" "}
                      пока пуст.{" "}
                      {backendConfig.tlsInterceptMode === "targetedOnly" ? (
                        <span className="text-amber-300">
                          Сейчас включён режим «Targeted Only» — все HTTPS/WSS
                          соединения проходят сквозным TCP-туннелем без
                          расшифровки, пока вы не добавите целевой хост выше или
                          через ПКМ по сессии!
                        </span>
                      ) : (
                        <span>
                          Добавьте целевые хосты (например{" "}
                          <code className="font-mono">*.mycompany.com</code>) и
                          переключите режим в{" "}
                          <strong className="text-teal-300">
                            Targeted Only (Allowlist)
                          </strong>
                          .
                        </span>
                      )}
                    </div>
                  ) : (
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label="Таблица Target Allowlist"
                      className="filter-table-wrapper rounded-md border border-hairline"
                    >
                      <table
                        className="filter-data-table text-left text-xs"
                        style={
                          {
                            "--label-2": '"Целевой хост"',
                            "--label-3": '"Категория / Hits"',
                            "--label-4": '"Описание"',
                          } as React.CSSProperties
                        }
                      >
                        <thead>
                          <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                            <th className="px-2.5 py-2">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={
                                    (backendConfig.tlsTargetRules ?? [])
                                      .length > 0 &&
                                    (backendConfig.tlsTargetRules ?? []).every(
                                      (r) => selectedTargetIds.has(r.id)
                                    )
                                  }
                                  onChange={() =>
                                    toggleSelectAllRules("target")
                                  }
                                  aria-label="Выбрать все правила Target Allowlist"
                                  className="checkbox-native"
                                />
                                <span>Вкл</span>
                              </div>
                            </th>
                            <th className="px-2 py-2">
                              Целевой паттерн (Inspect Allowlist)
                            </th>
                            <th className="px-2 py-2">Категория / Hits</th>
                            <th className="px-2 py-2">Заметка</th>
                            <th className="px-2 py-2 text-right">Удалить</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(backendConfig.tlsTargetRules ?? []).map((item) => {
                            const hitCount = tlsHitCounts[item.id] ?? 0;
                            const isRowSelected = selectedTargetIds.has(
                              item.id
                            );
                            return (
                              <tr
                                key={item.id}
                                className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                                  !item.enabled ? "opacity-55" : ""
                                } ${isRowSelected ? "bg-selected/50" : ""}`}
                              >
                                <th
                                  scope="row"
                                  className="px-2.5 py-1.5 font-normal"
                                >
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="checkbox"
                                      checked={isRowSelected}
                                      onChange={() =>
                                        toggleSelectRule("target", item.id)
                                      }
                                      aria-label={`Выбрать для массового действия ${item.pattern}`}
                                      className="checkbox-native"
                                    />
                                    <input
                                      type="checkbox"
                                      checked={item.enabled}
                                      onChange={(e) => {
                                        const next = (
                                          backendConfig.tlsTargetRules ?? []
                                        ).map((r) =>
                                          r.id === item.id
                                            ? {
                                                ...r,
                                                enabled: e.target.checked,
                                              }
                                            : r
                                        );
                                        void onBackendConfigChange({
                                          ...backendConfig,
                                          tlsTargetRules: next,
                                        });
                                      }}
                                      aria-label={`Включить целевой хост ${item.pattern}`}
                                      className="checkbox-native"
                                    />
                                  </div>
                                </th>
                                <td data-col="2" className="px-2 py-1.5">
                                  <input
                                    type="text"
                                    value={item.pattern}
                                    onChange={(e) => {
                                      const next = (
                                        backendConfig.tlsTargetRules ?? []
                                      ).map((r) =>
                                        r.id === item.id
                                          ? { ...r, pattern: e.target.value }
                                          : r
                                      );
                                      void onBackendConfigChange({
                                        ...backendConfig,
                                        tlsTargetRules: next,
                                      });
                                    }}
                                    aria-label={`Паттерн Target Allowlist для ${item.id}`}
                                    autoCorrect="off"
                                    autoCapitalize="off"
                                    spellCheck={false}
                                    className="h-7 w-full min-w-[200px] rounded border border-strong bg-surface px-2 font-mono text-xs text-emerald-300"
                                  />
                                </td>
                                <td data-col="3" className="px-2 py-1.5">
                                  <div className="flex flex-wrap items-center gap-1">
                                    <span className="inline-block rounded bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
                                      {item.category}
                                    </span>
                                    <span
                                      title="Счетчик совпадений правила в Rust ProxyFilterEngine"
                                      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                                        hitCount > 0
                                          ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-inset ring-emerald-500/35"
                                          : "bg-elevated text-subtle"
                                      }`}
                                    >
                                      Hits: {hitCount.toLocaleString()}
                                    </span>
                                  </div>
                                </td>
                                <td data-col="4" className="px-2 py-1.5 text-muted">
                                  {item.description}
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = (
                                        backendConfig.tlsTargetRules ?? []
                                      ).filter((r) => r.id !== item.id);
                                      void onBackendConfigChange({
                                        ...backendConfig,
                                        tlsTargetRules: next,
                                      });
                                    }}
                                    title="Удалить из списка Target Allowlist"
                                    className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* Bypass List Section (Used in Intercept All mode) */}
                <section
                  className={`rounded-lg border border-hairline bg-surface p-3.5 space-y-3 ${
                    backendConfig.tlsInterceptMode === "targetedOnly"
                      ? "opacity-75"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                      <input
                        type="checkbox"
                        checked={backendConfig.tlsBypassEnabled}
                        onChange={(e) =>
                          void onBackendConfigChange({
                            ...backendConfig,
                            tlsBypassEnabled: e.target.checked,
                          })
                        }
                        className="checkbox-native"
                      />
                      <ShieldOff className="h-4 w-4 text-teal-400" />
                      <span>
                        Таблица TLS / MITM Bypass (Исключения для режима «Intercept
                        All»)
                      </span>
                    </label>

                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted tabular-nums">
                        Hits: {totalBypassHits.toLocaleString()}
                      </span>
                      <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal-300">
                        tokio::io::copy_bidirectional
                      </span>
                    </div>
                  </div>

                  <p className="rounded-md border border-teal-500/25 bg-teal-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-muted">
                    Для совпадающих доменов (поддерживаются маски{" "}
                    <code className="font-mono text-fg">*.apple.com</code>, списки
                    через запятую и{" "}
                    <code className="font-mono text-fg">regex:...</code>) прокси
                    не вызывает{" "}
                    <code className="font-mono text-teal-300">rcgen</code>, а
                    пробрасывает{" "}
                    <code className="font-mono text-teal-300">CONNECT</code>
                    -туннель прозрачно байт-в-байт, предотвращая разрыв
                    соединения клиентами с жестким пиннингом сертификатов.
                  </p>

                  {/* 10+ Curated Quick Category Packs */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span className="font-semibold text-fg">
                        Готовые Quick-Packs ({TLS_BYPASS_QUICK_PACKS.length})
                      </span>
                      <span>1-клик добавление группы доменов</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {TLS_BYPASS_QUICK_PACKS.map((pack) => (
                        <button
                          key={pack.label}
                          type="button"
                          title={`${pack.rule.description}\n${pack.rule.pattern}`}
                          onClick={() => {
                            const canonicalPat = pack.rule.pattern
                              .trim()
                              .toLowerCase();
                            const existing = backendConfig.tlsBypassRules.find(
                              (r) => r.pattern.trim().toLowerCase() === canonicalPat
                            );
                            if (existing) {
                              if (!existing.enabled) {
                                const updated = backendConfig.tlsBypassRules.map(
                                  (r) =>
                                    r.id === existing.id
                                      ? { ...r, enabled: true }
                                      : r
                                );
                                void onBackendConfigChange({
                                  ...backendConfig,
                                  tlsBypassEnabled: true,
                                  tlsBypassRules: updated,
                                });
                                onNotify?.(`Включен набор: ${pack.label}`);
                              } else {
                                onNotify?.(`Набор уже добавлен: ${pack.label}`);
                              }
                              return;
                            }
                            const rule: TlsBypassRule = {
                              id: `bypass-pack-${Date.now()}-${Math.random()
                                .toString(36)
                                .slice(2, 5)}`,
                              ...pack.rule,
                            };
                            void onBackendConfigChange({
                              ...backendConfig,
                              tlsBypassEnabled: true,
                              tlsBypassRules: [
                                rule,
                                ...backendConfig.tlsBypassRules,
                              ],
                            });
                            onNotify?.(`Добавлен набор: ${pack.label}`);
                          }}
                          className="rounded border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                        >
                          {pack.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Add New TLS Bypass Rule Form */}
                  <form
                    onSubmit={handleAddTlsBypass}
                    className="grid grid-cols-1 gap-2 rounded-md border border-hairline bg-canvas p-2.5 sm:grid-cols-12"
                  >
                    <input
                      type="text"
                      value={newBypassPattern}
                      onChange={(e) => setNewBypassPattern(e.target.value)}
                      placeholder="*.bank.ru, api.payments.io"
                      aria-label="Домен или маска для TLS Bypass"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      className="h-8 rounded border border-strong bg-surface px-2.5 font-mono text-xs text-fg sm:col-span-5"
                    />
                    <select
                      value={newBypassCategory}
                      onChange={(e) => setNewBypassCategory(e.target.value)}
                      aria-label="Категория домена"
                      className="h-8 rounded border border-strong bg-surface px-2 text-xs text-fg sm:col-span-3"
                    >
                      <option value="OCSP / CRL PKI">OCSP / CRL PKI</option>
                      <option value="Payment Gateways">Payment Gateways</option>
                      <option value="OS Updaters">OS Updaters</option>
                      <option value="Dev Tools & Packages">
                        Dev Tools &amp; Packages
                      </option>
                      <option value="DRM & Streaming">DRM &amp; Streaming</option>
                      <option value="Gaming & Anti-Cheat">
                        Gaming &amp; Anti-Cheat
                      </option>
                      <option value="РФ FinTech & Госуслуги">
                        РФ FinTech &amp; Госуслуги
                      </option>
                      <option value="Google & Android FCM">
                        Google &amp; Android FCM
                      </option>
                      <option value="Apple & APNs">Apple &amp; APNs</option>
                      <option value="Windows & Telemetry">
                        Windows &amp; Telemetry
                      </option>
                      <option value="Messengers">Messengers</option>
                      <option value="Video & CDN">Video &amp; CDN</option>
                      <option value="Custom Pinning">Custom Pinning</option>
                    </select>
                    <input
                      type="text"
                      value={newBypassDesc}
                      onChange={(e) => setNewBypassDesc(e.target.value)}
                      placeholder="Описание (необязательно)"
                      aria-label="Описание правила TLS Bypass"
                      className="h-8 rounded border border-strong bg-surface px-2.5 text-xs text-fg sm:col-span-3"
                    />
                    <button
                      type="submit"
                      disabled={!newBypassPattern.trim()}
                      aria-label="Добавить правило TLS Bypass"
                      className="inline-flex h-8 items-center justify-center gap-1 rounded bg-teal-600 px-2.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-40 sm:col-span-1"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </form>

                  {/* Bulk Selection Toolbar for TLS Bypass Table */}
                  {backendConfig.tlsBypassRules.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-canvas/70 px-2.5 py-1.5 text-[11px]">
                      <div className="flex items-center gap-2 text-muted">
                        <CheckSquare
                          className="h-3.5 w-3.5 text-teal-400"
                          aria-hidden="true"
                        />
                        <span className="font-mono tabular-nums">
                          Выбрано: {selectedBypassIds.size} /{" "}
                          {backendConfig.tlsBypassRules.length}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={selectedBypassIds.size === 0}
                          onClick={() => handleBulkRowAction("bypass", "enable")}
                          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
                        >
                          Включить
                        </button>
                        <button
                          type="button"
                          disabled={selectedBypassIds.size === 0}
                          onClick={() =>
                            handleBulkRowAction("bypass", "disable")
                          }
                          className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-40"
                        >
                          Выключить
                        </button>
                        <button
                          type="button"
                          disabled={selectedBypassIds.size === 0}
                          onClick={() => handleBulkRowAction("bypass", "delete")}
                          className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-40"
                        >
                          Удалить
                        </button>
                        {selectedBypassIds.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setSelectedBypassIds(new Set())}
                            className="rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                          >
                            Снять выбор
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TLS Bypass Table */}
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label="Таблица TLS Bypass"
                    className="filter-table-wrapper rounded-md border border-hairline"
                  >
                    <table
                      className="filter-data-table text-left text-xs"
                      style={
                        {
                          "--label-2": '"Домен"',
                          "--label-3": '"Категория / Hits"',
                          "--label-4": '"Описание"',
                        } as React.CSSProperties
                      }
                    >
                      <thead>
                        <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                          <th className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={
                                  backendConfig.tlsBypassRules.length > 0 &&
                                  backendConfig.tlsBypassRules.every((r) =>
                                    selectedBypassIds.has(r.id)
                                  )
                                }
                                onChange={() => toggleSelectAllRules("bypass")}
                                aria-label="Выбрать все правила TLS Bypass"
                                className="checkbox-native"
                              />
                              <span>Вкл</span>
                            </div>
                          </th>
                          <th className="px-2 py-2">
                            Паттерн домена (Host / Wildcard)
                          </th>
                          <th className="px-2 py-2">Категория / Hits</th>
                          <th className="px-2 py-2">Заметка</th>
                          <th className="px-2 py-2 text-right">Удалить</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backendConfig.tlsBypassRules.map((item) => {
                          const hitCount = tlsHitCounts[item.id] ?? 0;
                          const isRowSelected = selectedBypassIds.has(item.id);
                          return (
                            <tr
                              key={item.id}
                              className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                                !item.enabled || !backendConfig.tlsBypassEnabled
                                  ? "opacity-55"
                                  : ""
                              } ${isRowSelected ? "bg-selected/50" : ""}`}
                            >
                              <th
                                scope="row"
                                className="px-2.5 py-1.5 font-normal"
                              >
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={isRowSelected}
                                    onChange={() =>
                                      toggleSelectRule("bypass", item.id)
                                    }
                                    aria-label={`Выбрать для массового действия ${item.pattern}`}
                                    className="checkbox-native"
                                  />
                                  <input
                                    type="checkbox"
                                    checked={item.enabled}
                                    onChange={(e) => {
                                      const next =
                                        backendConfig.tlsBypassRules.map((r) =>
                                          r.id === item.id
                                            ? {
                                                ...r,
                                                enabled: e.target.checked,
                                              }
                                            : r
                                        );
                                      void onBackendConfigChange({
                                        ...backendConfig,
                                        tlsBypassRules: next,
                                      });
                                    }}
                                    aria-label={`Включить TLS Bypass для ${item.pattern}`}
                                    className="checkbox-native"
                                  />
                                </div>
                              </th>
                              <td data-col="2" className="px-2 py-1.5">
                                <input
                                  type="text"
                                  value={item.pattern}
                                  onChange={(e) => {
                                    const next =
                                      backendConfig.tlsBypassRules.map((r) =>
                                        r.id === item.id
                                          ? { ...r, pattern: e.target.value }
                                          : r
                                      );
                                    void onBackendConfigChange({
                                      ...backendConfig,
                                      tlsBypassRules: next,
                                    });
                                  }}
                                  aria-label={`Паттерн TLS Bypass для ${item.id}`}
                                  autoCorrect="off"
                                  autoCapitalize="off"
                                  spellCheck={false}
                                  className="h-7 w-full min-w-[200px] rounded border border-strong bg-surface px-2 font-mono text-xs text-teal-300"
                                />
                              </td>
                              <td data-col="3" className="px-2 py-1.5">
                                <div className="flex flex-wrap items-center gap-1">
                                  <span className="inline-block rounded bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
                                    {item.category}
                                  </span>
                                  <span
                                    title="Счетчик срабатываний правила в Rust ProxyFilterEngine"
                                    className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                                      hitCount > 0
                                        ? "bg-teal-500/20 text-teal-300 ring-1 ring-inset ring-teal-500/35"
                                        : "bg-elevated text-subtle"
                                    }`}
                                  >
                                    Hits: {hitCount.toLocaleString()}
                                  </span>
                                </div>
                              </td>
                              <td data-col="4" className="px-2 py-1.5 text-muted">
                                {item.description}
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next =
                                      backendConfig.tlsBypassRules.filter(
                                        (r) => r.id !== item.id
                                      );
                                    void onBackendConfigChange({
                                      ...backendConfig,
                                      tlsBypassRules: next,
                                    });
                                  }}
                                  title="Удалить из списка TLS Bypass"
                                  className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {/* ================================================================ */}
        {/* TAB 4: LIGHTWEIGHT HEADER MUTATIONS                              */}
        {/* ================================================================ */}
        {activeTab === "headers" && (
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
        )}
      </div>
    </dialog>

    {/* Quick Paste Modal Dialog */}
    <dialog
      ref={quickPasteDialogRef}
      aria-labelledby={quickPasteTitleId}
      onClose={() => {
        if (quickPasteDialogRef.current) {
          quickPasteDialogRef.current.returnValue = "";
        }
        setQuickPasteOpen(false);
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      <div className="flex items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <ClipboardPaste
            className="h-4 w-4 text-teal-400"
            aria-hidden="true"
          />
          <h3 id={quickPasteTitleId} className="text-sm font-semibold text-fg">
            Quick Paste — пакетное добавление доменов
          </h3>
        </div>
        <form method="dialog">
          <button
            value="cancel"
            aria-label="Закрыть Quick Paste"
            className="rounded-md border border-hairline bg-surface p-1 text-muted hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      </div>

      <form onSubmit={handleSubmitQuickPaste} className="space-y-3 p-4">
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Куда добавить правила
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs ${
                quickPasteTarget === "bypass"
                  ? "border-teal-500/60 bg-teal-500/10 text-fg"
                  : "border-hairline bg-canvas text-muted hover:text-fg"
              }`}
            >
              <input
                type="radio"
                name="quick-paste-target"
                value="bypass"
                checked={quickPasteTarget === "bypass"}
                onChange={() => {
                  setQuickPasteTarget("bypass");
                  setQuickPasteCategory("Custom Pinning");
                }}
                className="accent-teal-500"
              />
              <span>TLS Bypass (Intercept All)</span>
            </label>
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs ${
                quickPasteTarget === "target"
                  ? "border-emerald-500/60 bg-emerald-500/10 text-fg"
                  : "border-hairline bg-canvas text-muted hover:text-fg"
              }`}
            >
              <input
                type="radio"
                name="quick-paste-target"
                value="target"
                checked={quickPasteTarget === "target"}
                onChange={() => {
                  setQuickPasteTarget("target");
                  setQuickPasteCategory("Target Service");
                }}
                className="accent-emerald-500"
              />
              <span>Target Allowlist (Targeted Only)</span>
            </label>
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label
              htmlFor="quick-paste-category"
              className="mb-1 block text-[11px] font-medium text-muted"
            >
              Категория
            </label>
            <select
              id="quick-paste-category"
              value={quickPasteCategory}
              onChange={(e) => setQuickPasteCategory(e.target.value)}
              className="h-8 w-full rounded border border-strong bg-canvas px-2 text-xs text-fg"
            >
              <option value="Target Service">Target Service</option>
              <option value="OCSP / CRL PKI">OCSP / CRL PKI</option>
              <option value="Payment Gateways">Payment Gateways</option>
              <option value="OS Updaters">OS Updaters</option>
              <option value="Dev Tools & Packages">
                Dev Tools &amp; Packages
              </option>
              <option value="DRM & Streaming">DRM &amp; Streaming</option>
              <option value="Gaming & Anti-Cheat">
                Gaming &amp; Anti-Cheat
              </option>
              <option value="РФ FinTech & Госуслуги">
                РФ FinTech &amp; Госуслуги
              </option>
              <option value="Google & Android FCM">
                Google &amp; Android FCM
              </option>
              <option value="Apple & APNs">Apple &amp; APNs</option>
              <option value="Windows & Telemetry">Windows &amp; Telemetry</option>
              <option value="Messengers">Messengers</option>
              <option value="Video & CDN">Video &amp; CDN</option>
              <option value="Custom Pinning">Custom Pinning</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="quick-paste-desc"
              className="mb-1 block text-[11px] font-medium text-muted"
            >
              Заметка (необязательно)
            </label>
            <input
              id="quick-paste-desc"
              type="text"
              value={quickPasteDesc}
              onChange={(e) => setQuickPasteDesc(e.target.value)}
              placeholder="Например: Мобильное приложение банка"
              className="h-8 w-full rounded border border-strong bg-canvas px-2.5 text-xs text-fg"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={quickPasteTextareaId}
              className="text-[11px] font-medium text-muted"
            >
              Список доменов, масок, URL или{" "}
              <code className="font-mono text-fg">regex:</code> (по строкам)
            </label>
            <button
              type="button"
              onClick={() => void handleQuickPasteFromClipboard()}
              className="inline-flex items-center gap-1 rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted hover:border-strong hover:text-fg"
            >
              <ClipboardPaste className="h-3 w-3 text-teal-400" />
              <span>Из буфера</span>
            </button>
          </div>

          <textarea
            id={quickPasteTextareaId}
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            value={quickPasteText}
            onChange={(e) => setQuickPasteText(e.target.value)}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={
              "ocsp.digicert.com\n*.sberbank.ru\nhttps://api.partner.io/v1 # [Partner] Внешний шлюз"
            }
            className="hosts-list-textarea rounded-md border border-strong bg-canvas p-3 font-mono text-xs leading-relaxed text-fg placeholder:text-subtle focus:border-teal-500 focus:outline-none"
          />
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>
              Пустые строки и комментарии{" "}
              <code className="font-mono">#</code> /{" "}
              <code className="font-mono">//</code> игнорируются.
            </span>
            <span className="font-mono font-semibold text-teal-300 tabular-nums">
              Будет добавлено: {quickPastePreviewRules.length}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline pt-3">
          <button
            type="button"
            onClick={() => setQuickPasteOpen(false)}
            className="rounded border border-strong bg-canvas px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={quickPastePreviewRules.length === 0}
            className="inline-flex items-center gap-1.5 rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-45"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Добавить правила ({quickPastePreviewRules.length})</span>
          </button>
        </div>
      </form>
    </dialog>
    </>
  );
};

function placeholderForField(field: FilterField): string {
  switch (field) {
    case "processName":
      return "chrome.exe / node.exe / Postman";
    case "processPid":
      return "14280";
    case "status":
      return "200 / 401 / 500";
    case "bodySize":
      return "1MB / 500KB / 65536";
    case "durationMs":
      return "500 / 1.5s";
    case "method":
      return "GET / POST / OPTIONS";
    case "contentType":
      return "json / xml / image";
    case "host":
      return "api.stripe.com";
    case "path":
      return "/api/v1/";
    default:
      return "Значение или шаблон...";
  }
}

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge: number;
  tone?: "sky" | "teal" | "amber";
}> = ({ active, onClick, icon, label, badge, tone = "sky" }) => {
  const badgeClasses =
    tone === "teal"
      ? "bg-teal-500/20 text-teal-300"
      : tone === "amber"
        ? "bg-amber-500/20 text-amber-300"
        : "bg-sky-500/20 text-sky-400";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-sky-400 text-fg"
          : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge > 0 && (
        <span
          className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-bold tabular-nums ${badgeClasses}`}
        >
          {badge}
        </span>
      )}
    </button>
  );
};

const NoiseToggleCard: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  subtitle: string;
}> = ({ checked, onChange, title, subtitle }) => (
  <label
    className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
      checked
        ? "border-sky-500/50 bg-selected"
        : "border-hairline bg-canvas hover:bg-hover"
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="checkbox-native mt-0.5"
    />
    <div className="min-w-0">
      <span className="block text-xs font-semibold text-fg">{title}</span>
      <span className="block text-[11px] text-muted">{subtitle}</span>
    </div>
  </label>
);
