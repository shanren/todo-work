// 装配层：加载状态 → 应用主题 → initApp（渲染 + 交互绑定）。
// URL 参数（仅开发调试，生产不可达）：
//   ?theme=glass|paper|dark|system  临时覆盖主题
//   ?demo=1                          使用内置样例数据（只读观感验证，不绑定交互、不落盘）
import { Store, emptyState } from "./state";
import type { AppState, ThemeMode } from "./types";
import { applyTheme, watchSystemTheme } from "./themes";
import { demoState, initApp, render } from "./render";

const params = new URLSearchParams(window.location.search);
const themeParam = params.get("theme");
const demo = params.has("demo");

function isThemeMode(v: string | null): v is ThemeMode {
  return v === "glass" || v === "paper" || v === "dark" || v === "system";
}

async function boot(): Promise<void> {
  const store = new Store();
  let state: AppState;
  if (demo) {
    // 演示模式：静态渲染样例数据；交互会触发真实 IPC，故不绑定
    state = demoState();
    const mode: ThemeMode = isThemeMode(themeParam)
      ? themeParam
      : state.settings.theme;
    applyTheme(mode);
    render(state);
    return;
  }
  try {
    await store.load();
    state = store.state;
  } catch {
    // 浏览器直开（无 Tauri 运行时）时的兜底，正常路径不会走到
    state = emptyState();
  }

  const mode: ThemeMode = isThemeMode(themeParam)
    ? themeParam
    : state.settings.theme;
  applyTheme(mode);
  watchSystemTheme(() => applyTheme(mode));

  initApp(store);
}

window.addEventListener("DOMContentLoaded", boot);
