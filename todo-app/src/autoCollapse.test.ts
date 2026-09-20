// 失焦自动收起计时逻辑（fake timers，无真实等待）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoCollapse } from "./autoCollapse";

const FIVE_MIN = 5 * 60 * 1000;

describe("createAutoCollapse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("开启时失焦满 5 分钟触发一次收起", () => {
    const onTimeout = vi.fn();
    const ac = createAutoCollapse({
      enabled: () => true,
      onTimeout,
      timeoutMs: FIVE_MIN,
    });
    ac.handleBlur();
    vi.advanceTimersByTime(FIVE_MIN - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // 不重复触发（单次计时器）
    vi.advanceTimersByTime(FIVE_MIN);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("超时前重新聚焦则取消计时", () => {
    const onTimeout = vi.fn();
    const ac = createAutoCollapse({
      enabled: () => true,
      onTimeout,
      timeoutMs: FIVE_MIN,
    });
    ac.handleBlur();
    vi.advanceTimersByTime(FIVE_MIN - 1000);
    ac.handleFocus();
    vi.advanceTimersByTime(FIVE_MIN);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("开关关闭时失焦不计时", () => {
    const onTimeout = vi.fn();
    let on = false;
    const ac = createAutoCollapse({
      enabled: () => on,
      onTimeout,
      timeoutMs: FIVE_MIN,
    });
    ac.handleBlur();
    vi.advanceTimersByTime(FIVE_MIN);
    expect(onTimeout).not.toHaveBeenCalled();
    // 运行中打开开关：下一次失焦才生效
    on = true;
    ac.handleBlur();
    vi.advanceTimersByTime(FIVE_MIN);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
