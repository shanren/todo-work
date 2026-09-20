// Tauri 运行时桥接：统一动态 import，测试环境（无 Tauri）不会在模块加载时触雷。
// 与 state.ts 的 realInvoke 同一隔离策略。

/** 收起窗口（Rust 侧销毁；无 hide 态） */
export async function collapseWindow(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("collapse");
}

/** 宽度三档切换（300/340/380），高度保持当前值 */
export async function resizeWindowTo(width: number): Promise<void> {
  const mod = await import("@tauri-apps/api/window");
  await mod.getCurrentWindow().setSize(new mod.LogicalSize(width, window.outerHeight));
}

/** 监听 Rust 事件（state-changed / focus-add / open-settings），返回取消函数 */
export function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return import("@tauri-apps/api/event").then((m) =>
    m.listen<T>(event, (e) => handler(e.payload)),
  );
}
