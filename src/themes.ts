// 主题应用（Spec §6 主题系统）。matchMedia 只允许出现在本文件的 applyTheme/watchSystemTheme；
// 测试通过纯函数 resolveSystemTheme 覆盖映射逻辑，不触碰 window。
import type { Settings, ThemeMode } from "./types";

export type ResolvedTheme = Exclude<ThemeMode, "system">;

/** system 模式映射：深色 → dark（暗夜），浅色 → glass（毛玻璃） */
export function resolveSystemTheme(prefersDark: boolean): ResolvedTheme {
  return prefersDark ? "dark" : "glass";
}

/** 应用主题到 <html data-theme>，返回实际生效的主题（供日志/调试） */
export function applyTheme(mode: Settings["theme"]): ResolvedTheme {
  const resolved =
    mode === "system"
      ? resolveSystemTheme(
          window.matchMedia("(prefers-color-scheme: dark)").matches,
        )
      : mode;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** 监听系统深浅色变化（仅 system 模式下由 main.ts 决定是否重应用） */
export function watchSystemTheme(onChange: () => void): void {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", onChange);
}
