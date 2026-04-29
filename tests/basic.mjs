import assert from "node:assert/strict";
import { _test } from "../extensions/pi-better-openai.ts";
import { truncateToWidth } from "../extensions/format.ts";
import { isRecord, readRawConfig, writeConfig } from "../extensions/config.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(_test.CONFIG_BASENAME, "pi-better-openai.json");
assert.equal(_test.DEFAULT_CONFIG.desiredActive, false);
assert.equal(_test.DEFAULT_IMAGE_CONFIG.defaultSave, "project");
assert.equal(_test.SERVICE_TIER, "priority");
assert.deepEqual(_test.DEFAULT_SUPPORTED_MODELS, [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
]);

assert.deepEqual(_test.parseModelKey("openai/gpt-5.5"), { provider: "openai", id: "gpt-5.5" });
assert.equal(_test.parseModelKey("bad"), undefined);
assert.deepEqual(_test.normalizeModelKeys(["openai/gpt-5.5", "bad", 42]), ["openai/gpt-5.5"]);
assert.equal(_test.formatPercent(99.4), "99%");
assert.equal(_test.formatPercent(null), "--");
assert.equal(_test.imageTest.OPENAI_IMAGE_TOOL, "openai_image");
assert.equal(_test.imageTest.imageMimeType("x.jpg"), "image/jpeg");
assert.deepEqual(_test.imageTest.dataUrlParts("data:image/png;base64,Zm9v", "image/png"), { data: "Zm9v", mimeType: "image/png" });
assert.equal(_test.imageTest.extractImageFromEvent({ type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", status: "completed", result: "Zm9v" } }, "image/png").data, "Zm9v");

const usage = _test.parseUsageSnapshot(
  {
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 1, reset_after_seconds: 60 },
      secondary_window: { used_percent: 49, reset_after_seconds: 3600 },
    },
  },
  "gpt-5.5",
);
assert.equal(usage.fiveHourLeftPercent, 99);
assert.equal(usage.sevenDayLeftPercent, 51);
assert.equal(usage.isLimited, false);
assert.match(_test.formatUsageSnapshot(usage, { showResetTimes: false }), /^Usage: 5h: 99% \| 7d: 51%$/);
assert.equal(truncateToWidth("\u001b[2mabcdef\u001b[22m", 4), "\u001b[2ma...\u001b[22m");

const tempDir = mkdtempSync(join(tmpdir(), "pi-better-openai-"));
try {
  const configPath = join(tempDir, "config.json");
  writeConfig(configPath, {
    active: false,
    unknownField: "keep me",
    usage: { enabled: true, unknownUsageField: 123 },
  });
  const current = readRawConfig(configPath);
  writeConfig(configPath, { ...current, active: true });
  const afterActiveWrite = readRawConfig(configPath);
  assert.equal(afterActiveWrite.active, true);
  assert.equal(afterActiveWrite.unknownField, "keep me");
  assert.deepEqual(afterActiveWrite.usage, { enabled: true, unknownUsageField: 123 });

  const currentUsage = isRecord(afterActiveWrite.usage) ? afterActiveWrite.usage : {};
  writeConfig(configPath, { ...afterActiveWrite, usage: { ...currentUsage, enabled: false } });
  const afterUsageWrite = readRawConfig(configPath);
  assert.deepEqual(afterUsageWrite.usage, { enabled: false, unknownUsageField: 123 });

  const projectConfigPath = _test.configPaths(tempDir).project;
  writeConfig(projectConfigPath, { image: { defaultSave: "global", outputFormat: "webp", timeoutMs: 1 } });
  const resolved = _test.resolveConfig(tempDir);
  assert.equal(resolved.image.defaultSave, "global");
  assert.equal(resolved.image.outputFormat, "webp");
  assert.equal(resolved.image.timeoutMs, 30000);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("tests passed");
