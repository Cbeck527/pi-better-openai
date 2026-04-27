import assert from "node:assert/strict";
import { _test } from "../extensions/index.ts";

assert.equal(_test.CONFIG_BASENAME, "pi-better-openai.json");
assert.equal(_test.SERVICE_TIER, "priority");
assert.deepEqual(_test.DEFAULT_SUPPORTED_MODELS, [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
]);

assert.deepEqual(_test.parseModelKey("openai/gpt-5.5"), { provider: "openai", id: "gpt-5.5" });
assert.equal(_test.parseModelKey("bad"), undefined);
assert.equal(_test.formatPercent(99.4), "99% left");
assert.equal(_test.formatPercent(null), "--");

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

console.log("tests passed");
