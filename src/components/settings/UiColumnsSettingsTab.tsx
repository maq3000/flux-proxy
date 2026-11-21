import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Palette, RotateCcw } from "lucide-react";
import type { ThemePreference } from "../../hooks/useTheme";
import {
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
} from "../../hooks/useUiPreferences";
import {
  normalizeHexColor,
  resolveEffectiveThemeTokens,
  STATUS_FG_TO_BG_MAP,
  THEME_PRESETS,
  THEME_PRESETS_BY_ID,
  THEME_TOKEN_GROUPS,
  type CustomColorOverrides,
  type StatusFgTokenKey,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../../lib/themePresets";
import type {
  ColumnId,
  InspectorDockPosition,
  InspectorSplitDirection,
  ToolbarGroupId,
} from "../../types/proxy";

export interface UiColumnsSettingsTabProps {
  baseId: string;
  themePreference: ThemePreference;
  onSetTheme: (theme: ThemePreference) => void;
  themePreset?: ThemePresetId;
  customColorOverrides?: CustomColorOverrides;
  effectiveThemeTokens?: Record<ThemeTokenKey, string>;
  onSetThemePreset?: (presetId: ThemePresetId) => void;
  onSetCustomColorOverride?: (token: ThemeTokenKey, hexColor: string) => void;
  onResetCustomColorOverride?: (token: ThemeTokenKey) => void;
  onResetCustomColorOverrides?: () => void;
  compactToolbar: boolean;
  onSetCompactToolbar: (compact: boolean) => void;
  sidebarCollapsed: boolean;
  onSetSidebarCollapsed: (collapsed: boolean) => void;
  inspectorCollapsed: boolean;
  onSetInspectorCollapsed: (collapsed: boolean) => void;
  inspectorPosition: InspectorDockPosition;
  onSetInspectorPosition: (pos: InspectorDockPosition) => void;
  inspectorSplitDirection: InspectorSplitDirection;
  onSetInspectorSplitDirection: (dir: InspectorSplitDirection) => void;
  onResetPanelLayout: () => void;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  onToggleToolbarGroup: (groupId: ToolbarGroupId) => void;
  onResetToolbarGroups: () => void;
  visibleColumns: Record<ColumnId, boolean>;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  columnWidths: Record<ColumnId, number>;
  onSetColumnWidth: (colId: ColumnId, width: number) => void;
  onResetColumns: () => void;
}

export const UiColumnsSettingsTab: React.FC<UiColumnsSettingsTabProps> = ({
  baseId,
  themePreference,
  onSetTheme,
  themePreset: themePresetProp,
  customColorOverrides: customColorOverridesProp,
  effectiveThemeTokens: effectiveThemeTokensProp,
  onSetThemePreset,
  onSetCustomColorOverride,
  onResetCustomColorOverride,
  onResetCustomColorOverrides,
  compactToolbar,
  onSetCompactToolbar,
  sidebarCollapsed,
  onSetSidebarCollapsed,
  inspectorCollapsed,
  onSetInspectorCollapsed,
  inspectorPosition,
  onSetInspectorPosition,
  inspectorSplitDirection,
  onSetInspectorSplitDirection,
  onResetPanelLayout,
  toolbarGroups,
  onToggleToolbarGroup,
  onResetToolbarGroups,
  visibleColumns,
  onToggleColumnVisibility,
  columnWidths,
  onSetColumnWidth,
  onResetColumns,
}) => {
  const [paletteEditorOpen, setPaletteEditorOpen] = useState(false);
  const [hexDrafts, setHexDrafts] = useState<Partial<Record<ThemeTokenKey, string>>>({});
  const [widthDrafts, setWidthDrafts] = useState<Record<ColumnId, string>>(() => {
    const init = {} as Record<ColumnId, string>;
    for (const col of TRAFFIC_COLUMNS) {
      init[col.id] = String(columnWidths[col.id] ?? col.defaultWidth);
    }
    return init;
  });

  useEffect(() => {
    const next = {} as Record<ColumnId, string>;
    for (const col of TRAFFIC_COLUMNS) {
      next[col.id] = String(columnWidths[col.id] ?? col.defaultWidth);
    }
    setWidthDrafts(next);
  }, [columnWidths]);

  const activeThemePreset: ThemePresetId =
    themePresetProp ?? (themePreference === "light" ? "default-light" : "default-dark");
  const customOverrides = useMemo<CustomColorOverrides>(
    () => customColorOverridesProp ?? {},
    [customColorOverridesProp]
  );
  const resolvedFallbackPalette = useMemo(
    () =>
      resolveEffectiveThemeTokens(
        activeThemePreset,
        customOverrides,
        themePreference !== "light",
        themePreference
      ),
    [activeThemePreset, customOverrides, themePreference]
  );
  const effectiveTokens = effectiveThemeTokensProp ?? resolvedFallbackPalette.tokens;
  const effectiveStatusBgTokens = resolvedFallbackPalette.statusBgTokens;
  const overriddenTokensCount = Object.keys(customOverrides).length;

  useEffect(() => {
    setHexDrafts({});
  }, [activeThemePreset, customOverrides]);

  const commitHexDraft = (tokenKey: ThemeTokenKey) => {
    const draft = hexDrafts[tokenKey];
    if (draft === undefined) return;
    const normalized = normalizeHexColor(draft);
    if (normalized) {
      onSetCustomColorOverride?.(tokenKey, normalized);
    }
    setHexDrafts((prev) => {
      if (!(tokenKey in prev)) return prev;
      const next = { ...prev };
      delete next[tokenKey];
      return next;
    });
  };

  const commitColumnWidth = (colId: ColumnId) => {
    const min = COLUMN_MIN_WIDTHS[colId] ?? 48;
    const raw = Number(widthDrafts[colId]);
    if (!Number.isFinite(raw) || raw <= 0) {
      setWidthDrafts((prev) => ({
        ...prev,
        [colId]: String(columnWidths[colId] ?? DEFAULT_COLUMN_WIDTHS[colId]),
      }));
      return;
    }
    const clamped = Math.min(1600, Math.max(min, Math.round(raw)));
    onSetColumnWidth(colId, clamped);
    setWidthDrafts((prev) => ({ ...prev, [colId]: String(clamped) }));
  };

  const visibleColsCount = TRAFFIC_COLUMNS.filter((c) => visibleColumns[c.id]).length;
  const visibleGroupsCount = TOOLBAR_GROUP_DEFINITIONS.filter((g) => toolbarGroups[g.id]).length;

  return (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <Palette className="h-3.5 w-3.5 text-accent" />
                        <h3 className="text-xs font-semibold text-fg">
                          Галерея цветовых тем-пресетов
                        </h3>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted">
                        Мгновенно переключает интерфейс, HTTP-статусы и подсветку Monaco Editor.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <div
                        role="group"
                        aria-label="Базовая схема"
                        className="inline-flex rounded-md border border-hairline bg-surface p-0.5"
                      >
                        {(
                          [
                            { id: "dark", label: "Dark" },
                            { id: "light", label: "Light" },
                            { id: "system", label: "System" },
                          ] as const
                        ).map((mode) => (
                          <button
                            key={mode.id}
                            type="button"
                            onClick={() => onSetTheme(mode.id)}
                            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                              themePreference === mode.id
                                ? "bg-selected text-fg"
                                : "text-muted hover:text-fg"
                            }`}
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        disabled={overriddenTokensCount === 0}
                        onClick={() => {
                          setHexDrafts({});
                          onResetCustomColorOverrides?.();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>
                          Сбросить цвета
                          {overriddenTokensCount > 0
                            ? ` (${overriddenTokensCount})`
                            : ""}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* 8 Theme Preset Cards Grid */}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {THEME_PRESETS.map((preset) => {
                      const isSelected = activeThemePreset === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            setHexDrafts({});
                            if (onSetThemePreset) {
                              onSetThemePreset(preset.id);
                            } else {
                              onSetTheme(preset.baseScheme);
                            }
                          }}
                          className={`group flex flex-col justify-between rounded-lg border p-2.5 text-left transition-colors ${
                            isSelected
                              ? "border-accent bg-selected ring-1 ring-accent/35"
                              : "border-hairline bg-surface hover:border-strong hover:bg-hover"
                          }`}
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-start justify-between gap-1.5">
                              <span className="truncate text-xs font-semibold text-fg">
                                {preset.name}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <span
                                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase ${
                                    preset.baseScheme === "dark"
                                      ? "border border-strong/70 bg-elevated text-muted"
                                      : "border border-strong/70 bg-elevated text-fg"
                                  }`}
                                >
                                  {preset.baseScheme === "dark" ? "Dark" : "Light"}
                                </span>
                                {isSelected && (
                                  <Check className="h-3.5 w-3.5 text-accent" />
                                )}
                              </div>
                            </div>

                            <p className="line-clamp-2 text-[10px] leading-snug text-muted">
                              {preset.description}
                            </p>
                          </div>

                          <div className="mt-2.5 flex items-center gap-1.5 border-t border-hairline/70 pt-2">
                            {preset.swatches.map((hex, sIdx) => (
                              <span
                                key={`${preset.id}-swatch-${sIdx}`}
                                title={hex}
                                className="h-4 flex-1 rounded-sm border border-strong/50"
                                style={{ backgroundColor: hex }}
                              />
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Expandable Detailed Palette Editor */}
                  <div className="rounded-lg border border-hairline bg-surface">
                    <button
                      type="button"
                      aria-expanded={paletteEditorOpen}
                      aria-controls={`${baseId}-palette-editor`}
                      onClick={() => setPaletteEditorOpen((v) => !v)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
                    >
                      <div className="flex items-center gap-2">
                        {paletteEditorOpen ? (
                          <ChevronDown className="h-3.5 w-3.5 text-accent" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted" />
                        )}
                        <span className="text-xs font-semibold text-fg">
                          Детальная настройка палитры
                        </span>
                        <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted">
                          {THEME_PRESETS_BY_ID[activeThemePreset]?.name ??
                            activeThemePreset}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-muted">
                        {overriddenTokensCount > 0
                          ? `Переопределено: ${overriddenTokensCount}`
                          : "По пресету"}
                      </span>
                    </button>

                    {paletteEditorOpen && (
                      <div
                        id={`${baseId}-palette-editor`}
                        className="space-y-3 border-t border-hairline p-3"
                      >
                        {/* Live Preview Strip */}
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-canvas p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                            <span
                              className="rounded px-2 py-0.5 font-semibold"
                              style={{
                                backgroundColor:
                                  effectiveTokens["--bg-selected"],
                                color: effectiveTokens["--text-primary"],
                                border: `1px solid ${effectiveTokens["--accent-primary"]}`,
                              }}
                            >
                              Selected Row
                            </span>
                            {(
                              [
                                { key: "--status-2xx-fg", text: "200 OK" },
                                { key: "--status-3xx-fg", text: "304" },
                                { key: "--status-4xx-fg", text: "404" },
                                { key: "--status-5xx-fg", text: "502" },
                                { key: "--status-ws-fg", text: "WS 101" },
                              ] as const
                            ).map((badge) => (
                              <span
                                key={badge.key}
                                className="rounded px-1.5 py-0.5 font-semibold"
                                style={{
                                  color: effectiveTokens[badge.key],
                                  backgroundColor:
                                    effectiveStatusBgTokens[
                                      STATUS_FG_TO_BG_MAP[badge.key]
                                    ],
                                }}
                              >
                                {badge.text}
                              </span>
                            ))}
                          </div>

                          <button
                            type="button"
                            disabled={overriddenTokensCount === 0}
                            onClick={() => {
                              setHexDrafts({});
                              onResetCustomColorOverrides?.();
                            }}
                            className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <RotateCcw className="h-3 w-3 text-accent" />
                            <span>Сбросить кастомные цвета к пресету</span>
                          </button>
                        </div>

                        {/* Token Groups */}
                        <div className="space-y-3">
                          {THEME_TOKEN_GROUPS.map((group) => (
                            <div key={group.id} className="space-y-2">
                              <div>
                                <div className="text-[11px] font-semibold text-fg">
                                  {group.title}
                                </div>
                                <div className="text-[10px] text-muted">
                                  {group.description}
                                </div>
                              </div>

                              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                {group.fields.map((field) => {
                                  const colorValue = effectiveTokens[field.key];
                                  const draftVal = hexDrafts[field.key];
                                  const displayValue = draftVal ?? colorValue;
                                  const isOverridden = Boolean(
                                    customOverrides[field.key]
                                  );
                                  const colorInputId = `${baseId}-color-${field.key}`;
                                  const hexInputId = `${baseId}-hex-${field.key}`;
                                  const statusBgKey =
                                    field.key in STATUS_FG_TO_BG_MAP
                                      ? STATUS_FG_TO_BG_MAP[
                                          field.key as StatusFgTokenKey
                                        ]
                                      : null;

                                  return (
                                    <div
                                      key={field.key}
                                      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
                                        isOverridden
                                          ? "border-accent/45 bg-selected/45"
                                          : "border-hairline bg-canvas"
                                      }`}
                                    >
                                      <div className="flex min-w-0 items-center gap-2">
                                        <label
                                          htmlFor={colorInputId}
                                          className="sr-only"
                                        >
                                          Цвет {field.label} ({field.key})
                                        </label>
                                        <input
                                          id={colorInputId}
                                          type="color"
                                          value={colorValue}
                                          onChange={(e) => {
                                            setHexDrafts((prev) => {
                                              if (!(field.key in prev))
                                                return prev;
                                              const next = { ...prev };
                                              delete next[field.key];
                                              return next;
                                            });
                                            onSetCustomColorOverride?.(
                                              field.key,
                                              e.target.value
                                            );
                                          }}
                                          className="h-6 w-7 shrink-0 cursor-pointer rounded border border-strong bg-transparent p-0"
                                        />
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-1.5">
                                            <span className="truncate text-[11px] font-medium text-fg">
                                              {field.label}
                                            </span>
                                            {field.previewBadge && statusBgKey && (
                                              <span
                                                className="rounded px-1 py-0.5 font-mono text-[9px] font-semibold"
                                                style={{
                                                  color: colorValue,
                                                  backgroundColor:
                                                    effectiveStatusBgTokens[
                                                      statusBgKey
                                                    ],
                                                }}
                                              >
                                                {field.previewBadge}
                                              </span>
                                            )}
                                          </div>
                                          <div className="truncate font-mono text-[10px] text-subtle">
                                            {field.key}
                                          </div>
                                        </div>
                                      </div>

                                      <div className="flex shrink-0 items-center gap-1">
                                        <label
                                          htmlFor={hexInputId}
                                          className="sr-only"
                                        >
                                          HEX-значение {field.key}
                                        </label>
                                        <input
                                          id={hexInputId}
                                          type="text"
                                          value={displayValue}
                                          spellCheck={false}
                                          autoCapitalize="off"
                                          autoCorrect="off"
                                          maxLength={7}
                                          onChange={(e) => {
                                            const raw = e.target.value;
                                            setHexDrafts((prev) => ({
                                              ...prev,
                                              [field.key]: raw,
                                            }));
                                            if (
                                              /^#?[0-9a-fA-F]{6}$/.test(
                                                raw.trim()
                                              )
                                            ) {
                                              const normalized =
                                                normalizeHexColor(raw);
                                              if (normalized) {
                                                onSetCustomColorOverride?.(
                                                  field.key,
                                                  normalized
                                                );
                                              }
                                            }
                                          }}
                                          onBlur={() =>
                                            commitHexDraft(field.key)
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                              e.preventDefault();
                                              commitHexDraft(field.key);
                                            } else if (e.key === "Escape") {
                                              e.preventDefault();
                                              setHexDrafts((prev) => {
                                                if (!(field.key in prev))
                                                  return prev;
                                                const next = { ...prev };
                                                delete next[field.key];
                                                return next;
                                              });
                                            }
                                          }}
                                          className="h-6 w-[74px] rounded border border-strong bg-surface px-1.5 font-mono text-[11px] text-fg focus:border-accent focus:outline-none"
                                        />
                                        <button
                                          type="button"
                                          disabled={!isOverridden}
                                          title={`Сбросить ${field.key} к пресету`}
                                          aria-label={`Сбросить ${field.key}`}
                                          onClick={() => {
                                            setHexDrafts((prev) => {
                                              if (!(field.key in prev))
                                                return prev;
                                              const next = { ...prev };
                                              delete next[field.key];
                                              return next;
                                            });
                                            onResetCustomColorOverride?.(
                                              field.key
                                            );
                                          }}
                                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-hairline bg-surface text-muted hover:border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                                        >
                                          <RotateCcw className="h-3 w-3" />
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-fg">
                      Компоновка рабочей области
                    </h3>
                    <button
                      type="button"
                      onClick={onResetPanelLayout}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Reset Panel Layout to Default</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <label
                      htmlFor={`${baseId}-compact-toolbar`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-compact-toolbar`}
                        type="checkbox"
                        checked={compactToolbar}
                        onChange={(e) => onSetCompactToolbar(e.target.checked)}
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Compact Toolbar
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-sidebar-collapsed`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-sidebar-collapsed`}
                        type="checkbox"
                        checked={sidebarCollapsed}
                        onChange={(e) =>
                          onSetSidebarCollapsed(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Collapse Sidebar
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-inspector-collapsed`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-inspector-collapsed`}
                        type="checkbox"
                        checked={inspectorCollapsed}
                        onChange={(e) =>
                          onSetInspectorCollapsed(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Collapse Inspector
                      </span>
                    </label>
                  </div>

                  <fieldset className="space-y-2 border-t border-hairline pt-2.5">
                    <legend className="text-[11px] font-medium text-muted">
                      Позиция панели Session Inspector
                    </legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {(
                        [
                          {
                            value: "bottom",
                            label: "Снизу (Bottom Split)",
                          },
                          {
                            value: "right",
                            label: "Справа (Right Split)",
                          },
                        ] as const
                      ).map((pos) => {
                        const radioId = `${baseId}-dock-${pos.value}`;
                        const checked = inspectorPosition === pos.value;
                        return (
                          <label
                            key={pos.value}
                            htmlFor={radioId}
                            className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 transition-colors ${
                              checked
                                ? "border-accent/50 bg-selected"
                                : "border-hairline bg-surface hover:bg-hover"
                            }`}
                          >
                            <input
                              id={radioId}
                              type="radio"
                              name={`${baseId}-dock-pos`}
                              value={pos.value}
                              checked={checked}
                              onChange={() => onSetInspectorPosition(pos.value)}
                              className="cursor-pointer accent-[var(--accent-primary)]"
                            />
                            <span className="font-medium text-fg">
                              {pos.label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  <fieldset className="space-y-2 border-t border-hairline pt-2.5">
                    <legend className="text-[11px] font-medium text-muted">
                      Ориентация сплиттера внутри Session Inspector (Request / Response)
                    </legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {(
                        [
                          {
                            value: "auto",
                            label: "Auto",
                            desc:
                              inspectorPosition === "bottom"
                                ? "Сейчас: Horizontal"
                                : "Сейчас: Vertical",
                          },
                          {
                            value: "horizontal",
                            label: "Horizontal",
                            desc: "Request слева, Response справа",
                          },
                          {
                            value: "vertical",
                            label: "Vertical",
                            desc: "Request сверху, Response снизу",
                          },
                        ] as const
                      ).map((opt) => {
                        const radioId = `${baseId}-split-dir-${opt.value}`;
                        const checked = inspectorSplitDirection === opt.value;
                        return (
                          <label
                            key={opt.value}
                            htmlFor={radioId}
                            className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 transition-colors ${
                              checked
                                ? "border-accent/50 bg-selected"
                                : "border-hairline bg-surface hover:bg-hover"
                            }`}
                          >
                            <input
                              id={radioId}
                              type="radio"
                              name={`${baseId}-split-dir`}
                              value={opt.value}
                              checked={checked}
                              onChange={() =>
                                onSetInspectorSplitDirection(opt.value)
                              }
                              className="mt-0.5 cursor-pointer accent-[var(--accent-primary)]"
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-fg">
                                {opt.label}
                              </div>
                              <div className="text-[10px] text-muted">
                                {opt.desc}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Группы верхней панели инструментов ({visibleGroupsCount}/
                        {TOOLBAR_GROUP_DEFINITIONS.length})
                      </h3>
                      <p className="text-[11px] text-muted">
                        Скрытые группы остаются доступны через меню «⋯» и сохраняются в JSON-профиль.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onResetToolbarGroups}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Сбросить тулбар</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {TOOLBAR_GROUP_DEFINITIONS.map((grp) => {
                      const chkId = `${baseId}-tb-${grp.id}`;
                      return (
                        <label
                          key={grp.id}
                          htmlFor={chkId}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-surface p-2 hover:bg-hover"
                        >
                          <input
                            id={chkId}
                            type="checkbox"
                            checked={Boolean(toolbarGroups[grp.id])}
                            onChange={() => onToggleToolbarGroup(grp.id)}
                            className="checkbox-native mt-0.5"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-fg">
                              {grp.label}
                            </div>
                            <div className="truncate text-[10px] text-muted">
                              {grp.description}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Видимость и ширина колонок таблицы ({visibleColsCount}/
                        {TRAFFIC_COLUMNS.length})
                      </h3>
                      <p className="text-[11px] text-muted">
                        Настройте отображаемые столбцы и их точную ширину в пикселях.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onResetColumns}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Сбросить колонки</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {TRAFFIC_COLUMNS.map((col) => {
                      const visId = `${baseId}-col-vis-${col.id}`;
                      const widthId = `${baseId}-col-w-${col.id}`;
                      const isVis = Boolean(visibleColumns[col.id]);
                      const disableUncheck = isVis && visibleColsCount <= 1;
                      return (
                        <div
                          key={col.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <label
                            htmlFor={visId}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                          >
                            <input
                              id={visId}
                              type="checkbox"
                              checked={isVis}
                              disabled={disableUncheck}
                              onChange={() => onToggleColumnVisibility(col.id)}
                              className="checkbox-native"
                            />
                            <span className="truncate font-medium text-fg">
                              {col.label}
                            </span>
                            <span className="font-mono text-[10px] text-subtle">
                              ({col.id})
                            </span>
                          </label>

                          <div className="flex shrink-0 items-center gap-1">
                            <label htmlFor={widthId} className="sr-only">
                              Ширина колонки {col.label} в пикселях
                            </label>
                            <input
                              id={widthId}
                              type="number"
                              min={col.minWidth}
                              max={1600}
                              value={widthDrafts[col.id] ?? col.defaultWidth}
                              onChange={(e) =>
                                setWidthDrafts((prev) => ({
                                  ...prev,
                                  [col.id]: e.target.value,
                                }))
                              }
                              onBlur={() => commitColumnWidth(col.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitColumnWidth(col.id);
                                }
                              }}
                              className="h-6 w-16 rounded border border-strong bg-canvas px-1.5 text-right font-mono text-[11px] text-fg tabular-nums focus:border-accent focus:outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted">
                              px
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
  );
};
