// 渲染层：从 AppState 全量重渲染（Spec §7，列表量级 <100 无需 diff）。
// Task 7：事件委托（勾选/删除/行内编辑）、toast 撤销、添加栏、日期 meta、
// 已完成组按 doneAt 倒序。Store 变更 → 单一 render() 重绘，输入框在 #list 之外故焦点不丢。
import { buckets, isValidISODate, sortTodos, type Bucket, type Store } from "./state";
import type { AppState, Category, Todo } from "./types";

// ============================================================
// 工具
// ============================================================

/** 本地时区的 "YYYY-MM-DD"（勿用 toISOString：那是 UTC，会跑一天） */
export function localTodayISO(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function h(tag: string, className?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function fmtHeaderDate(now: Date): { date: string; week: string } {
  return {
    date: `${now.getMonth() + 1}月${now.getDate()}日`,
    week: `星期${WEEKDAYS[now.getDay()]}`,
  };
}

function colorOf(todo: Todo, categories: Category[]): string {
  if (todo.color !== null) {
    return todo.color;
  }
  const cat = categories.find((c) => c.id === todo.categoryId);
  if (cat) {
    return cat.color;
  }
  return "";
}

/** 两个 ISO 日期相差天数（UTC 解析避免夏令时干扰） */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * 到期 meta 文案（Spec §6 / Task 7 要求 6）：
 * - 今天 + 时间 → "14:00"；今天无时间 → 不显示（已在"今天"组）
 * - 未来 6 天内 → "周六"；更远 → "9/20"；时间存在则拼在后面
 * - 过期未完成 → 红色 "昨天到期" / "n 天前"
 * - 已完成 / 无到期 / 非法日期 → null
 */
export function fmtDue(
  todo: Todo,
  today: string,
): { text: string; over: boolean } | null {
  if (todo.done || todo.dueDate === null || !isValidISODate(todo.dueDate)) {
    return null;
  }
  const time = todo.dueTime ? ` ${todo.dueTime}` : "";
  if (todo.dueDate < today) {
    const days = diffDays(today, todo.dueDate);
    return {
      text: `${days === 1 ? "昨天到期" : `${days} 天前`}${time}`,
      over: true,
    };
  }
  if (todo.dueDate === today) {
    return todo.dueTime ? { text: todo.dueTime, over: false } : null;
  }
  const days = diffDays(todo.dueDate, today);
  if (days <= 6) {
    return { text: `周${WEEKDAYS[weekdayOf(todo.dueDate)]}${time}`, over: false };
  }
  const [, m, d] = todo.dueDate.split("-").map(Number);
  return { text: `${m}/${d}${time}`, over: false };
}

// ============================================================
// 分组渲染
// ============================================================

const GROUP_LABELS: Record<Bucket, string> = {
  overdue: "已过期",
  today: "今天",
  later: "稍后",
  done: "已完成",
};

/** Spec §6 的分组顺序；空组不渲染 */
const GROUP_ORDER: Bucket[] = ["overdue", "today", "later", "done"];

function groupByBucket(todos: Todo[], today: string): Map<Bucket, Todo[]> {
  const groups = new Map<Bucket, Todo[]>();
  for (const t of todos) {
    const b = buckets(t, today);
    const list = groups.get(b);
    if (list) {
      list.push(t);
    } else {
      groups.set(b, [t]);
    }
  }
  return groups;
}

function renderHeader(now: Date): void {
  const { date, week } = fmtHeaderDate(now);
  const dateEl = document.querySelector<HTMLDivElement>("#date");
  if (!dateEl) {
    return;
  }
  dateEl.replaceChildren(document.createTextNode(date), h("span", "w-week", week));
}

function renderChips(state: AppState): void {
  const chipsEl = document.querySelector<HTMLElement>("#chips");
  if (!chipsEl) {
    return;
  }
  const chips: HTMLElement[] = [h("span", "chip on", "全部")];
  for (const c of state.categories) {
    const chip = h("span", "chip", c.name);
    const dot = h("span", "dot");
    dot.style.background = c.color;
    chip.prepend(dot);
    chips.push(chip);
  }
  chips.push(h("span", "chip", "＋"));
  chipsEl.replaceChildren(...chips);
}

function metaEl(todo: Todo, state: AppState, today: string): HTMLElement | null {
  const meta = h("div", "it-meta");
  const cat = state.categories.find((c) => c.id === todo.categoryId);
  if (cat) {
    meta.append(h("span", "", cat.name));
  }
  const due = fmtDue(todo, today);
  if (due) {
    meta.append(h("span", due.over ? "over" : "", due.text));
  }
  return meta.childNodes.length === 0 ? null : meta;
}

function itemEl(todo: Todo, state: AppState, today: string): HTMLElement {
  const item = h("div", `item${todo.done ? " done" : ""}`);
  item.dataset.id = todo.id;
  const bar = h("span", "bar");
  const color = colorOf(todo, state.categories);
  if (color) {
    bar.style.background = color;
  }
  const cb = h("span", "cb", "✓");
  const main = h("div", "it-main");
  main.append(h("div", "it-title", todo.title));
  const meta = metaEl(todo, state, today);
  if (meta) {
    main.append(meta);
  }
  const del = h("span", "it-del", "✕");
  item.append(bar, cb, main, del);
  return item;
}

function renderList(state: AppState, today: string): void {
  const listEl = document.querySelector<HTMLElement>("#list");
  if (!listEl) {
    return;
  }
  const sorted = sortTodos(state.todos, state.settings.sortMode);
  const groups = groupByBucket(sorted, today);
  const frag = document.createDocumentFragment();
  for (const bucket of GROUP_ORDER) {
    let todos = groups.get(bucket);
    if (!todos || todos.length === 0) {
      continue;
    }
    if (bucket === "done") {
      // 已完成组内按 doneAt 倒序（最近完成的在上）
      todos = [...todos].sort((a, b) =>
        (b.doneAt ?? "").localeCompare(a.doneAt ?? ""),
      );
    }
    frag.append(h("div", "sect-label", GROUP_LABELS[bucket]));
    const wrap = h("div", "items");
    for (const todo of todos) {
      wrap.append(itemEl(todo, state, today));
    }
    frag.append(wrap);
  }
  listEl.replaceChildren(frag);
}

function renderFooter(state: AppState, today: string): void {
  const active = state.todos.filter((t) => {
    const b = buckets(t, today);
    return b === "today" || b === "overdue";
  });
  const doneCount = active.filter((t) => t.done).length;
  const countEl = document.querySelector<HTMLSpanElement>("#foot-count");
  if (countEl) {
    countEl.textContent = `今日 ${doneCount}/${active.length}`;
  }
  const prog = document.querySelector<HTMLElement>("#prog-fill");
  if (prog) {
    const pct = active.length === 0 ? 0 : (doneCount / active.length) * 100;
    prog.style.width = `${pct}%`;
  }
}

export function render(state: AppState): void {
  const today = localTodayISO();
  renderHeader(new Date());
  renderChips(state);
  renderList(state, today);
  renderFooter(state, today);
}

// ============================================================
// 交互（Task 7）：事件委托统一绑定在 #list 上
// ============================================================

let editingId: string | null = null;
let toastTimer: number | undefined;

/** 当前添加栏归属的分类；chips 交互在 Task 8 接管此前恒为 null（"全部"） */
const activeCategoryId: string | null = null;

function hideToast(): void {
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer);
    toastTimer = undefined;
  }
  document.getElementById("toast")?.classList.remove("show");
}

/** 底部 toast；带撤销按钮时显示 5s 进度条淡出，新 toast 替换旧的 */
function showToast(text: string, onUndo?: () => void): void {
  const toast = document.getElementById("toast");
  if (!toast) {
    return;
  }
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer);
  }
  toast.replaceChildren(h("span", "", text));
  if (onUndo) {
    const bar = h("i", "toast-bar");
    toast.append(bar);
    const btn = h("button", "toast-undo", "撤销");
    btn.addEventListener("click", () => {
      hideToast();
      onUndo();
    });
    toast.append(btn);
    // 首帧后再触发 width 100%→0 的 5s 线性过渡（进度感）
    requestAnimationFrame(() => {
      bar.style.width = "0%";
    });
  }
  toast.classList.add("show");
  toastTimer = window.setTimeout(hideToast, 5000);
}

function startEdit(
  item: HTMLElement,
  todo: Todo,
  store: Store,
  refresh: () => void,
): void {
  if (editingId !== null) {
    return;
  }
  const titleEl = item.querySelector<HTMLElement>(".it-title");
  if (!titleEl) {
    return;
  }
  editingId = todo.id;
  const input = document.createElement("input");
  input.className = "it-edit";
  input.value = todo.title;
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const done = () => {
    finished = true;
    editingId = null;
  };
  const commit = () => {
    if (finished) {
      return;
    }
    const val = input.value.trim();
    done();
    // 空标题回退取消；未变更直接恢复
    if (val === "" || val === todo.title) {
      refresh();
      return;
    }
    store
      .updateTodo(todo.id, { title: val })
      .then(refresh)
      .catch(refresh);
  };
  const cancel = () => {
    if (finished) {
      return;
    }
    done();
    refresh();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
}

/** 删除 + 撤销：撤销用原始字段 addTodo 重建，再 reorder 恢复原位次 */
function onDelete(
  todo: Todo,
  store: Store,
  refresh: () => void,
): void {
  const orig: Todo = { ...todo };
  store
    .deleteTodo(todo.id)
    .then(() => {
      refresh();
      showToast("已删除", () => {
        const newId = crypto.randomUUID();
        store
          .addTodo(newId, orig.title, orig.categoryId, orig.dueDate, orig.dueTime)
          .then(() => {
            // 已完成项重建后为未完成态（add_todo 不接受 done），且不参与未完成排序
            if (orig.done) {
              return Promise.resolve();
            }
            const undone = store.state.todos
              .filter((t) => !t.done)
              .sort((a, b) => a.order - b.order);
            const ids = undone.map((t) => t.id);
            ids.splice(ids.indexOf(newId), 1);
            const rank = undone.filter(
              (t) => t.id !== newId && t.order < orig.order,
            ).length;
            ids.splice(rank, 0, newId);
            return store.reorder(ids);
          })
          .then(refresh)
          .catch(refresh);
      });
    })
    .catch(refresh);
}

function onToggle(
  item: HTMLElement,
  todo: Todo,
  store: Store,
  refresh: () => void,
): void {
  // 立即划线变灰（乐观视觉），300ms 后重渲染沉入"已完成"组
  item.classList.toggle("done", !todo.done);
  store
    .toggleTodo(todo.id)
    .then(() => {
      window.setTimeout(refresh, 300);
    })
    .catch(refresh);
}

function bindListEvents(store: Store, refresh: () => void): void {
  const list = document.getElementById("list");
  if (!list) {
    return;
  }
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>(".item");
    if (!item || !item.dataset.id) {
      return;
    }
    const todo = store.state.todos.find((t) => t.id === item.dataset.id);
    if (!todo) {
      return;
    }
    if (target.closest(".cb")) {
      onToggle(item, todo, store, refresh);
      return;
    }
    if (target.closest(".it-del")) {
      onDelete(todo, store, refresh);
      return;
    }
    if (target.closest(".it-title")) {
      startEdit(item, todo, store, refresh);
    }
  });
}

function bindAddBar(store: Store, refresh: () => void): void {
  const addInput = document.querySelector<HTMLInputElement>("#add-input");
  if (!addInput) {
    return;
  }
  addInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") {
      return;
    }
    const title = addInput.value.trim();
    if (title === "") {
      return;
    }
    store
      .addTodo(crypto.randomUUID(), title, activeCategoryId, null, null)
      .then(() => {
        addInput.value = "";
        refresh();
      })
      .catch(refresh);
  });
}

/** 装配交互与首渲染。main.ts 在状态加载完成后调用一次。 */
export function initApp(store: Store): void {
  const refresh = () => {
    render(store.state);
  };
  bindListEvents(store, refresh);
  bindAddBar(store, refresh);
  render(store.state);
}

// ============================================================
// 开发样例数据（仅 ?demo=1 时用于主题观感验证，不落盘、不进生产路径）
// ============================================================

export function demoState(): AppState {
  const today = localTodayISO();
  const yest = new Date(Date.now() - 86400000);
  const yestISO = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  const t = (
    id: string,
    title: string,
    categoryId: string | null,
    dueDate: string | null,
    dueTime: string | null,
    done = false,
  ): Todo => ({
    id,
    title,
    categoryId,
    color: null,
    dueDate,
    dueTime,
    done,
    doneAt: done ? "2026-09-17T01:00:00Z" : null,
    createdAt: "2026-09-17T00:00:00Z",
    order: 0,
  });
  return {
    version: 1,
    categories: [
      { id: "c1", name: "工作", color: "#3b82f6", order: 0 },
      { id: "c2", name: "生活", color: "#f59e0b", order: 1 },
      { id: "c3", name: "学习", color: "#10b981", order: 2 },
    ],
    todos: [
      t("t1", "回复合作方的邮件", "c1", yestISO, null),
      t("t2", "整理季度汇报大纲", "c1", today, "14:00"),
      t("t3", "阅读《设计心理学》第 3 章", "c3", today, null),
      t("t4", "晨间跑步 30 分钟", "c2", today, null, true),
      t("t5", "规划周末出行", "c2", "2026-09-19", null),
    ],
    settings: {
      theme: "glass",
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      sortMode: "manual",
      showOnBootOnlyToday: true,
    },
  };
}
