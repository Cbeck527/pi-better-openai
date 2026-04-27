/**
 * GPT fast mode for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the configured allow-list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const COMMAND = "fast";
const FLAG = "fast";
const CONFIG_BASENAME = "pi-gpt-fast.json";
const SERVICE_TIER = "priority";
const COMMAND_ARGS = ["on", "off", "status", "models"] as const;

const DEFAULT_SUPPORTED_MODELS = [
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5",
  "openai-codex/gpt-5.1-codex",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5"
] as const;

interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  supportedModels?: string[];
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
}

const DEFAULT_CONFIG: Required<ConfigFile> = {
  persistState: true,
  active: false,
  supportedModels: [...DEFAULT_SUPPORTED_MODELS]
};

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
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-gpt-fast] Failed to read ${path}: ${message}`);
    return undefined;
  }
}

function writeConfig(path: string, config: ConfigFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-gpt-fast] Failed to write ${path}: ${message}`);
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
    persistState: merged.persistState,
    active: merged.active,
    supportedModels: parseModels(merged.supportedModels) ?? parseModels(DEFAULT_SUPPORTED_MODELS) ?? []
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

export default function gptFast(pi: ExtensionAPI): void {
  let active = false;
  let cachedConfig: ResolvedConfig | undefined;

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
    installFooter(ctx);
    ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  }

  pi.registerFlag(FLAG, {
    description: "Start with GPT fast mode enabled (OpenAI service_tier=priority)",
    type: "boolean",
    default: false
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle GPT fast mode for OpenAI models",
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
        ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
        return;
      }
      if (arg === "models") {
        ctx.ui.notify(`Fast-mode supported models: ${modelList(refresh(ctx).supportedModels)}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /fast [on|off|status|models]", "error");
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

  pi.on("session_start", (_event, ctx) => {
    const nextConfig = refresh(ctx);
    active = nextConfig.persistState ? nextConfig.active : false;
    if (pi.getFlag(FLAG) === true) {
      active = true;
      persist(nextConfig);
    }
    installFooter(ctx);
    if (active) ctx.ui.notify(stateText(ctx, active, nextConfig.supportedModels), "info");
  });

  pi.on("model_select", (_event, ctx) => {
    installFooter(ctx);
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
  supportsFast
};
