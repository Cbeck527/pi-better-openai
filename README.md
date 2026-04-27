# pi-better-openai

A personal pi extension that improves OpenAI in pi with fast mode, usage stats, and footer polish. Fast mode adds `service_tier: "priority"` to provider requests for configured models.

It also customizes the footer to show `gpt-5.5 fast • low` and, when `openai-codex` OAuth credentials are available, Codex usage windows from ChatGPT's usage endpoint.

It does **not** change the selected model, thinking level, tools, or prompts.

## Usage

Load locally while developing:

```bash
pi -e ./extensions/index.ts
```

Start with fast mode enabled:

```bash
pi -e ./extensions/index.ts --fast
```

Commands:

- `/fast` toggles fast mode.
- `/fast on` enables fast mode.
- `/fast off` disables fast mode.
- `/fast status` shows fast mode plus usage status.
- `/fast models` lists configured models.
- `/usage` or `/usage status` shows current OpenAI subscription usage.
- `/usage refresh` refetches usage immediately.
- `/usage on` / `/usage off` toggles usage display.
- `/fast-footer replace|status|off` controls how the extension renders footer UI.

The footer usage display is fetched from `https://chatgpt.com/backend-api/wham/usage` using the `openai-codex` OAuth entry in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`). It refreshes on startup, after turns, on model changes, and every configured interval.

Footer modes:

- `replace` (default): replaces pi's footer so the model area can say `gpt-5.5 fast • low` and usage can appear on a separate line.
- `status`: leaves pi's default footer intact and uses an extension status line instead.
- `off`: disables footer/status UI while keeping fast mode behavior.

## Config

The extension uses project-over-global config:

- Project: `<repo>/.pi/extensions/pi-better-openai.json`
- Global: `~/.pi/agent/extensions/pi-better-openai.json`

If no config exists, the extension writes a default global config.

```json
{
  "persistState": true,
  "active": false,
  "supportedModels": [
    "openai/gpt-5.4",
    "openai/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5"
  ],
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true
  },
  "footer": {
    "mode": "replace"
  }
}
```

- `persistState`: persist `/fast on|off` across sessions.
- `active`: startup state when `persistState` is true.
- `supportedModels`: exact `provider/model-id` keys that should receive `service_tier: "priority"`. Defaults are limited to the Codex Fast Mode supported models documented by OpenAI: GPT-5.5 and GPT-5.4. OpenAI's Codex config docs mention `service_tier = "fast"`, but Codex implementation/issues show the request payload uses the priority service tier for Fast Mode.
- `usage.enabled`: fetch and display subscription usage.
- `usage.refreshIntervalMs`: usage refresh interval, clamped between 15 seconds and 10 minutes.
- `usage.showOnlyOnSubscriptionModels`: only show usage when current OpenAI model uses OAuth/subscription auth.
- `usage.showResetTimes`: include compact reset countdown + local reset time.
- `footer.mode`: `replace`, `status`, or `off`.

## Install as a pi package

This repository is already shaped as a pi package. After publishing or installing from git, pi discovers `extensions/index.ts` via the `pi.extensions` manifest in `package.json`.
