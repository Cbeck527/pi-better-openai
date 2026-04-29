# pi-better-openai

A personal pi extension that improves OpenAI in pi with fast mode, usage stats, footer polish, and OpenAI image generation through `openai-codex` subscription auth. Fast mode adds `service_tier: "priority"` to provider requests for configured models.

It also customizes the footer to show `gpt-5.5 fast • low` and, when `openai-codex` OAuth credentials are available, Codex usage windows from ChatGPT's usage endpoint.

It does **not** change the selected model, thinking level, or prompts. It registers an additional `openai_image` tool for image generation/editing.

## Install

Install from a local checkout:

```bash
pi install /path/to/pi-better-openai
```

For a project-local install instead of a global install, add `-l`:

```bash
pi install -l /path/to/pi-better-openai
```

Reload pi after installing:

```text
/reload
```

Start with fast mode enabled:

```bash
pi --fast
```

## Usage

Commands:

- `/fast` toggles fast mode.
- `/fast on` enables fast mode.
- `/fast off` disables fast mode.
- `/fast status` shows fast mode plus usage status.
- `/fast debug` shows injected service tier, last injection time, config path, and footer/usage settings.
- `/fast models` lists configured models.
- `/usage` or `/usage status` shows current OpenAI subscription usage.
- `/usage refresh` refetches usage immediately.
- `/usage debug` shows usage endpoint/auth/fetch diagnostics without printing tokens.
- `/usage on` / `/usage off` toggles usage display.
- `/openai-image <prompt>` generates an image through OpenAI Codex subscription auth and saves it to the project by default. Flags: `--image/-i <path[,path]>`, `--action auto|generate|edit`, `--save none|project|global|custom`, `--format png|jpeg|webp`, `--model <id>`, `--save-dir <dir>`.
- `/openai-image debug` shows image-generation auth/config/endpoint diagnostics.
- `/openai-status` shows fast mode, usage, footer mode, and config path.
- `/openai-config`, `/openai-config path`, and `/openai-config print` show config locations or contents.
- `/openai-footer replace|status|off` controls how the extension renders footer UI.
- `/fast-footer replace|status|off` is kept as an alias.

Fast mode has separate desired/effective state. If you run `/fast on` with an unsupported model, the extension remembers that fast mode is desired, warns that the current model is unsupported, and leaves effective fast mode off until you switch to a supported model.

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
  "desiredActive": false,
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
  },
  "image": {
    "enabled": true,
    "defaultModel": "gpt-5.5",
    "defaultSave": "project",
    "outputFormat": "png",
    "timeoutMs": 180000
  }
}
```

- `persistState`: persist `/fast on|off` across sessions.
- `active`: last effective runtime state.
- `desiredActive`: desired fast-mode state; if true, fast activates automatically when the current model supports it.
- `supportedModels`: exact `provider/model-id` keys that should receive `service_tier: "priority"`. Defaults are limited to the Codex Fast Mode supported models documented by OpenAI: GPT-5.5 and GPT-5.4. OpenAI's Codex config docs mention `service_tier = "fast"`, but Codex implementation/issues show the request payload uses the priority service tier for Fast Mode.
- `usage.enabled`: fetch and display subscription usage.
- `usage.refreshIntervalMs`: usage refresh interval, clamped between 15 seconds and 10 minutes.
- `usage.showOnlyOnSubscriptionModels`: only show usage when current OpenAI model uses OAuth/subscription auth.
- `usage.showResetTimes`: include compact reset countdown + local reset time.
- `footer.mode`: `replace`, `status`, or `off`.
- `image.enabled`: allow the `openai_image` tool and `/openai-image` command to make image requests.
- `image.defaultModel`: model used when the current model is not `openai-codex/*`.
- `image.defaultSave`: `project` (default), `none`, `global`, or `custom`.
- `image.outputFormat`: `png`, `jpeg`, or `webp`; Codex currently uses `png` by default.
- `image.timeoutMs`: image request timeout, clamped between 30 seconds and 5 minutes.

## Image generation

The `openai_image` tool and `/openai-image` command call `https://chatgpt.com/backend-api/codex/responses` with the hosted Responses `image_generation` tool and the `openai-codex` OAuth credentials from `/login openai-codex`. This follows Codex CLI's subscription-auth path and does not require `OPENAI_API_KEY`.

Tool parameters include `prompt`, optional `images` local paths for edit/reference workflows, `action` (`auto`, `generate`, `edit`), `outputFormat`, and save controls. Images are returned inline to pi and saved to `<repo>/.pi/generated-images/` by default.

## Development

```bash
npm test
```

The extension is split into a few small modules plus the main extension entry point:

- `extensions/identity.ts` owns package identity, config filename, and status key constants.
- `extensions/config.ts` owns config types, defaults, parsing, resolving, and raw-preserving writes.
- `extensions/usage.ts` owns Codex auth reading, usage endpoint fetching, usage parsing, and usage formatting.
- `extensions/image.ts` owns OpenAI Codex subscription-auth image generation, image saving, and `/openai-image`.
- `extensions/format.ts` owns footer text formatting helpers.
- `extensions/pi-better-openai.ts` wires commands, fast-mode state, usage refresh, image generation, provider-request injection, events, and footer rendering.

## Package layout

This repository is shaped as a pi package. Pi discovers `extensions/pi-better-openai.ts` via the `pi.extensions` manifest in `package.json`.
