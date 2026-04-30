# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, and image generation through `openai-codex` auth.

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

Sign in to OpenAI Codex subscription auth if you want usage stats or image generation:

```text
/login openai-codex
```

Start pi with fast mode enabled:

```bash
pi --fast
```

## Features

- Fast mode for supported OpenAI models, toggled with `/fast` or in `/openai-settings`.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive settings picker via `/openai-settings`.
- Footer customization for model, thinking, fast mode, usage, and token/cost context.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens settings, diagnostics, and config details.

## Screenshots

<!-- Add screenshots here. -->

<img width="983" height="851" alt="Screenshot 2026-04-29 at 11 53 23 PM" src="https://github.com/user-attachments/assets/07a2fb87-ef48-4396-8b12-124825c8d360" />
<img width="1327" height="102" alt="Screenshot 2026-04-29 at 11 34 49 PM" src="https://github.com/user-attachments/assets/22042782-c94e-491d-b5af-095f7f0810f9" />
