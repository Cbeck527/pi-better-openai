# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, and image generation through `openai-codex` auth.

## Screenshots

<!-- Add screenshots here. -->

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
- OpenAI image generation/editing through the `openai_image` tool.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens settings, diagnostics, and config details.
