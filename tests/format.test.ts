import { describe, expect, test } from "vitest";
import { truncateToWidth } from "../src/format.ts";

describe("format helpers", () => {
  test("truncates ansi-styled text to visible width", () => {
    expect(truncateToWidth("\u001b[2mabcdef\u001b[22m", 4)).toBe("\u001b[2ma...\u001b[22m");
  });
});
