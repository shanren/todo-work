// 失焦自动收起（Task 10）：窗口失焦持续 1 分钟 → collapse（Rust 销毁窗口）。
// 计时纯逻辑与浏览器接线分离，便于 fake timers 单测；开关在事件时刻读取（设置面板即时生效）。
import { collapseWindow } from "./bridge";

export interface AutoCollapseOpts {
  /** 每次失焦时读取；false 则本次失焦不计时 */
  enabled: () => boolean;
  onTimeout: () => void;
  timeoutMs: number;
}

export interface AutoCollapse {
  handleBlur(): void;
  handleFocus(): void;
  /** 取消未触发的计时器（页面卸载/关闭时） */
  stop(): void;
}

export function createAutoCollapse(opts: AutoCollapseOpts): AutoCollapse {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    handleBlur(): void {
      clear();
      if (!opts.enabled()) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        opts.onTimeout();
      }, opts.timeoutMs);
    },
    handleFocus(): void {
      clear();
    },
    stop(): void {
      clear();
    },
  };
}

/** main.ts 接线：window focus/blur → 计时控制；enabled 读 store 最新设置。 */
export function bindAutoCollapse(store: {
  state: { settings: { autoCollapse: boolean } };
}): void {
  const ac = createAutoCollapse({
    enabled: () => store.state.settings.autoCollapse,
    onTimeout: () => collapseWindow().catch(() => undefined),
    timeoutMs: 60 * 1000,
  });
  window.addEventListener("blur", () => ac.handleBlur());
  window.addEventListener("focus", () => ac.handleFocus());
  window.addEventListener("pagehide", () => ac.stop());
}
