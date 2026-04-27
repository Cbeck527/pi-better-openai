/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the configured allow-list.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CONFIG_BASENAME, STATUS_KEY } from "./identity.ts";
import { formatTokens, sanitizeStatusText, truncateToWidth, visibleWidth } from "./format.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_SUPPORTED_MODELS,
  FOOTER_MODES,
  configPaths,
  type FooterMode,
  type ResolvedConfig,
  type SupportedModel,
  isRecord,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  readRawConfig,
  resolveConfig,
  writeConfig
} from "./config.ts";
import {
  AUTH_FILE,
  type UsageSnapshot,
  formatPercent,
  formatResetCountdown,
  formatUsageSnapshot,
  parseUsageSnapshot,
  readCodexAuth,
  requestCodexUsage
} from "./usage.ts";

const COMMAND = "fast";
const USAGE_COMMAND = "usage";
const FOOTER_COMMAND = "fast-footer";
const OPENAI_FOOTER_COMMAND = "openai-footer";
const OPENAI_STATUS_COMMAND = "openai-status";
const OPENAI_CONFIG_COMMAND = "openai-config";
const FLAG = "fast";
const SERVICE_TIER = "priority";
const COMMAND_ARGS = ["on", "off", "status", "models", "debug"] as const;
const USAGE_COMMAND_ARGS = ["status", "refresh", "on", "off"] as const;

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

function stateText(ctx: ExtensionContext, active: boolean, _supportedModels: SupportedModel[]): string {
  const model = currentModelKey(ctx);
  return active ? `Fast mode is on for ${model}.` : `Fast mode is off. Current model: ${model}.`;
}

function isOpenAISubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  if (!ctx.model || (ctx.model.provider !== "openai" && ctx.model.provider !== "openai-codex")) return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || ctx.modelRegistry.isUsingOAuth(ctx.model);
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  let desiredActive = false;
  let active = false;
  let cachedConfig: ResolvedConfig | undefined;
  let usageSnapshot: UsageSnapshot | undefined;
  let usageUpdatedAt: number | undefined;
  let usageError: string | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let usageRefreshInFlight = false;
  let queuedUsageRefresh: { ctx: ExtensionContext; modelId?: string; notify?: boolean } | undefined;
  let footerInstalled = false;
  let requestFooterRender: (() => void) | undefined;
  let lastInjectedAt: number | undefined;
  let lastInjectedModel: string | undefined;
  let lastInjectedTier: string | undefined;

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = { ...nextConfig, active, desiredActive };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, { ...readRawConfig(nextConfig.configPath), active, desiredActive });
  }

  function applyDesiredFastState(ctx: ExtensionContext, cfg = config(ctx)): void {
    active = desiredActive && supportsFast(ctx, cfg.supportedModels);
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    desiredActive = next;
    applyDesiredFastState(ctx, nextConfig);
    persist(nextConfig);
    updateFooter(ctx);
    if (next && !active) {
      ctx.ui.notify(`Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(nextConfig.supportedModels)}.`, "warning");
      return;
    }
    ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  }

  async function refreshUsage(ctx: ExtensionContext, modelId = ctx.model?.id, options?: { notify?: boolean }): Promise<void> {
    if (!ctx.hasUI) return;
    if (usageRefreshInFlight) {
      queuedUsageRefresh = { ctx, modelId, notify: queuedUsageRefresh?.notify || options?.notify };
      return;
    }
    usageRefreshInFlight = true;
    const cfg = config(ctx);
    try {
      if (!cfg.usage.enabled) {
        usageSnapshot = undefined;
        usageError = "Usage display is disabled.";
        updateFooter(ctx);
        return;
      }
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
      const data = await requestCodexUsage(signal);
      usageSnapshot = data ? parseUsageSnapshot(data, modelId) : undefined;
      usageUpdatedAt = usageSnapshot ? Date.now() : undefined;
      usageError = data ? undefined : `Missing openai-codex OAuth credentials in ${AUTH_FILE}.`;
      updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(formatUsageStatus(ctx), usageSnapshot ? "info" : "warning");
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
      updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(formatUsageStatus(ctx), "warning");
    } finally {
      usageRefreshInFlight = false;
      if (queuedUsageRefresh) {
        const next = queuedUsageRefresh;
        queuedUsageRefresh = undefined;
        void refreshUsage(next.ctx, next.modelId, { notify: next.notify });
      }
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

  function refreshFooterTotals(ctx: ExtensionContext): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      footerTotals.input += entry.message.usage.input;
      footerTotals.output += entry.message.usage.output;
      footerTotals.cacheRead += entry.message.usage.cacheRead;
      footerTotals.cacheWrite += entry.message.usage.cacheWrite;
      footerTotals.cost += entry.message.usage.cost.total;
    }
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

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      `Fast desired: ${desiredActive}`,
      `Fast active: ${active}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Supported model: ${supportsFast(ctx, cfg.supportedModels)}`,
      `Configured service_tier: ${SERVICE_TIER}`,
      `Last injected: ${lastInjectedAt ? `${new Date(lastInjectedAt).toLocaleTimeString()} (${lastInjectedModel}, ${lastInjectedTier})` : "never"}`,
      `Footer mode: ${cfg.footer.mode}`,
      `Usage enabled: ${cfg.usage.enabled}`,
      `Config: ${cfg.configPath}`
    ].join("\n");
  }

  function formatOpenAIStatus(ctx: ExtensionContext): string {
    const cfg = refresh(ctx);
    return [
      stateText(ctx, active, cfg.supportedModels),
      formatUsageStatus(ctx),
      `Footer mode: ${cfg.footer.mode}`,
      `Config: ${cfg.configPath}`
    ].join("\n");
  }

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    getArgumentCompletions: (prefix) => {
      const items = COMMAND_ARGS.filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !desiredActive);
      if (arg === "on") return setActive(ctx, true);
      if (arg === "off") return setActive(ctx, false);
      if (arg === "status") {
        ctx.ui.notify(formatOpenAIStatus(ctx), "info");
        return;
      }
      if (arg === "debug") {
        ctx.ui.notify(formatDebugStatus(ctx), "info");
        return;
      }
      if (arg === "models") {
        ctx.ui.notify(`Fast-mode supported models: ${modelList(refresh(ctx).supportedModels)}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /fast [on|off|status|models|debug]", "error");
    }
  });

  pi.registerCommand(OPENAI_STATUS_COMMAND, {
    description: "Show Better OpenAI fast, usage, footer, and config status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatOpenAIStatus(ctx), "info");
    }
  });

  pi.registerCommand(OPENAI_CONFIG_COMMAND, {
    description: "Show Better OpenAI config paths and selected config",
    getArgumentCompletions: (prefix) => {
      const items = ["path", "print"].filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const cfg = refresh(ctx);
      const arg = args.trim().toLowerCase();
      if (arg === "path") {
        ctx.ui.notify(cfg.configPath, "info");
        return;
      }
      if (arg === "print") {
        ctx.ui.notify(JSON.stringify(readRawConfig(cfg.configPath), null, 2), "info");
        return;
      }
      ctx.ui.notify([
        `Selected config: ${cfg.configPath}`,
        `Project config: ${cfg.projectConfigExists ? "found" : "not found"} (${cfg.projectConfigPath})`,
        `Global config: ${cfg.globalConfigExists ? "found" : "not found"} (${cfg.globalConfigPath})`,
        "Usage: /openai-config [path|print]"
      ].join("\n"), "info");
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
        const current = readRawConfig(cfg.configPath);
        const currentUsage = isRecord(current.usage) ? current.usage : {};
        const nextUsage = { ...currentUsage, enabled: arg === "on" };
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

  function registerFooterCommand(name: string): void {
    pi.registerCommand(name, {
      description: "Set footer mode: replace | status | off",
      getArgumentCompletions: (prefix) => {
        const items = FOOTER_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
        return items.length ? items : null;
      },
      handler: async (args, ctx) => {
        const mode = args.trim().toLowerCase() as FooterMode;
        if (!(FOOTER_MODES as readonly string[]).includes(mode)) {
          ctx.ui.notify(`Footer mode is ${config(ctx).footer.mode}. Usage: /${name} [replace|status|off]`, "info");
          return;
        }
        const cfg = refresh(ctx);
        const current = readRawConfig(cfg.configPath);
        const currentFooter = isRecord(current.footer) ? current.footer : {};
        writeConfig(cfg.configPath, { ...current, footer: { ...currentFooter, mode } });
        refresh(ctx);
        updateFooter(ctx);
        ctx.ui.notify(`Footer mode set to ${mode}.`, "info");
      }
    });
  }

  registerFooterCommand(FOOTER_COMMAND);
  registerFooterCommand(OPENAI_FOOTER_COMMAND);

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      requestFooterRender?.();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      return {
        dispose: () => {
          unsubscribe?.();
          footerInstalled = false;
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const totalInput = footerTotals.input;
          const totalOutput = footerTotals.output;
          const totalCacheRead = footerTotals.cacheRead;
          const totalCacheWrite = footerTotals.cacheWrite;
          const totalCost = footerTotals.cost;

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
      ctx.ui.setStatus(STATUS_KEY, undefined);
      installFooter(ctx);
      return;
    }
    footerInstalled = false;
    requestFooterRender = undefined;
    ctx.ui.setFooter(undefined);
    if (cfg.footer.mode === "off") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const fast = active && supportsFast(ctx, cfg.supportedModels) ? `${ctx.model?.id ?? "model"} fast` : undefined;
    const usage = usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg) ? formatUsageSnapshot(usageSnapshot, cfg.usage) : undefined;
    ctx.ui.setStatus(STATUS_KEY, [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    const nextConfig = refresh(ctx);
    desiredActive = nextConfig.persistState ? nextConfig.desiredActive : false;
    if (pi.getFlag(FLAG) === true) desiredActive = true;
    applyDesiredFastState(ctx, nextConfig);
    if (desiredActive !== nextConfig.desiredActive || active !== nextConfig.active) persist(nextConfig);
    if (desiredActive && !active) {
      ctx.ui.notify(`Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(nextConfig.supportedModels)}.`, "warning");
    }
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    startUsageRefresh(ctx);
    if (active) ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    void refreshUsage(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const cfg = config(ctx);
    const wasActive = active;
    applyDesiredFastState(ctx, cfg);
    if (active !== wasActive) {
      persist(cfg);
      ctx.ui.notify(active ? stateText(ctx, active, cfg.supportedModels) : `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`, active ? "info" : "warning");
    }
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
    lastInjectedAt = Date.now();
    lastInjectedModel = currentModelKey(ctx);
    lastInjectedTier = SERVICE_TIER;
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
  readRawConfig,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  readCodexAuth
};
