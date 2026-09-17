// 前端状态层：纯函数（分组/排序）+ Store（乐观更新、失败回滚）。
// 语义镜像 src-tauri/src/commands.rs 的 ops / patch_ops 模块，两侧规则必须保持一致。
import type { AppState, Category, Settings, SortMode, Todo } from "./types";

export type Bucket = "overdue" | "today" | "later" | "done";

/** 本地时区的 "YYYY-MM-DD"（勿用 toISOString：那是 UTC，会跑一天） */
export function localTodayISO(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 删除分类后的选中态回退：被删分类正被选中 → 回"全部"（null），否则保持 */
export function activeCategoryAfterDelete(
  active: string | null,
  deletedId: string,
): string | null {
  return active === deletedId ? null : active;
}

/** 严格校验 "YYYY-MM-DD"（Rust 侧 NaiveDate::parse_from_str 同样拒绝 2026-13-40 这类值） */
export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * 分组判定，规则与 Rust today.rs 完全一致：
 * - done 优先 → 'done'
 * - dueDate < today → 'overdue'；> today → 'later'；== today → 'today'
 * - dueDate 缺失或解析失败且未完成 → 'today'（无到期未完成视为"今日待清理"）
 */
export function buckets(todo: Todo, todayISO: string): Bucket {
  if (todo.done) return "done";
  if (todo.dueDate === null || !isValidISODate(todo.dueDate)) return "today";
  if (todo.dueDate < todayISO) return "overdue";
  if (todo.dueDate > todayISO) return "later";
  return "today";
}

/**
 * 排序。已完成项始终排最后（渲染层据此分组）。
 * - manual: 按 order
 * - due: 有到期在前（ISO 字符串比较），无到期在后，组内按 order
 * - category: 按 categoryId（null 收件箱排最后），组内按 order
 * - created: 按 createdAt
 * 返回新数组，不修改原数组。
 */
export function sortTodos(list: Todo[], mode: SortMode): Todo[] {
  const byOrder = (a: Todo, b: Todo) => a.order - b.order;
  const cmp: Record<SortMode, (a: Todo, b: Todo) => number> = {
    manual: byOrder,
    due: (a, b) => {
      if (a.dueDate !== null && b.dueDate !== null && a.dueDate !== b.dueDate) {
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      if (a.dueDate !== null && b.dueDate === null) return -1;
      if (a.dueDate === null && b.dueDate !== null) return 1;
      return byOrder(a, b);
    },
    category: (a, b) => {
      if (
        a.categoryId !== null &&
        b.categoryId !== null &&
        a.categoryId !== b.categoryId
      ) {
        return a.categoryId < b.categoryId ? -1 : 1;
      }
      if (a.categoryId !== null && b.categoryId === null) return -1;
      if (a.categoryId === null && b.categoryId !== null) return 1;
      return byOrder(a, b);
    },
    created: (a, b) => {
      if (a.createdAt !== b.createdAt)
        return a.createdAt < b.createdAt ? -1 : 1;
      return byOrder(a, b);
    },
  };
  const compare = cmp[mode];
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return compare(a, b);
  });
}

// ============================================================
// patch 三态契约（对齐 Rust TodoPatch / SettingsPatch）
// ============================================================

/**
 * 待办字段补丁，三态语义与 Rust `Option<Option<T>>` 对齐：
 * - 字段 undefined → 不修改（JSON.stringify 序列化时自动丢弃）
 * - 字段显式 null → 清空（移入收件箱、恢复继承色、清除到期日）
 * - 字段为值 → 设置为该值
 */
export interface TodoPatch {
  title?: string;
  categoryId?: string | null;
  color?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
}

/** 设置补丁（字段缺省 = 不改；posX/posY 为三态可清空）。 */
export interface SettingsPatch {
  theme?: Settings["theme"];
  width?: number;
  posX?: number | null;
  posY?: number | null;
  autoStart?: boolean;
  sortMode?: SortMode;
  showOnBootOnlyToday?: boolean;
}

/** 真实 IPC：动态 import 隔离，测试注入 fake 时不会触碰 Tauri 运行时。 */
async function realInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function emptyState(): AppState {
  return {
    version: 1,
    categories: [],
    todos: [],
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

/**
 * 前端状态镜像。所有变更方法：乐观更新本地 state → invoke → 失败回滚并上抛错误。
 * 真实来源始终是 Rust 侧 Mutex<State>；本对象仅是渲染用的最近副本。
 */
export class Store {
  state: AppState = emptyState();

  constructor(private invoke: InvokeFn = realInvoke) {}

  async load(): Promise<void> {
    this.state = await this.invoke<AppState>("get_state");
  }

  /** 乐观变更通用骨架：快照 → 本地变更 → invoke → 失败恢复快照并上抛 */
  private async mutate<R>(
    apply: (s: AppState) => R,
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<R> {
    const snapshot = structuredClone(this.state);
    const result = apply(this.state);
    try {
      await this.invoke(cmd, args);
      return result;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async addTodo(
    id: string,
    title: string,
    categoryId: string | null,
    dueDate: string | null,
    dueTime: string | null,
  ): Promise<Todo> {
    const snapshot = structuredClone(this.state);
    // 乐观插入本地副本（createdAt 先用本机时间，成功后以服务端副本替换）
    this.state.todos.push({
      id,
      title,
      categoryId,
      color: null,
      dueDate,
      dueTime,
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      order: this.state.todos.length,
    });
    try {
      const server = await this.invoke<Todo>("add_todo", {
        id,
        title,
        categoryId,
        dueDate,
        dueTime,
      });
      this.replaceTodo(server);
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async quickAdd(id: string, text: string): Promise<Todo> {
    const snapshot = structuredClone(this.state);
    // 乐观插入，仅走 quick_add 命令（与 add_todo 等价但语义专用，避免双写）
    this.state.todos.push({
      id,
      title: text,
      categoryId: null,
      color: null,
      dueDate: null,
      dueTime: null,
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      order: this.state.todos.length,
    });
    try {
      const server = await this.invoke<Todo>("quick_add", { id, text });
      this.replaceTodo(server);
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async toggleTodo(id: string): Promise<void> {
    await this.mutate(
      (s) => {
        const t = s.todos.find((x) => x.id === id);
        if (!t) throw new Error(`待办不存在: ${id}`);
        t.done = !t.done;
        t.doneAt = t.done ? new Date().toISOString() : null;
      },
      "toggle_todo",
      { id },
    );
  }

  async updateTodo(id: string, patch: TodoPatch): Promise<Todo> {
    const snapshot = structuredClone(this.state);
    const t = this.state.todos.find((x) => x.id === id);
    if (!t) throw new Error(`待办不存在: ${id}`);
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.categoryId !== undefined) t.categoryId = patch.categoryId;
    if (patch.color !== undefined) t.color = patch.color;
    if (patch.dueDate !== undefined) t.dueDate = patch.dueDate;
    if (patch.dueTime !== undefined) t.dueTime = patch.dueTime;
    try {
      const server = await this.invoke<Todo>("update_todo", { id, patch });
      this.replaceTodo(server);
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async deleteTodo(id: string): Promise<void> {
    await this.mutate(
      (s) => {
        s.todos = s.todos.filter((t) => t.id !== id);
      },
      "delete_todo",
      { id },
    );
  }

  async reorder(ids: string[]): Promise<void> {
    await this.mutate(
      (s) => {
        // 镜像 Rust ops::reorder：列出项按 ids 顺序，未列出项保持原相对顺序排尾
        const pos = new Map(ids.map((id, i) => [id, i]));
        const rest = s.todos
          .filter((t) => !pos.has(t.id))
          .sort((a, b) => a.order - b.order)
          .map((t) => t.id);
        const tail = new Map(rest.map((id, i) => [id, ids.length + i]));
        for (const t of s.todos) {
          if (pos.has(t.id)) t.order = pos.get(t.id)!;
          else if (tail.has(t.id)) t.order = tail.get(t.id)!;
        }
      },
      "reorder",
      { ids },
    );
  }

  async addCategory(
    id: string,
    name: string,
    color: string,
  ): Promise<Category> {
    const snapshot = structuredClone(this.state);
    const local: Category = {
      id,
      name,
      color,
      order: this.state.categories.length,
    };
    this.state.categories.push(local);
    try {
      const server = await this.invoke<Category>("add_category", {
        id,
        name,
        color,
      });
      const i = this.state.categories.findIndex((c) => c.id === id);
      if (i !== -1) this.state.categories[i] = server;
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async updateCategory(
    id: string,
    name?: string,
    color?: string,
  ): Promise<Category> {
    const snapshot = structuredClone(this.state);
    const c = this.state.categories.find((x) => x.id === id);
    if (!c) throw new Error(`分类不存在: ${id}`);
    if (name !== undefined) c.name = name;
    if (color !== undefined) c.color = color;
    try {
      const server = await this.invoke<Category>("update_category", {
        id,
        name,
        color,
      });
      const i = this.state.categories.findIndex((x) => x.id === id);
      if (i !== -1) this.state.categories[i] = server;
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    await this.mutate(
      (s) => {
        const before = s.categories.length;
        s.categories = s.categories.filter((c) => c.id !== id);
        if (s.categories.length === before)
          throw new Error(`分类不存在: ${id}`);
        // 镜像 Rust ops::delete_category：其下待办移入收件箱
        for (const t of s.todos) {
          if (t.categoryId === id) t.categoryId = null;
        }
      },
      "delete_category",
      { id },
    );
  }

  async setSettings(patch: SettingsPatch): Promise<Settings> {
    const snapshot = structuredClone(this.state);
    const s = this.state.settings;
    if (patch.theme !== undefined) s.theme = patch.theme;
    if (patch.width !== undefined) s.width = patch.width;
    if (patch.posX !== undefined) s.posX = patch.posX;
    if (patch.posY !== undefined) s.posY = patch.posY;
    if (patch.autoStart !== undefined) s.autoStart = patch.autoStart;
    if (patch.sortMode !== undefined) s.sortMode = patch.sortMode;
    if (patch.showOnBootOnlyToday !== undefined)
      s.showOnBootOnlyToday = patch.showOnBootOnlyToday;
    try {
      const server = await this.invoke<Settings>("set_settings", { patch });
      this.state.settings = server;
      return server;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  private replaceTodo(todo: Todo): void {
    const i = this.state.todos.findIndex((t) => t.id === todo.id);
    if (i !== -1) this.state.todos[i] = todo;
  }
}
