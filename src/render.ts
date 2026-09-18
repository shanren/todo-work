// 渲染层：从 AppState 全量重渲染（Spec §7，列表量级 <100 无需 diff）。
// Task 7：事件委托（勾选/删除/行内编辑）、toast 撤销、添加栏、日期 meta、
// 已完成组按 doneAt 倒序。Store 变更 → 单一 render() 重绘，输入框在 #list 之外故焦点不丢。
import {
  activeCategoryAfterDelete,
  buckets,
  isDoneToday,
  isValidISODate,
  localTodayISO,
  nextSaturdayISO,
  sortTodos,
  type Bucket,
  type Store,
} from "./state";
import type { AppState, Category, Todo } from "./types";
import { bindDragAndDrop } from "./drag";
import { collapseWindow, listenEvent } from "./bridge";
import { openSettingsPanel } from "./settings";

// localTodayISO 已收编至 state.ts（drag.ts 亦需使用）；此处保留导出兼容旧引用
export { localTodayISO };

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
  return Math.round(
    (Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000,
  );
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
    return {
      text: `周${WEEKDAYS[weekdayOf(todo.dueDate)]}${time}`,
      over: false,
    };
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
  dateEl.replaceChildren(
    document.createTextNode(date),
    h("span", "w-week", week),
  );
}

/** Task 8 预设色板（8 色：红/橙/黄/绿/青/蓝/紫/灰，见任务书与需求 §3.3） */
const CATEGORY_PALETTE = [
  "#e5484d",
  "#f59e0b",
  "#facc15",
  "#34c759",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#8e8e93",
] as const;

function renderChips(state: AppState): void {
  const chipsEl = document.querySelector<HTMLElement>("#chips");
  if (!chipsEl) {
    return;
  }
  const chips: HTMLElement[] = [];
  // "全部"：dataset.catId 为空串（falsy → activeCategoryId = null）
  const all = h("span", activeCategoryId === null ? "chip on" : "chip", "全部");
  all.dataset.catId = "";
  chips.push(all);
  for (const c of state.categories) {
    const chip = h(
      "span",
      activeCategoryId === c.id ? "chip on" : "chip",
      c.name,
    );
    chip.dataset.catId = c.id;
    chip.title = "右键：重命名 / 换色 / 删除";
    const dot = h("span", "dot");
    dot.style.background = c.color;
    chip.prepend(dot);
    chips.push(chip);
  }
  const add = h("span", "chip", "＋");
  add.id = "chip-add";
  chips.push(add);
  chipsEl.replaceChildren(...chips);
}

function metaEl(
  todo: Todo,
  state: AppState,
  today: string,
): HTMLElement | null {
  const meta = h("div", "it-meta");
  const cat = state.categories.find((c) => c.id === todo.categoryId);
  if (cat) {
    meta.append(h("span", "", cat.name));
  }
  // 日期控件：有日期显示摘要，无日期 hover 显示「＋日」；点击弹出日期面板修改/清除
  if (!todo.done) {
    const due = fmtDue(todo, today);
    let cls = "it-due it-due-none";
    let text = "＋日";
    if (due) {
      cls = due.over ? "it-due over" : "it-due";
      text = due.text;
    }
    const el = h("span", cls, text);
    el.title = "点击修改到期日";
    meta.append(el);
  }
  return meta.childNodes.length === 0 ? null : meta;
}

function itemEl(todo: Todo, state: AppState, today: string): HTMLElement {
  const item = h("div", `item${todo.done ? " done" : ""}`);
  item.dataset.id = todo.id;
  // 拖拽仅限 manual 模式且未完成（done/非 manual 不可拖）
  if (state.settings.sortMode === "manual" && !todo.done) {
    item.draggable = true;
  }
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
  // Task 8：chips 过滤（"全部" = 不过滤）
  const visible = activeCategoryId
    ? state.todos.filter((t) => t.categoryId === activeCategoryId)
    : state.todos;
  const sorted = sortTodos(visible, state.settings.sortMode);
  const groups = groupByBucket(sorted, today);
  const frag = document.createDocumentFragment();
  for (const bucket of GROUP_ORDER) {
    let todos = groups.get(bucket);
    if (!todos || todos.length === 0) {
      continue;
    }
    if (bucket === "done") {
      // 主列表只显示今日完成的；更早的进历史视图（头部 🕘）
      todos = todos.filter((t) => isDoneToday(t, today));
      if (todos.length === 0) {
        continue;
      }
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
  if (frag.childNodes.length === 0) {
    frag.append(
      h(
        "div",
        "empty-hint",
        activeCategoryId ? "此分类暂无待办" : "暂无待办，从下方添加",
      ),
    );
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

/** 已完成历史视图：按完成日期倒序分组；条目可取消完成（回到主列表）或删除。 */
function renderHistory(state: AppState, today: string): void {
  const listEl = document.querySelector<HTMLElement>("#list");
  const chipsEl = document.querySelector<HTMLElement>("#chips");
  const addWrap = document.querySelector<HTMLElement>(".add-wrap");
  if (chipsEl) {
    chipsEl.style.display = "none";
  }
  if (addWrap) {
    addWrap.style.display = "none";
  }
  if (!listEl) {
    return;
  }
  const frag = document.createDocumentFragment();

  // 视图头：返回 + 标题
  const head = h("div", "hist-head");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "hist-back";
  back.textContent = "← 返回";
  back.addEventListener("click", () => {
    view = "main";
    render(state);
  });
  head.append(back, h("span", "hist-title", "已完成历史"));
  frag.append(head);

  // 已完成（全部，含今日），按 doneAt 日期倒序分组
  const done = state.todos
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  if (done.length === 0) {
    frag.append(h("div", "empty-hint", "还没有已完成记录"));
  } else {
    let lastDate = "";
    let wrap: HTMLElement | null = null;
    for (const t of done) {
      const day = (t.doneAt ?? "").slice(0, 10);
      if (day !== lastDate) {
        lastDate = day;
        frag.append(h("div", "sect-label", histDayLabel(day, today)));
        wrap = h("div", "items");
        frag.append(wrap);
      }
      wrap?.append(itemEl(t, state, today));
    }
  }
  listEl.replaceChildren(frag);

  const countEl = document.querySelector<HTMLSpanElement>("#foot-count");
  if (countEl) {
    countEl.textContent = `历史 ${done.length} 条`;
  }
  const prog = document.querySelector<HTMLElement>("#prog-fill");
  if (prog) {
    prog.style.width = "0%";
  }
}

/** 历史分组标签：今天 / 昨天 / 9月15日 */
function histDayLabel(day: string, today: string): string {
  if (day === today) {
    return "今天";
  }
  const [, m, d] = day.split("-").map(Number);
  const prev = new Date();
  prev.setDate(prev.getDate() - 1);
  const py = prev.getFullYear();
  const pm = String(prev.getMonth() + 1).padStart(2, "0");
  const pd = String(prev.getDate()).padStart(2, "0");
  if (day === `${py}-${pm}-${pd}`) {
    return "昨天";
  }
  return `${m}月${d}日`;
}

export function render(state: AppState): void {
  const today = localTodayISO();
  renderHeader(new Date());
  if (view === "history") {
    renderHistory(state, today);
    return;
  }
  renderChips(state);
  renderList(state, today);
  renderFooter(state, today);
}

// ============================================================
// 交互（Task 7）：事件委托统一绑定在 #list 上
// ============================================================

let editingId: string | null = null;
let toastTimer: number | undefined;

/** 当前选中的分类（chips 过滤 + 添加栏归属）；null = "全部" */
let activeCategoryId: string | null = null;

/** 当前视图：main = 待办主列表；history = 已完成历史（头条 🕘 切换） */
let view: "main" | "history" = "main";

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
    store.updateTodo(todo.id, { title: val }).then(refresh).catch(refresh);
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
function onDelete(todo: Todo, store: Store, refresh: () => void): void {
  const orig: Todo = { ...todo };
  store
    .deleteTodo(todo.id)
    .then(() => {
      refresh();
      showToast("已删除", () => {
        const newId = crypto.randomUUID();
        store
          .addTodo(
            newId,
            orig.title,
            orig.categoryId,
            orig.dueDate,
            orig.dueTime,
          )
          .then(() => {
            // 已完成项重建后需恢复完成态（add_todo 不接受 done，补一次 toggle）
            const restored: Promise<unknown> = orig.done
              ? store.toggleTodo(newId).then(() => undefined)
              : Promise.resolve();
            return restored.then(() => {
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
            });
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
    if (target.closest(".it-due")) {
      openDatePopup(target as HTMLElement, todo.dueDate, (v) => {
        store.updateTodo(todo.id, { dueDate: v }).then(refresh).catch(refresh);
      });
      return;
    }
    if (target.closest(".it-title")) {
      startEdit(item, todo, store, refresh);
    }
  });
}

// ============================================================
// Task 8：分类 chips 与弹层（添加/重命名/换色/删除确认）
// ============================================================

let popupEl: HTMLElement | null = null;
let popupCleanup: (() => void) | null = null;

function closePopup(): void {
  popupCleanup?.();
  popupCleanup = null;
  popupEl?.remove();
  popupEl = null;
}

/** 弹层单例：构建内容 → 定位到锚点下方（放不下则上方）→ 外部点击/Esc 关闭（settings.ts 复用） */
export function openPopup(
  anchor: HTMLElement,
  build: (popup: HTMLElement, close: () => void) => void,
): void {
  closePopup();
  const popup = h("div", "popup");
  document.body.append(popup);
  popupEl = popup;
  build(popup, closePopup);
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - popup.offsetWidth - 8);
  if (left < 8) {
    left = 8;
  }
  let top = r.bottom + 6;
  if (top + popup.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, r.top - popup.offsetHeight - 6);
  }
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  const closer = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest(".popup")) {
      closePopup();
    }
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // 阻断同一文档上后续的 Esc 监听（bindCollapseControls 的收起）
      e.stopImmediatePropagation();
      closePopup();
    }
  };
  document.addEventListener("click", closer, true);
  document.addEventListener("keydown", esc, true);
  popupCleanup = () => {
    document.removeEventListener("click", closer, true);
    document.removeEventListener("keydown", esc, true);
  };
}

function paletteEl(
  selected: string,
  onPick: (color: string) => void,
): HTMLElement {
  const wrap = h("div", "swatches");
  for (const c of CATEGORY_PALETTE) {
    const s = h("button", c === selected ? "swatch sel" : "swatch");
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener("click", () => onPick(c));
    wrap.append(s);
  }
  return wrap;
}

/** 「＋」添加分类面板：名称输入 + 色板单选（默认蓝）+ 创建 */
function openAddPopup(
  anchor: HTMLElement,
  store: Store,
  refresh: () => void,
): void {
  openPopup(anchor, (popup, close) => {
    const input = document.createElement("input");
    input.className = "popup-input";
    input.placeholder = "分类名称";
    let color: string = CATEGORY_PALETTE[5];
    const sw = paletteEl(color, (c) => {
      color = c;
      for (const el of popup.querySelectorAll<HTMLElement>(".swatch")) {
        el.classList.toggle("sel", el.dataset.color === c);
      }
    });
    const ok = h("button", "popup-ok", "创建");
    const commit = () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      store
        .addCategory(crypto.randomUUID(), name, color)
        .then(() => {
          close();
          refresh();
        })
        .catch(refresh);
    };
    ok.addEventListener("click", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    popup.append(input, sw, ok);
    input.focus();
  });
}

/** chip 右键菜单：重命名 / 换色 / 删除（确认后其下待办移入收件箱） */
function openCategoryMenu(
  anchor: HTMLElement,
  cat: Category,
  store: Store,
  refresh: () => void,
): void {
  openPopup(anchor, (popup, close) => {
    const count = store.state.todos.filter(
      (t) => t.categoryId === cat.id,
    ).length;
    const item = (label: string, fn: () => void, danger = false) => {
      const b = h("button", danger ? "menu-item danger" : "menu-item", label);
      b.addEventListener("click", () => {
        close();
        fn();
      });
      return b;
    };
    const rename = () => {
      openPopup(anchor, (p2, close2) => {
        const input = document.createElement("input");
        input.className = "popup-input";
        input.value = cat.name;
        const commit = () => {
          const name = input.value.trim();
          if (!name || name === cat.name) {
            close2();
            refresh();
            return;
          }
          store
            .updateCategory(cat.id, name)
            .then(() => {
              close2();
              refresh();
            })
            .catch(refresh);
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        });
        p2.append(input);
        input.focus();
        input.select();
      });
    };
    const recolor = () => {
      openPopup(anchor, (p2, close2) => {
        p2.append(
          paletteEl(cat.color, (c) => {
            store
              .updateCategory(cat.id, undefined, c)
              .then(() => {
                close2();
                refresh();
              })
              .catch(refresh);
          }),
        );
      });
    };
    const del = () => {
      openPopup(anchor, (p2, close2) => {
        p2.append(
          h(
            "div",
            "popup-text",
            `删除分类"${cat.name}"？其下 ${count} 条待办将移入收件箱`,
          ),
        );
        const row = h("div", "popup-row");
        const no = h("button", "popup-ok", "取消");
        const yes = h("button", "popup-ok danger", "删除");
        no.addEventListener("click", () => close2());
        yes.addEventListener("click", () => {
          store
            .deleteCategory(cat.id)
            .then(() => {
              // 被删分类正在选中 → 回"全部"（纯逻辑见 state.activeCategoryAfterDelete）
              activeCategoryId = activeCategoryAfterDelete(
                activeCategoryId,
                cat.id,
              );
              close2();
              refresh();
            })
            .catch(refresh);
        });
        row.append(no, yes);
        p2.append(row);
      });
    };
    popup.append(
      item("重命名", rename),
      item("换色", recolor),
      item("删除", del, true),
    );
  });
}

/** chips 交互：点击过滤 / ＋ 新建 / 右键菜单（事件委托，重渲染不丢） */
function bindChips(store: Store, refresh: () => void): void {
  const chipsEl = document.getElementById("chips");
  if (!chipsEl) {
    return;
  }
  chipsEl.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!chip) {
      return;
    }
    if (chip.id === "chip-add") {
      if (popupEl) {
        closePopup();
      } else {
        openAddPopup(chip, store, refresh);
      }
      return;
    }
    closePopup();
    activeCategoryId = chip.dataset.catId ? chip.dataset.catId : null;
    refresh();
  });
  chipsEl.addEventListener("contextmenu", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!chip || !chip.dataset.catId) {
      return;
    }
    e.preventDefault();
    const cat = store.state.categories.find((c) => c.id === chip.dataset.catId);
    if (cat) {
      openCategoryMenu(chip, cat, store, refresh);
    }
  });
}

/** 添加栏当前选中的到期日（null = 无日期）。选中后面板摘要显示在触发钮上。 */
let selectedDueDate: string | null = null;

/** 日期摘要：今天 / 明天 / M/D。 */
function tomorrowISO(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dueLabel(iso: string): string {
  const today = localTodayISO();
  if (iso === today) {
    return "今天";
  }
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() - 1);
  const ty = t.getFullYear();
  const tm = String(t.getMonth() + 1).padStart(2, "0");
  const td = String(t.getDate()).padStart(2, "0");
  if (`${ty}-${tm}-${td}` === today) {
    return "明天";
  }
  return `${m}/${d}`;
}

/** 日期选择面板（添加栏与条目修改共用）：无日期/今天/明天/本周末/自定义。 */
function openDatePopup(
  anchor: HTMLElement,
  current: string | null,
  onPick: (iso: string | null) => void,
): void {
  if (popupEl) {
    closePopup();
    return;
  }
  openPopup(anchor, (popup, close) => {
    popup.classList.add("popup-date");
    const opts: { text: string; value: string | null }[] = [
      { text: "无日期", value: null },
      { text: "今天", value: localTodayISO() },
      { text: "明天", value: tomorrowISO() },
      { text: "本周末", value: nextSaturdayISO(localTodayISO()) },
    ];
    for (const o of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item";
      b.textContent = o.text;
      b.addEventListener("click", () => {
        onPick(o.value);
        close();
      });
      popup.append(b);
    }
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "menu-item";
    custom.textContent = "自定义…";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "date-native";
    if (current) {
      dateInput.value = current;
    }
    custom.addEventListener("click", () => {
      custom.replaceWith(dateInput);
      dateInput.focus();
    });
    dateInput.addEventListener("change", () => {
      if (dateInput.value && isValidISODate(dateInput.value)) {
        onPick(dateInput.value);
      }
      close();
    });
    popup.append(custom);
  });
}

function bindAddBar(store: Store, refresh: () => void): void {
  const addInput = document.querySelector<HTMLInputElement>("#add-input");
  const dateBtn = document.querySelector<HTMLButtonElement>("#btn-date");
  const dateLabel = document.querySelector<HTMLSpanElement>("#date-label");
  if (!addInput || !dateBtn) {
    return;
  }
  const setDateLabel = (v: string | null): void => {
    if (dateLabel) {
      dateLabel.textContent = v === null ? "" : dueLabel(v);
    }
  };
  dateBtn.addEventListener("click", () => {
    openDatePopup(dateBtn, selectedDueDate, (v) => {
      selectedDueDate = v;
      setDateLabel(v);
    });
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") {
      return;
    }
    const title = addInput.value.trim();
    if (title === "") {
      return;
    }
    store
      .addTodo(
        crypto.randomUUID(),
        title,
        activeCategoryId,
        selectedDueDate,
        null,
      )
      .then(() => {
        addInput.value = "";
        selectedDueDate = null;
        setDateLabel(null);
        refresh();
      })
      .catch(() => {
        // 不再静默：落盘失败（如磁盘/权限问题）时明确告知，本地回滚已由 Store 完成
        showToast("添加失败：数据写入失败");
        refresh();
      });
  });
}

/** 装配交互与首渲染。main.ts 在状态加载完成后调用一次。 */
/** 收起控制：Esc / 页脚「收起」/ 头部「—」。头部其余区域是拖动区，不触发收起。 */
function bindCollapseControls(): void {
  const doCollapse = () => {
    collapseWindow().catch(() => undefined);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      doCollapse();
    }
  });
  document
    .getElementById("btn-collapse")
    ?.addEventListener("click", doCollapse);
  document
    .getElementById("btn-collapse-top")
    ?.addEventListener("click", doCollapse);
}

/** Rust 事件：state-changed（托盘/重建后同步）、focus-add、open-settings */
function bindRuntimeEvents(store: Store, refresh: () => void): void {
  void listenEvent("state-changed", () => {
    store
      .load()
      .then(refresh)
      .catch(() => undefined);
  });
  void listenEvent("focus-add", () => {
    document.getElementById("add-input")?.focus();
  });
  void listenEvent("open-settings", () => {
    const anchor = document.getElementById("btn-settings");
    if (anchor) {
      openSettingsPanel(anchor, store, refresh);
    }
  });
}

export function initApp(store: Store): void {
  const refresh = () => {
    render(store.state);
  };
  bindChips(store, refresh);
  bindListEvents(store, refresh);
  bindAddBar(store, refresh);
  bindDragAndDrop(store, refresh);
  bindCollapseControls();
  bindRuntimeEvents(store, refresh);
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    const anchor = document.getElementById("btn-settings");
    if (anchor) {
      openSettingsPanel(anchor, store, refresh);
    }
  });
  // 禁用 WebView 默认右键菜单（刷新/检查等）；chips 的自定义右键菜单在捕获前已自行 preventDefault 并打开
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // 已完成历史视图切换（🕘）；进入历史时若分类过滤开着则先回"全部"
  document.getElementById("btn-history")?.addEventListener("click", () => {
    view = view === "history" ? "main" : "history";
    if (view === "history") {
      activeCategoryId = null;
    }
    render(store.state);
  });
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
      autoCollapse: false,
      sortMode: "manual",
      showOnBootOnlyToday: true,
    },
  };
}
