/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the configured allow-list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const COMMAND = "fast";
const USAGE_COMMAND = "usage";
const FOOTER_COMMAND = "fast-footer";
const FLAG = "fast";
const CONFIG_BASENAME = "pi-better-openai.json";
const SERVICE_TIER = "priority";
const COMMAND_ARGS = ["on", "off", "status", "models"] as const;
const USAGE_COMMAND_ARGS = ["status", "refresh", "on", "off"] as const;
const FOOTER_MODES = ["replace", "status", "off"] as const;

const DEFAULT_SUPPORTED_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5"
] as const;

type FooterMode = typeof FOOTER_MODES[number];

type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};

type FooterConfig = {
  mode?: FooterMode;
};

interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  supportedModels?: string[];
  usage?: UsageConfig;
  footer?: FooterConfig;
}

interface SupportedModel {
  provider: string;
  id: string;
}

interface ResolvedConfig {
  configPath: string;
  persistState: boolean;
  active: boolean;
  supportedModels: SupportedModel[];
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
}

type UsageWindow = {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
};

type RateLimitBucket = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

type CodexUsageResponse = {
  rate_limit?: RateLimitBucket | null;
  additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

type UsageSnapshot = {
  fiveHourLeftPercent: number | null;
  sevenDayLeftPercent: number | null;
  fiveHourResetInSeconds: number | null;
  sevenDayResetInSeconds: number | null;
  isLimited: boolean;
};

const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true
};

const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = {
  mode: "replace"
};

const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  supportedModels: [...DEFAULT_SUPPORTED_MODELS],
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_DIR, "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPaths(cwd: string, home = homedir()) {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    global: join(home, ".pi", "agent", "extensions", CONFIG_BASENAME)
  };
}

function parseModelKey(value: string): SupportedModel | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  const provider = key.slice(0, slash).trim();
  const id = key.slice(slash + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

function normalizeModelKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => parseModelKey(entry))
    .filter((entry): entry is SupportedModel => entry !== undefined)
    .map((entry) => `${entry.provider}/${entry.id}`);
}

function parseModels(value: unknown): SupportedModel[] | undefined {
  const keys = normalizeModelKeys(value);
  if (keys === undefined) return undefined;
  return keys.map((key) => parseModelKey(key)).filter((entry): entry is SupportedModel => entry !== undefined);
}

function readConfig(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const config: ConfigFile = {};
    if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
    if (typeof parsed.active === "boolean") config.active = parsed.active;
    const supportedModels = normalizeModelKeys(parsed.supportedModels);
    if (supportedModels !== undefined) config.supportedModels = supportedModels;
    if (isRecord(parsed.usage)) {
      config.usage = {};
      if (typeof parsed.usage.enabled === "boolean") config.usage.enabled = parsed.usage.enabled;
      if (typeof parsed.usage.refreshIntervalMs === "number") config.usage.refreshIntervalMs = parsed.usage.refreshIntervalMs;
      if (typeof parsed.usage.showOnlyOnSubscriptionModels === "boolean") config.usage.showOnlyOnSubscriptionModels = parsed.usage.showOnlyOnSubscriptionModels;
      if (typeof parsed.usage.showResetTimes === "boolean") config.usage.showResetTimes = parsed.usage.showResetTimes;
    }
    if (isRecord(parsed.footer) && typeof parsed.footer.mode === "string" && (FOOTER_MODES as readonly string[]).includes(parsed.footer.mode)) {
      config.footer = { mode: parsed.footer.mode as FooterMode };
    }
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-better-openai] Failed to read ${path}: ${message}`);
    return undefined;
  }
}

function writeConfig(path: string, config: ConfigFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-better-openai] Failed to write ${path}: ${message}`);
  }
}

function resolveConfig(cwd: string): ResolvedConfig {
  const paths = configPaths(cwd);
  if (!existsSync(paths.project) && !existsSync(paths.global)) writeConfig(paths.global, DEFAULT_CONFIG);

  const globalConfig = readConfig(paths.global) ?? {};
  const projectConfig = readConfig(paths.project) ?? {};
  const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  const selectedPath = existsSync(paths.project) ? paths.project : paths.global;

  return {
    configPath: selectedPath,
    persistState: merged.persistState ?? true,
    active: merged.active ?? false,
    supportedModels: parseModels(merged.supportedModels) ?? parseModels(DEFAULT_SUPPORTED_MODELS) ?? [],
    usage: {
      ...DEFAULT_USAGE_CONFIG,
      ...(globalConfig.usage ?? {}),
      ...(projectConfig.usage ?? {}),
      refreshIntervalMs: Math.max(15_000, Math.min(10 * 60_000, projectConfig.usage?.refreshIntervalMs ?? globalConfig.usage?.refreshIntervalMs ?? DEFAULT_USAGE_CONFIG.refreshIntervalMs))
    },
    footer: {
      ...DEFAULT_FOOTER_CONFIG,
      ...(globalConfig.footer ?? {}),
      ...(projectConfig.footer ?? {})
    }
  };
}

function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function supportsFast(ctx: ExtensionContext, supportedModels: SupportedModel[]): boolean {
  if (!ctx.model) return false;
  return supportedModels.some((model) => model.provider === ctx.model.provider && model.id === ctx.model.id);
}

function modelList(supportedModels: SupportedModel[]): string {
  return supportedModels.length > 0
    ? supportedModels.map((model) => `${model.provider}/${model.id}`).join(", ")
    : "none configured";
}

function stateText(ctx: ExtensionContext, active: boolean, supportedModels: SupportedModel[]): string {
  const model = currentModelKey(ctx);
  if (!active) return `Fast mode is off. Current model: ${model}.`;
  if (supportsFast(ctx, supportedModels)) return `Fast mode is on for ${model}.`;
  return `Fast mode is on, but ${model} is not configured for fast mode. Supported models: ${modelList(supportedModels)}.`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 0) return "";
  const plain = stripAnsi(value);
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return `${plain.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return clampPercent(100 - value);
}

function formatResetCountdown(seconds: number | null): string | null {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${secs}s`;
}

function formatResetClock(seconds: number | null, options?: { includeDate?: boolean }): string | null {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return null;
  const resetDate = new Date(Date.now() + Math.max(0, seconds) * 1000);
  const now = new Date();
  const time = resetDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!options?.includeDate && resetDate.toDateString() === now.toDateString()) return time;
  const weekday = resetDate.toLocaleDateString(undefined, { weekday: "short" });
  if (!options?.includeDate) return `${weekday} ${time}`;
  const date = resetDate.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  return `${weekday} ${date} ${time}`;
}

function formatCompactReset(label: string, seconds: number | null, options?: { includeDate?: boolean }): string | null {
  const countdown = formatResetCountdown(seconds);
  const clock = formatResetClock(seconds, options);
  return countdown && clock ? `${label}↺${countdown} - ${clock}` : null;
}

function readCodexAuth(): { accessToken: string; accountId: string } | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, { type?: string; access?: string | null; accountId?: string | null; account_id?: string | null } | undefined>;
    const entry = auth["openai-codex"];
    if (entry?.type !== "oauth") return undefined;
    const accessToken = entry.access?.trim();
    const accountId = (entry.accountId ?? entry.account_id)?.trim();
    return accessToken && accountId ? { accessToken, accountId } : undefined;
  } catch {
    return undefined;
  }
}

async function requestCodexUsage(): Promise<CodexUsageResponse | undefined> {
  const credentials = readCodexAuth();
  if (!credentials) return undefined;
  const response = await fetch(USAGE_URL, {
    headers: {
      accept: "*/*",
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId
    }
  });
  if (!response.ok) throw new Error(`Codex usage request failed (${response.status})`);
  return (await response.json()) as CodexUsageResponse;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRateLimitBucket(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record) return null;
  if (!("primary_window" in record || "secondary_window" in record || "limit_reached" in record || "allowed" in record)) return null;
  return record as RateLimitBucket;
}

function extractSparkRateLimitFromEntry(value: unknown): RateLimitBucket | null {
  const record = asObject(value);
  if (!record || record.limit_name !== SPARK_LIMIT_NAME) return null;
  return normalizeRateLimitBucket(record.rate_limit);
}

function findSparkRateLimitBucket(data: CodexUsageResponse): RateLimitBucket | null {
  const additional = data.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const bucket = extractSparkRateLimitFromEntry(entry);
      if (bucket) return bucket;
    }
  } else {
    const map = asObject(additional);
    if (map) {
      for (const value of Object.values(map)) {
        const bucket = extractSparkRateLimitFromEntry(value);
        if (bucket) return bucket;
      }
    }
  }
  return null;
}

function getResetSeconds(window: UsageWindow | null | undefined): number | null {
  if (typeof window?.reset_after_seconds === "number" && !Number.isNaN(window.reset_after_seconds)) return window.reset_after_seconds;
  if (typeof window?.reset_at !== "number" || Number.isNaN(window.reset_at)) return null;
  const resetAtSeconds = window.reset_at > 100_000_000_000 ? window.reset_at / 1000 : window.reset_at;
  return Math.max(0, resetAtSeconds - Date.now() / 1000);
}

function parseUsageSnapshot(data: CodexUsageResponse, modelId: string | undefined): UsageSnapshot {
  const bucket = modelId === SPARK_MODEL_ID ? findSparkRateLimitBucket(data) : normalizeRateLimitBucket(data.rate_limit);
  return {
    fiveHourLeftPercent: usedToLeftPercent(bucket?.primary_window?.used_percent),
    sevenDayLeftPercent: usedToLeftPercent(bucket?.secondary_window?.used_percent),
    fiveHourResetInSeconds: getResetSeconds(bucket?.primary_window),
    sevenDayResetInSeconds: getResetSeconds(bucket?.secondary_window),
    isLimited: bucket?.limit_reached === true || bucket?.allowed === false
  };
}

function formatPercent(value: number | null): string {
  return typeof value === "number" && !Number.isNaN(value) ? `${Math.round(clampPercent(value))}% left` : "--";
}

function formatUsageSnapshot(snapshot: UsageSnapshot, options: { showResetTimes: boolean }): string {
  const fiveHour = formatPercent(snapshot.fiveHourLeftPercent);
  const sevenDay = formatPercent(snapshot.sevenDayLeftPercent);
  const resets = options.showResetTimes
    ? [
        formatCompactReset("5h", snapshot.fiveHourResetInSeconds),
        formatCompactReset("7d", snapshot.sevenDayResetInSeconds, { includeDate: true })
      ].filter((value): value is string => value !== null)
    : [];
  return `Usage: 5h: ${fiveHour} | 7d: ${sevenDay}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
}

function isOpenAISubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  if (!ctx.model || (ctx.model.provider !== "openai" && ctx.model.provider !== "openai-codex")) return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || ctx.modelRegistry.isUsingOAuth(ctx.model);
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  let active = false;
  let cachedConfig: ResolvedConfig | undefined;
  let usageSnapshot: UsageSnapshot | undefined;
  let usageUpdatedAt: number | undefined;
  let usageError: string | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = { ...nextConfig, active };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, { ...(readConfig(nextConfig.configPath) ?? {}), active });
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    active = next;
    persist(nextConfig);
    updateFooter(ctx);
    ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  }

  async function refreshUsage(ctx: ExtensionContext, modelId = ctx.model?.id, options?: { notify?: boolean }): Promise<void> {
    if (!ctx.hasUI) return;
    const cfg = config(ctx);
    if (!cfg.usage.enabled) {
      usageSnapshot = undefined;
      usageError = "Usage display is disabled.";
      updateFooter(ctx);
      return;
    }
    try {
      const data = await requestCodexUsage();
      usageSnapshot = data ? parseUsageSnapshot(data, modelId) : undefined;
      usageUpdatedAt = usageSnapshot ? Date.now() : undefined;
      usageError = data ? undefined : `Missing openai-codex OAuth credentials in ${AUTH_FILE}.`;
      updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(formatUsageStatus(ctx), usageSnapshot ? "info" : "warning");
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
      updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(formatUsageStatus(ctx), "warning");
    }
  }

  function startUsageRefresh(ctx: ExtensionContext): void {
    if (usageTimer) clearInterval(usageTimer);
    const cfg = config(ctx);
    if (!cfg.usage.enabled) return;
    void refreshUsage(ctx);
    usageTimer = setInterval(() => void refreshUsage(ctx), cfg.usage.refreshIntervalMs);
    usageTimer.unref?.();
  }

  function formatUsageStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isOpenAISubscriptionModel(ctx, cfg)) return "Usage hidden: current model is not an OpenAI subscription model.";
    if (!usageSnapshot) return `Usage unavailable${usageError ? `: ${usageError}` : "."}`;
    const stale = usageUpdatedAt && Date.now() - usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
      ? ` | stale ${formatResetCountdown((Date.now() - usageUpdatedAt) / 1000)}`
      : "";
    return `${formatUsageSnapshot(usageSnapshot, cfg.usage)}${stale}`;
  }

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    getArgumentCompletions: (prefix) => {
      const items = COMMAND_ARGS.filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !active);
      if (arg === "on") return setActive(ctx, true);
      if (arg === "off") return setActive(ctx, false);
      if (arg === "status") {
        const nextConfig = refresh(ctx);
        ctx.ui.notify(`${stateText(ctx, active, nextConfig.supportedModels)}\n${formatUsageStatus(ctx)}`, "info");
        return;
      }
      if (arg === "models") {
        ctx.ui.notify(`Fast-mode supported models: ${modelList(refresh(ctx).supportedModels)}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /fast [on|off|status|models]", "error");
    }
  });

  pi.registerCommand(USAGE_COMMAND, {
    description: "Show, refresh, enable, or disable OpenAI subscription usage in the footer",
    getArgumentCompletions: (prefix) => {
      const items = USAGE_COMMAND_ARGS.filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase() || "status";
      const cfg = refresh(ctx);
      if (arg === "status") return ctx.ui.notify(formatUsageStatus(ctx), usageSnapshot ? "info" : "warning");
      if (arg === "refresh") return refreshUsage(ctx, ctx.model?.id, { notify: true });
      if (arg === "on" || arg === "off") {
        const current = readConfig(cfg.configPath) ?? {};
        const nextUsage = { ...(current.usage ?? {}), enabled: arg === "on" };
        writeConfig(cfg.configPath, { ...current, usage: nextUsage });
        refresh(ctx);
        if (arg === "on") startUsageRefresh(ctx);
        else {
          if (usageTimer) clearInterval(usageTimer);
          usageTimer = undefined;
          usageSnapshot = undefined;
          usageError = "Usage display is disabled.";
          updateFooter(ctx);
        }
        ctx.ui.notify(`Usage display ${arg === "on" ? "enabled" : "disabled"}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /usage [status|refresh|on|off]", "error");
    }
  });

  pi.registerCommand(FOOTER_COMMAND, {
    description: "Set footer mode: replace | status | off",
    getArgumentCompletions: (prefix) => {
      const items = FOOTER_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase() as FooterMode;
      if (!(FOOTER_MODES as readonly string[]).includes(mode)) {
        ctx.ui.notify(`Footer mode is ${config(ctx).footer.mode}. Usage: /fast-footer [replace|status|off]`, "info");
        return;
      }
      const cfg = refresh(ctx);
      const current = readConfig(cfg.configPath) ?? {};
      writeConfig(cfg.configPath, { ...current, footer: { ...(current.footer ?? {}), mode } });
      refresh(ctx);
      updateFooter(ctx);
      ctx.ui.notify(`Footer mode set to ${mode}.`, "info");
    }
  });

  function installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "message" || entry.message.role !== "assistant") continue;
            totalInput += entry.message.usage.input;
            totalOutput += entry.message.usage.output;
            totalCacheRead += entry.message.usage.cacheRead;
            totalCacheWrite += entry.message.usage.cacheWrite;
            totalCost += entry.message.usage.cost.total;
          }

          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const parts: string[] = [];
          if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription) parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const contextDisplay = contextPercent === "?" ? `?/${formatTokens(contextWindow)} (auto)` : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          const contextText = contextPercentValue > 90
            ? theme.fg("error", contextDisplay)
            : contextPercentValue > 70
              ? theme.fg("warning", contextDisplay)
              : contextDisplay;
          parts.push(contextText);

          let usageLine: string | undefined;
          const cfg = config(ctx);
          if (usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg)) {
            usageLine = theme.fg("dim", formatUsageSnapshot(usageSnapshot, cfg.usage));
          }

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastSuffix = active && supportsFast(ctx, config(ctx).supportedModels) ? " fast" : "";
          let rightWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            rightWithoutProvider = thinkingLevel === "off"
              ? `${modelName}${fastSuffix} • thinking off`
              : `${modelName}${fastSuffix} • ${thinkingLevel}`;
          } else if (fastSuffix) {
            rightWithoutProvider = `${modelName}${fastSuffix}`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightWidth;
          let statsLine: string;
          if (totalNeeded <= width) {
            statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const lines = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length))
          ];

          if (usageLine) {
            lines.push(truncateToWidth(usageLine, width, theme.fg("dim", "...")));
          }

          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => sanitizeStatusText(String(text)))
              .join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        }
      };
    });
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);
    if (cfg.footer.mode === "replace") {
      ctx.ui.setStatus("better-openai", undefined);
      installFooter(ctx);
      return;
    }
    ctx.ui.setFooter(undefined);
    if (cfg.footer.mode === "off") {
      ctx.ui.setStatus("better-openai", undefined);
      return;
    }
    const fast = active && supportsFast(ctx, cfg.supportedModels) ? `${ctx.model?.id ?? "model"} fast` : undefined;
    const usage = usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg) ? formatUsageSnapshot(usageSnapshot, cfg.usage) : undefined;
    ctx.ui.setStatus("better-openai", [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    const nextConfig = refresh(ctx);
    active = nextConfig.persistState ? nextConfig.active : false;
    if (pi.getFlag(FLAG) === true) {
      active = true;
      persist(nextConfig);
    }
    updateFooter(ctx);
    startUsageRefresh(ctx);
    if (active) ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  });

  pi.on("turn_end", (_event, ctx) => {
    void refreshUsage(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    updateFooter(ctx);
    void refreshUsage(ctx, event.model.id);
  });

  pi.on("session_shutdown", () => {
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const nextConfig = config(ctx);
    if (!active || !supportsFast(ctx, nextConfig.supportedModels) || !isRecord(event.payload)) return;
    return { ...event.payload, service_tier: SERVICE_TIER };
  });
}

export const _test = {
  CONFIG_BASENAME,
  DEFAULT_SUPPORTED_MODELS,
  DEFAULT_CONFIG,
  SERVICE_TIER,
  configPaths,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  resolveConfig,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  readCodexAuth
};
