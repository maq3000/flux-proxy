import React, { useId, useState } from "react";
import Editor from "@monaco-editor/react";
import { Clock, Plus, Save, Sliders, Trash2 } from "lucide-react";
import type {
  AutoResponderRule,
  RuleActionType,
  RuleMatchTarget,
} from "../types/proxy";

interface AutoResponderPanelProps {
  enabled?: boolean;
  onToggleEnabled?: (enabled: boolean) => Promise<void> | void;
  rules: AutoResponderRule[];
  resolvedTheme: "dark" | "light";
  onUpsertRule: (rule: AutoResponderRule) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
}

export const AutoResponderPanel: React.FC<AutoResponderPanelProps> = ({
  enabled = true,
  onToggleEnabled,
  rules,
  resolvedTheme,
  onUpsertRule,
  onDeleteRule,
}) => {
  const masterToggleId = useId();
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(
    rules[0]?.id ?? null
  );

  const activeRule = rules.find((r) => r.id === selectedRuleId) ?? null;
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  const handleCreateRule = async () => {
    const newRule: AutoResponderRule = {
      id: `rule-${Date.now()}`,
      enabled: true,
      name: "New Endpoint Mock Rule",
      matchTarget: "urlContains",
      pattern: "/api/v1/mock",
      methodFilter: "ANY",
      headerName: null,
      action: "mockResponse",
      statusCode: 200,
      latencyMs: 120,
      responseHeaders: [
        { name: "Content-Type", value: "application/json; charset=utf-8" },
        { name: "X-Mocked-By", value: "FluxProxy" },
      ],
      responseBody: JSON.stringify(
        { status: "ok", mocked: true, timestamp: new Date().toISOString() },
        null,
        2
      ),
    };
    await onUpsertRule(newRule);
    setSelectedRuleId(newRule.id);
  };

  return (
    <div className="pane-contain flex h-full w-full overflow-hidden bg-canvas">
      {/* Left List of Rules */}
      <div className="flex w-80 shrink-0 flex-col border-r border-hairline bg-surface">
        <div className="flex h-10 items-center justify-between border-b border-hairline px-3">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-semibold text-fg">
              AutoResponder Rules
            </span>
          </div>
          <div className="flex items-center gap-2">
            {onToggleEnabled && (
              <label
                htmlFor={masterToggleId}
                className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] font-medium text-fg"
              >
                <input
                  id={masterToggleId}
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => void onToggleEnabled(e.target.checked)}
                  className="checkbox-native"
                />
                <span>{enabled ? "On" : "Off"}</span>
              </label>
            )}
            <button
              type="button"
              onClick={() => void handleCreateRule()}
              className="inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Rule</span>
            </button>
          </div>
        </div>

        {!enabled && (
          <div className="flex items-center justify-between gap-2 border-b border-hairline bg-status4xx-bg px-3 py-1.5 text-[11px] text-status4xx-fg">
            <span>AutoResponder отключён глобально</span>
            {onToggleEnabled && (
              <button
                type="button"
                onClick={() => void onToggleEnabled(true)}
                className="shrink-0 rounded border border-status4xx-fg/40 px-1.5 py-0.5 text-[10px] font-semibold hover:brightness-110"
              >
                Включить
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {rules.length === 0 ? (
            <p className="p-4 text-center text-xs text-subtle">
              No interception rules configured.
            </p>
          ) : (
            rules.map((r) => (
              <div
                key={r.id}
                onClick={() => setSelectedRuleId(r.id)}
                className={`flex cursor-pointer flex-col gap-1 rounded-md border p-2.5 transition-colors ${
                  r.id === selectedRuleId
                    ? "border-sky-500/50 bg-selected"
                    : "border-hairline bg-canvas hover:bg-hover"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-fg">
                    {r.name}
                  </span>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      void onUpsertRule({ ...r, enabled: e.target.checked })
                    }
                    title="Enable/Disable Rule"
                  />
                </div>
                <div className="flex items-center justify-between font-mono text-[11px] text-muted">
                  <span className="truncate">{r.pattern}</span>
                  <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-amber-400">
                    {r.action === "delayOnly"
                      ? `+${r.latencyMs}ms`
                      : `${r.statusCode} • +${r.latencyMs}ms`}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Rule Inspector & Monaco Mock Payload Editor */}
      {activeRule ? (
        <RuleDetailForm
          key={activeRule.id}
          rule={activeRule}
          monacoTheme={monacoTheme}
          onSave={onUpsertRule}
          onDelete={async (id) => {
            await onDeleteRule(id);
            setSelectedRuleId(rules.find((x) => x.id !== id)?.id ?? null);
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">
          Select or create an AutoResponder rule to mock responses, override status codes, or inject artificial latency.
        </div>
      )}
    </div>
  );
};

const RuleDetailForm: React.FC<{
  rule: AutoResponderRule;
  monacoTheme: "vs-dark" | "light";
  onSave: (rule: AutoResponderRule) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}> = ({ rule, monacoTheme, onSave, onDelete }) => {
  const [draft, setDraft] = useState<AutoResponderRule>(rule);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline px-4">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          aria-label="Rule Name"
          className="w-96 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-fg focus:border-strong focus:bg-canvas focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onDelete(draft.id)}
            className="inline-flex items-center gap-1 rounded border border-hairline px-2.5 py-1 text-xs text-rose-400 hover:bg-rose-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete</span>
          </button>
          <button
            type="button"
            onClick={() => void onSave(draft)}
            className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            <Save className="h-3.5 w-3.5" />
            <span>Apply Rule</span>
          </button>
        </div>
      </div>

      {/* Match Criteria & Action Controls */}
      <div className="grid grid-cols-1 gap-3 border-b border-hairline bg-elevated/40 p-4 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            Match Target
          </label>
          <select
            value={draft.matchTarget}
            onChange={(e) =>
              setDraft({
                ...draft,
                matchTarget: e.target.value as RuleMatchTarget,
              })
            }
            className="h-8 w-full rounded border border-strong bg-canvas px-2 text-xs text-fg"
          >
            <option value="urlContains">URL Contains</option>
            <option value="urlRegex">URL Regular Expression</option>
            <option value="headerMatch">Request Header Contains</option>
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-[11px] font-medium text-muted">
            Match Pattern {draft.matchTarget === "urlRegex" ? "(RegExp)" : ""}
          </label>
          <input
            type="text"
            value={draft.pattern}
            onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            HTTP Method Filter
          </label>
          <select
            value={draft.methodFilter ?? "ANY"}
            onChange={(e) =>
              setDraft({ ...draft, methodFilter: e.target.value })
            }
            className="h-8 w-full rounded border border-strong bg-canvas px-2 font-mono text-xs text-fg"
          >
            <option value="ANY">ANY Method</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>

        {draft.matchTarget === "headerMatch" && (
          <div className="md:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-muted">
              Header Name (leave blank to scan any header)
            </label>
            <input
              type="text"
              value={draft.headerName ?? ""}
              placeholder="e.g. X-Env or Authorization"
              onChange={(e) =>
                setDraft({ ...draft, headerName: e.target.value })
              }
              className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            Rule Action
          </label>
          <select
            value={draft.action}
            onChange={(e) =>
              setDraft({ ...draft, action: e.target.value as RuleActionType })
            }
            className="h-8 w-full rounded border border-strong bg-canvas px-2 text-xs text-fg"
          >
            <option value="mockResponse">Mock Local Response</option>
            <option value="overrideStatus">Forward & Override Status</option>
            <option value="delayOnly">Inject Latency Only</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted">
            HTTP Status Code
          </label>
          <input
            type="number"
            min={100}
            max={599}
            disabled={draft.action === "delayOnly"}
            value={draft.statusCode}
            onChange={(e) =>
              setDraft({
                ...draft,
                statusCode: Number(e.target.value) || 200,
              })
            }
            className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg disabled:opacity-50"
          />
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3 text-amber-400" />
              Artificial Latency Simulation
            </span>
            <span className="font-mono text-amber-400 tabular-nums">
              {draft.latencyMs} ms
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={5000}
            step={25}
            value={draft.latencyMs}
            onChange={(e) =>
              setDraft({ ...draft, latencyMs: Number(e.target.value) })
            }
            className="h-8 w-full cursor-pointer"
          />
        </div>
      </div>

      {/* Mocked Payload Body Editor */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-7 items-center justify-between border-b border-hairline px-4 text-[11px] text-muted">
          <span>Mock Response Payload (Monaco Editor)</span>
          <span className="font-mono">Content-Type: application/json</span>
        </div>
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            language="json"
            theme={monacoTheme}
            value={draft.responseBody}
            onChange={(v) => setDraft({ ...draft, responseBody: v ?? "" })}
            options={{
              readOnly: draft.action !== "mockResponse",
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </div>
    </div>
  );
};
