import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { _test } from "../index.ts";
import { makeResolvedConfig } from "./helpers.ts";

describe("image helpers", () => {
  test("exposes image tool defaults", () => {
    expect(_test.imageTest.OPENAI_IMAGE_TOOL).toBe("openai_image");
  });

  test("detects image mime types and display paths", () => {
    expect(_test.imageTest.imageMimeType("x.jpg")).toBe("image/jpeg");
    expect(_test.imageTest.displayPath(join(homedir(), "dev", "image.png"))).toBe(
      "~/dev/image.png",
    );
  });

  test("extracts prompts and data URLs", () => {
    expect(
      _test.imageTest.latestUserPromptFromEntries([
        { type: "message", message: { role: "user", content: "draw a dog" } },
      ]),
    ).toBe("draw a dog");
    expect(_test.imageTest.dataUrlParts("data:image/png;base64,Zm9v", "image/png")).toEqual({
      data: "Zm9v",
      mimeType: "image/png",
    });
  });

  test("extracts image generation results from response events", () => {
    const extracted = _test.imageTest.extractImageFromEvent(
      {
        type: "response.output_item.done",
        item: { type: "image_generation_call", id: "ig_1", status: "completed", result: "Zm9v" },
      },
      "image/png",
    );
    expect(extracted?.data).toBe("Zm9v");
  });

  test("builds image generation requests", () => {
    expect(
      _test.imageTest.buildRequest(
        { prompt: "draw an otter" },
        "gpt-5.5",
        makeResolvedConfig({ image: _test.DEFAULT_IMAGE_CONFIG }),
        [],
      ).tool_choice,
    ).toEqual({ type: "image_generation" });
  });
});
