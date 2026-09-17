import { describe, expect, it } from "vitest";
import { resolveSystemTheme } from "./themes";

describe("resolveSystemTheme（system 模式映射）", () => {
  it("系统深色 → dark", () => expect(resolveSystemTheme(true)).toBe("dark"));
  it("系统浅色 → glass", () => expect(resolveSystemTheme(false)).toBe("glass"));
});
