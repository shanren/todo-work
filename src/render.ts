// 渲染层：从 AppState 全量重渲染（Spec §7，列表量级 <100 无需 diff）。
// 本任务（Task 6）只做静态渲染，事件绑定在 Task 7 扩展。
import { buckets, sortTodos, type Bucket } from "./state";
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
  if (todo.dueTime) {
    meta.append(h("span", "", todo.dueTime));
  }
  if (buckets(todo, today) === "overdue") {
    meta.append(h("span", "over", "已过期"));
  }
  if (meta.childNodes.length === 0) {
    return null;
  }
  return meta;
}

function itemEl(todo: Todo, state: AppState, today: string): HTMLElement {
  const item = h("div", `item${todo.done ? " done" : ""}`);
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
    const todos = groups.get(bucket);
    if (!todos || todos.length === 0) {
      continue;
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
