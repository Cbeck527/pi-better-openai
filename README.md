# pi-gpt-fast

A pi extension that toggles OpenAI GPT fast mode by adding `service_tier: "priority"` to provider requests for configured models.

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
- `/fast status` shows current state.
- `/fast models` lists configured models.

## Config

The extension uses project-over-global config:

- Project: `<repo>/.pi/extensions/pi-gpt-fast.json`
- Global: `~/.pi/agent/extensions/pi-gpt-fast.json`

If no config exists, the extension writes a default global config.

```json
{
  "persistState": true,
  "active": false,
  "supportedModels": [
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
  ]
}
```

- `persistState`: persist `/fast on|off` across sessions.
- `active`: startup state when `persistState` is true.
- `supportedModels`: exact `provider/model-id` keys that should receive `service_tier: "priority"`.

## Install as a pi package

This repository is already shaped as a pi package. After publishing or installing from git, pi discovers `extensions/index.ts` via the `pi.extensions` manifest in `package.json`.
