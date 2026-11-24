import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, RotateCcw } from "lucide-react";
import { HelpTooltip } from "../ui/HelpTooltip";
import {
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  UPSTREAM_TIMEOUT_LIMITS,
  type UpstreamTimeoutConfig,
} from "../../types/proxy";

export function parseStrictNonNegativeInt(raw: string): number | null {
  const clean = raw.trim();
  if (!/^\d+$/.test(clean)) return null;
  const num = Number(clean);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

function validateConnectTimeoutRaw(raw: string): string | null {
  const n = parseStrictNonNegativeInt(raw);
  if (
    n === null ||
    n < UPSTREAM_TIMEOUT_LIMITS.connectMin ||
    n > UPSTREAM_TIMEOUT_LIMITS.connectMax
  ) {
    return `Укажите целое число от ${UPSTREAM_TIMEOUT_LIMITS.connectMin} до ${UPSTREAM_TIMEOUT_LIMITS.connectMax} с.`;
  }
  return null;
}

function validateTtfbTimeoutRaw(raw: string): string | null {
  const n = parseStrictNonNegativeInt(raw);
  if (
    n === null ||
    (n !== 0 &&
      (n < UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin ||
        n > UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax))
  ) {
    return `Укажите 0 (Unlimited) или целое число от ${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin} до ${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax} с.`;
  }
  return null;
}

function validateComposerTimeoutRaw(raw: string): string | null {
  const n = parseStrictNonNegativeInt(raw);
  if (
    n === null ||
    (n !== 0 &&
      (n < UPSTREAM_TIMEOUT_LIMITS.composerMin ||
        n > UPSTREAM_TIMEOUT_LIMITS.composerMax))
  ) {
    return `Укажите 0 (Unlimited) или целое число от ${UPSTREAM_TIMEOUT_LIMITS.composerMin} до ${UPSTREAM_TIMEOUT_LIMITS.composerMax} с.`;
  }
  return null;
}

export const TTFB_TIMEOUT_PRESETS: ReadonlyArray<{
  label: string;
  value: number;
}> = [
  { label: "Unlimited (Recommended)", value: 0 },
  { label: "30 s", value: 30 },
  { label: "60 s", value: 60 },
  { label: "120 s", value: 120 },
  { label: "300 s", value: 300 },
];

export interface UpstreamTimeoutsSectionProps {
  baseId: string;
  upstreamTimeouts: UpstreamTimeoutConfig;
  onSetUpstreamTimeouts: (config: UpstreamTimeoutConfig) => Promise<void>;
}

export const UpstreamTimeoutsSection: React.FC<UpstreamTimeoutsSectionProps> = ({
  baseId,
  upstreamTimeouts,
  onSetUpstreamTimeouts,
}) => {
  const [connectDraft, setConnectDraft] = useState<string>(() =>
    String(upstreamTimeouts.connectTimeoutSec)
  );
  const [ttfbDraft, setTtfbDraft] = useState<string>(() =>
    String(upstreamTimeouts.responseHeaderTimeoutSec)
  );
  const [composerDraft, setComposerDraft] = useState<string>(() =>
    String(upstreamTimeouts.composerTimeoutSec)
  );
  const [customTtfbSelected, setCustomTtfbSelected] = useState<boolean>(() =>
    !TTFB_TIMEOUT_PRESETS.some(
      (p) => p.value === upstreamTimeouts.responseHeaderTimeoutSec
    )
  );
  const [timeoutTouched, setTimeoutTouched] = useState<{
    connect: boolean;
    ttfb: boolean;
    composer: boolean;
  }>({ connect: false, ttfb: false, composer: false });
  const [timeoutErrors, setTimeoutErrors] = useState<{
    connect?: string;
    ttfb?: string;
    composer?: string;
  }>({});
  const [timeoutSaveError, setTimeoutSaveError] = useState<string | null>(null);
  const [isSavingTimeouts, setIsSavingTimeouts] = useState(false);

  const connectInputRef = useRef<HTMLInputElement>(null);
  const ttfbInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setConnectDraft(String(upstreamTimeouts.connectTimeoutSec));
    setTtfbDraft(String(upstreamTimeouts.responseHeaderTimeoutSec));
    setComposerDraft(String(upstreamTimeouts.composerTimeoutSec));
    setCustomTtfbSelected(
      !TTFB_TIMEOUT_PRESETS.some(
        (p) => p.value === upstreamTimeouts.responseHeaderTimeoutSec
      )
    );
    setTimeoutTouched({ connect: false, ttfb: false, composer: false });
    setTimeoutErrors({});
    setTimeoutSaveError(null);
  }, [
    upstreamTimeouts.connectTimeoutSec,
    upstreamTimeouts.responseHeaderTimeoutSec,
    upstreamTimeouts.composerTimeoutSec,
  ]);

  const parsedTtfbForWarning = parseStrictNonNegativeInt(ttfbDraft);
  const showShortTtfbWarning =
    parsedTtfbForWarning !== null &&
    parsedTtfbForWarning >= 1 &&
    parsedTtfbForWarning < 30;

  const isDirtyTimeouts =
    connectDraft.trim() !== String(upstreamTimeouts.connectTimeoutSec) ||
    ttfbDraft.trim() !== String(upstreamTimeouts.responseHeaderTimeoutSec) ||
    composerDraft.trim() !== String(upstreamTimeouts.composerTimeoutSec);

  const handleTimeoutsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const connectErr = validateConnectTimeoutRaw(connectDraft);
    const ttfbErr = validateTtfbTimeoutRaw(ttfbDraft);
    const composerErr = validateComposerTimeoutRaw(composerDraft);

    setTimeoutTouched({ connect: true, ttfb: true, composer: true });
    const nextErrors: { connect?: string; ttfb?: string; composer?: string } =
      {};
    if (connectErr) nextErrors.connect = connectErr;
    if (ttfbErr) nextErrors.ttfb = ttfbErr;
    if (composerErr) nextErrors.composer = composerErr;
    setTimeoutErrors(nextErrors);
    setTimeoutSaveError(null);

    if (connectErr) {
      connectInputRef.current?.focus();
      return;
    }
    if (ttfbErr) {
      ttfbInputRef.current?.focus();
      return;
    }
    if (composerErr) {
      composerInputRef.current?.focus();
      return;
    }

    const payload: UpstreamTimeoutConfig = {
      connectTimeoutSec: Number(connectDraft.trim()),
      responseHeaderTimeoutSec: Number(ttfbDraft.trim()),
      composerTimeoutSec: Number(composerDraft.trim()),
    };

    setIsSavingTimeouts(true);
    try {
      await onSetUpstreamTimeouts(payload);
    } catch (err) {
      setTimeoutSaveError(
        err instanceof Error
          ? err.message
          : String(err ?? "Не удалось сохранить таймауты")
      );
    } finally {
      setIsSavingTimeouts(false);
    }
  };

  const handleResetDefaultTimeouts = async () => {
    setConnectDraft(String(DEFAULT_UPSTREAM_TIMEOUT_CONFIG.connectTimeoutSec));
    setTtfbDraft(
      String(DEFAULT_UPSTREAM_TIMEOUT_CONFIG.responseHeaderTimeoutSec)
    );
    setComposerDraft(String(DEFAULT_UPSTREAM_TIMEOUT_CONFIG.composerTimeoutSec));
    setCustomTtfbSelected(false);
    setTimeoutTouched({ connect: false, ttfb: false, composer: false });
    setTimeoutErrors({});
    setTimeoutSaveError(null);
    setIsSavingTimeouts(true);
    try {
      await onSetUpstreamTimeouts({ ...DEFAULT_UPSTREAM_TIMEOUT_CONFIG });
    } catch (err) {
      setTimeoutSaveError(
        err instanceof Error
          ? err.message
          : String(err ?? "Не удалось сбросить таймауты")
      );
    } finally {
      setIsSavingTimeouts(false);
    }
  };

  return (
    <section
      id="upstream-timeouts-section"
      aria-labelledby={`${baseId}-timeouts-heading`}
      className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          <h3
            id={`${baseId}-timeouts-heading`}
            className="text-xs font-semibold text-fg"
          >
            Upstream Timeouts (Connect / TTFB / Composer)
          </h3>
          <HelpTooltip
            label="Подробнее о разделённых Upstream Timeouts"
            title="Разделение таймаутов Connect и TTFB"
            content="Connect ограничивает DNS + TCP + Proxy + TLS handshake. TTFB (Response Headers) ограничивает ожидание ответа сервера; значение 0 (Unlimited) позволяет дождаться реального ответа или ошибки 500/502 от медленного API."
            example="15s Connect / 0 Unlimited TTFB / 120s Composer"
          />
        </div>
        <span className="font-mono text-[10px] text-muted">
          Применяются без перезапуска прокси
        </span>
      </div>

      <form
        noValidate
        onSubmit={(e) => void handleTimeoutsSubmit(e)}
        className="space-y-3"
      >
        <fieldset className="space-y-2">
          <legend className="text-[11px] font-medium text-muted">
            Пресеты ожидания заголовков ответа (Response Header / TTFB Timeout)
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {TTFB_TIMEOUT_PRESETS.map((preset) => {
              const parsedCurrent = parseStrictNonNegativeInt(ttfbDraft);
              const isSelected =
                !customTtfbSelected && parsedCurrent === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setCustomTtfbSelected(false);
                    setTtfbDraft(String(preset.value));
                    setTimeoutErrors((prev) => ({
                      ...prev,
                      ttfb: undefined,
                    }));
                  }}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    isSelected
                      ? "border-accent/60 bg-selected text-fg"
                      : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={customTtfbSelected}
              onClick={() => {
                setCustomTtfbSelected(true);
                window.requestAnimationFrame(() => {
                  ttfbInputRef.current?.focus();
                });
              }}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                customTtfbSelected
                  ? "border-accent/60 bg-selected text-fg"
                  : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
              }`}
            >
              Custom
            </button>
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={`${baseId}-connect-timeout`}
                className="text-[11px] font-medium text-fg"
              >
                Connect Timeout (s)
              </label>
              <HelpTooltip
                label="Подробнее о Connect Timeout"
                content="Максимальное время на DNS, TCP-рукопожатие, прохождение Upstream Proxy и TLS handshake. Если сервер не отвечает на уровне сокета, прокси вернёт диагностику."
                example="15 (сек)"
              />
            </div>
            <input
              ref={connectInputRef}
              id={`${baseId}-connect-timeout`}
              type="text"
              inputMode="numeric"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={connectDraft}
              aria-invalid={timeoutErrors.connect ? "true" : undefined}
              aria-describedby={
                timeoutErrors.connect
                  ? `${baseId}-connect-timeout-hint ${baseId}-connect-timeout-err`
                  : `${baseId}-connect-timeout-hint`
              }
              onChange={(e) => {
                const val = e.target.value;
                setConnectDraft(val);
                if (timeoutErrors.connect || timeoutTouched.connect) {
                  const nextErr = validateConnectTimeoutRaw(val);
                  setTimeoutErrors((prev) => ({
                    ...prev,
                    connect: nextErr ?? undefined,
                  }));
                }
              }}
              onBlur={(e) => {
                setTimeoutTouched((prev) => ({
                  ...prev,
                  connect: true,
                }));
                const err = validateConnectTimeoutRaw(e.currentTarget.value);
                setTimeoutErrors((prev) => ({
                  ...prev,
                  connect: err ?? undefined,
                }));
              }}
              className={`h-8 rounded-md border bg-surface px-2.5 font-mono text-xs text-fg tabular-nums focus:outline-none ${
                timeoutErrors.connect
                  ? "border-status5xx-fg focus:border-status5xx-fg"
                  : "border-strong focus:border-accent"
              }`}
            />
            <p
              id={`${baseId}-connect-timeout-hint`}
              className="text-[10px] text-muted"
            >
              DNS + TCP + Proxy + TLS ({UPSTREAM_TIMEOUT_LIMITS.connectMin}–
              {UPSTREAM_TIMEOUT_LIMITS.connectMax} s)
            </p>
            {timeoutErrors.connect && (
              <p
                id={`${baseId}-connect-timeout-err`}
                role="alert"
                className="text-[10px] font-medium text-status5xx-fg"
              >
                {timeoutErrors.connect}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={`${baseId}-ttfb-timeout`}
                className="text-[11px] font-medium text-fg"
              >
                Response Headers / TTFB (s)
              </label>
              <HelpTooltip
                label="Подробнее о Response Headers / TTFB Timeout"
                content="Время ожидания первого байта заголовков ответа от upstream после отправки запроса. При 0 (Unlimited) прокси не обрывает долгие LLM/DB-запросы; при обрыве клиентом сессия фиксируется как 499."
                example="0 = Unlimited (рекомендуется)"
              />
            </div>
            <input
              ref={ttfbInputRef}
              id={`${baseId}-ttfb-timeout`}
              type="text"
              inputMode="numeric"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={ttfbDraft}
              aria-invalid={timeoutErrors.ttfb ? "true" : undefined}
              aria-describedby={
                timeoutErrors.ttfb
                  ? `${baseId}-ttfb-timeout-hint ${baseId}-ttfb-timeout-err`
                  : `${baseId}-ttfb-timeout-hint`
              }
              onChange={(e) => {
                const val = e.target.value;
                setTtfbDraft(val);
                const parsedVal = parseStrictNonNegativeInt(val);
                setCustomTtfbSelected(
                  parsedVal === null ||
                    !TTFB_TIMEOUT_PRESETS.some((p) => p.value === parsedVal)
                );
                if (timeoutErrors.ttfb || timeoutTouched.ttfb) {
                  const nextErr = validateTtfbTimeoutRaw(val);
                  setTimeoutErrors((prev) => ({
                    ...prev,
                    ttfb: nextErr ?? undefined,
                  }));
                }
              }}
              onBlur={(e) => {
                setTimeoutTouched((prev) => ({
                  ...prev,
                  ttfb: true,
                }));
                const err = validateTtfbTimeoutRaw(e.currentTarget.value);
                setTimeoutErrors((prev) => ({
                  ...prev,
                  ttfb: err ?? undefined,
                }));
              }}
              className={`h-8 rounded-md border bg-surface px-2.5 font-mono text-xs text-fg tabular-nums focus:outline-none ${
                timeoutErrors.ttfb
                  ? "border-status5xx-fg focus:border-status5xx-fg"
                  : "border-strong focus:border-accent"
              }`}
            />
            <p
              id={`${baseId}-ttfb-timeout-hint`}
              className="text-[10px] text-muted"
            >
              0 = Unlimited, или {UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin}–
              {UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax} s
            </p>
            {timeoutErrors.ttfb && (
              <p
                id={`${baseId}-ttfb-timeout-err`}
                role="alert"
                className="text-[10px] font-medium text-status5xx-fg"
              >
                {timeoutErrors.ttfb}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={`${baseId}-composer-timeout`}
                className="text-[11px] font-medium text-fg"
              >
                Composer / Replay Timeout (s)
              </label>
              <HelpTooltip
                label="Подробнее о Composer Timeout"
                content="Отдельный лимит времени для запросов, отправленных вручную из Request Composer или командой Replay (R). В самом Composer также есть кнопка отмены Cancel."
                example="120 (сек)"
              />
            </div>
            <input
              ref={composerInputRef}
              id={`${baseId}-composer-timeout`}
              type="text"
              inputMode="numeric"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              value={composerDraft}
              aria-invalid={timeoutErrors.composer ? "true" : undefined}
              aria-describedby={
                timeoutErrors.composer
                  ? `${baseId}-composer-timeout-hint ${baseId}-composer-timeout-err`
                  : `${baseId}-composer-timeout-hint`
              }
              onChange={(e) => {
                const val = e.target.value;
                setComposerDraft(val);
                if (timeoutErrors.composer || timeoutTouched.composer) {
                  const nextErr = validateComposerTimeoutRaw(val);
                  setTimeoutErrors((prev) => ({
                    ...prev,
                    composer: nextErr ?? undefined,
                  }));
                }
              }}
              onBlur={(e) => {
                setTimeoutTouched((prev) => ({
                  ...prev,
                  composer: true,
                }));
                const err = validateComposerTimeoutRaw(e.currentTarget.value);
                setTimeoutErrors((prev) => ({
                  ...prev,
                  composer: err ?? undefined,
                }));
              }}
              className={`h-8 rounded-md border bg-surface px-2.5 font-mono text-xs text-fg tabular-nums focus:outline-none ${
                timeoutErrors.composer
                  ? "border-status5xx-fg focus:border-status5xx-fg"
                  : "border-strong focus:border-accent"
              }`}
            />
            <p
              id={`${baseId}-composer-timeout-hint`}
              className="text-[10px] text-muted"
            >
              0 = Unlimited, или {UPSTREAM_TIMEOUT_LIMITS.composerMin}–
              {UPSTREAM_TIMEOUT_LIMITS.composerMax} s
            </p>
            {timeoutErrors.composer && (
              <p
                id={`${baseId}-composer-timeout-err`}
                role="alert"
                className="text-[10px] font-medium text-status5xx-fg"
              >
                {timeoutErrors.composer}
              </p>
            )}
          </div>
        </div>

        {showShortTtfbWarning && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-status4xx-fg/40 bg-status4xx-bg px-2.5 py-2 text-[11px] text-status4xx-fg"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Короткий TTFB-таймаут (&lt; 30 s) может прервать медленный
              API-сервер до получения его реального ответа или ошибки 500/502 и
              заменить ответ синтетическим прокси-кодом{" "}
              <code className="font-mono font-semibold">504</code>.
            </span>
          </div>
        )}

        {timeoutSaveError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-status5xx-fg/40 bg-status5xx-bg px-2.5 py-2 text-[11px] text-status5xx-fg"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{timeoutSaveError}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="submit"
            disabled={isSavingTimeouts}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-selected px-3 text-xs font-medium text-fg transition-colors hover:brightness-110 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span>
              {isSavingTimeouts
                ? "Сохранение..."
                : isDirtyTimeouts
                  ? "Применить таймауты"
                  : "Сохранить таймауты"}
            </span>
          </button>

          <button
            type="button"
            disabled={isSavingTimeouts}
            onClick={() => void handleResetDefaultTimeouts()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-[11px] font-medium text-muted transition-colors hover:border-strong hover:text-fg disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            <span>По умолчанию (15s / Unlimited / 120s)</span>
          </button>
        </div>
      </form>
    </section>
  );
};
