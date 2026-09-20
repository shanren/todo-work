// Task 8：条目拖拽排序（HTML5 DnD，事件委托在 #list 上，渲染层无需重复绑定）。
// 规则（任务书 4）：
// - 仅未完成条目可拖（draggable 由 render.ts 在 manual 模式且未完成时设置）
// - 仅同组内放置（overdue/today/later；done 组不可拖入，跨组一律忽略）
// - 松手后按组序 overdue → today → later 重建未完成全表顺序，整表提交 reorder
import {
  buckets,
  localTodayISO,
  sortTodos,
  type Bucket,
  type Store,
} from "./state";
import type { AppState } from "./types";

const GROUP_ORDER: Bucket[] = ["overdue", "today", "later"];

let draggedId: string | null = null;
let target: { id: string; pos: "above" | "below" } | null = null;

function clearIndicator(): void {
  document
    .querySelectorAll(".item.drop-above, .item.drop-below")
    .forEach((el) => el.classList.remove("drop-above", "drop-below"));
}

/**
 * 拖拽落点后的未完成全表新顺序（纯函数，可测）。
 * 未完成项按组序排列；先移除被拖项，再按 above/below 插到目标前/后。
 */
export function reorderAfterDrop(
  state: AppState,
  today: string,
  draggedId: string,
  targetId: string,
  pos: "above" | "below",
): string[] {
  const groups = new Map<Bucket, string[]>(GROUP_ORDER.map((b) => [b, []]));
  for (const t of sortTodos(
    state.todos.filter((x) => !x.done),
    "manual",
  )) {
    groups.get(buckets(t, today))!.push(t.id);
  }
  const seq = GROUP_ORDER.flatMap((b) => groups.get(b)!);
  seq.splice(seq.indexOf(draggedId), 1);
  let to = seq.indexOf(targetId);
  if (pos === "below") to += 1;
  seq.splice(to, 0, draggedId);
  return seq;
}

export function bindDragAndDrop(store: Store, refresh: () => void): void {
  const list = document.getElementById("list");
  if (!list) {
    return;
  }

  list.addEventListener("dragstart", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".item");
    if (!item?.dataset.id) {
      return;
    }
    draggedId = item.dataset.id;
    item.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", draggedId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
    }
  });

  list.addEventListener("dragend", () => {
    document.querySelector(".item.dragging")?.classList.remove("dragging");
    draggedId = null;
    target = null;
    clearIndicator();
  });

  list.addEventListener("dragover", (e) => {
    if (!draggedId) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>(".item");
    const todo = item?.dataset.id
      ? store.state.todos.find((x) => x.id === item.dataset.id)
      : undefined;
    const dragged = store.state.todos.find((x) => x.id === draggedId);
    // 仅同组未完成条目之间允许放置（today 判定用于跨组过滤）
    if (
      !item ||
      !todo ||
      !dragged ||
      todo.done ||
      buckets(todo, localTodayISO()) !== buckets(dragged, localTodayISO())
    ) {
      target = null;
      clearIndicator();
      return;
    }
    const rect = item.getBoundingClientRect();
    const pos: "above" | "below" =
      e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    if (!target || target.id !== todo.id || target.pos !== pos) {
      clearIndicator();
      item.classList.add(pos === "above" ? "drop-above" : "drop-below");
    }
    target = { id: todo.id, pos };
  });

  list.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!draggedId || !target) {
      draggedId = null;
      target = null;
      clearIndicator();
      return;
    }
    const { id: targetId, pos } = target;
    const ids = reorderAfterDrop(
      store.state,
      localTodayISO(),
      draggedId,
      targetId,
      pos,
    );
    draggedId = null;
    target = null;
    clearIndicator();
    store.reorder(ids).then(refresh).catch(refresh);
  });
}
