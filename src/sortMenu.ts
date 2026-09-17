// 排序菜单（Task 10）：头部 ⛶ 弹层。四模式互斥、当前项打勾，切换即持久化并重渲染。
// 拖拽联动：render.ts 仅在 manual 且未完成时设 draggable（Task 8），此处只改 sortMode。
import type { Store } from "./state";
import type { SortMode } from "./types";
import { openPopup } from "./render";

const SORT_OPTIONS: { value: SortMode; text: string }[] = [
  { value: "manual", text: "手动排序" },
  { value: "due", text: "按到期时间" },
  { value: "category", text: "按分类" },
  { value: "created", text: "按创建时间" },
];

/** ⛶ 排序菜单入口（头部按钮专用）。 */
export function openSortMenu(
  anchor: HTMLElement,
  store: Store,
  refresh: () => void,
): void {
  openPopup(anchor, (popup) => {
    popup.classList.add("popup-sort");
    const current = store.state.settings.sortMode;
    for (const o of SORT_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = o.value === current ? "popup-opt on" : "popup-opt";
      btn.textContent = o.value === current ? `✓ ${o.text}` : o.text;
      btn.addEventListener("click", () => {
        if (o.value === current) {
          return;
        }
        store.setSettings({ sortMode: o.value }).then(refresh).catch(refresh);
      });
      popup.append(btn);
    }
  });
}
