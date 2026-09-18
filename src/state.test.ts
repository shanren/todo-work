import { describe, it, expect, vi } from "vitest";
import {
  activeCategoryAfterDelete,
  buckets,
  isDoneToday,
  nextSaturdayISO,
  sortTodos,
  Store,
} from "./state";
import { reorderAfterDrop } from "./drag";
import { fmtDue } from "./render";
import type { AppState, Todo } from "./types";

const TODAY = "2026-09-17";

// 与 Rust store.rs serde camelCase 输出对齐的测试工厂
const todo = (o: Partial<Todo> = {}): Todo => ({
  id: "x",
  title: "x",
  categoryId: null,
  color: null,
  dueDate: null,
  dueTime: null,
  done: false,
  doneAt: null,
  createdAt: "2026-09-17T00:00:00Z",
  order: 0,
  ...o,
});

describe("buckets（与 Rust today.rs 规则一致）", () => {
  it("今天到期 → today", () =>
    expect(buckets(todo({ dueDate: TODAY }), TODAY)).toBe("today"));
  it("无到期未完成 → today", () =>
    expect(buckets(todo(), TODAY)).toBe("today"));
  it("昨天未完成 → overdue", () =>
    expect(buckets(todo({ dueDate: "2026-09-16" }), TODAY)).toBe("overdue"));
  it("明天未完成 → later", () =>
    expect(buckets(todo({ dueDate: "2026-09-18" }), TODAY)).toBe("later"));
  it("已完成 → done（无论到期日）", () =>
    expect(buckets(todo({ done: true, dueDate: "2026-09-16" }), TODAY)).toBe(
      "done",
    ));
  it("非法日期按无到期处理 → today", () =>
    expect(buckets(todo({ dueDate: "2026-13-40" }), TODAY)).toBe("today"));
});

describe("sortTodos（已完成项始终排最后）", () => {
  const list = [
    todo({ id: "a", order: 2 }),
    todo({ id: "b", order: 1 }),
    todo({ id: "c", dueDate: "2026-09-16" }),
    todo({ id: "d", done: true }),
  ];
  it("manual 按 order（计划原断言 b,a,c,d 自相矛盾：c 的 order=0 应排最前，已修正）", () =>
    expect(sortTodos(list, "manual").map((t) => t.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]));
  it("due 按到期日（有到期在前）", () =>
    expect(sortTodos(list, "due").map((t) => t.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]));
  it("category 按 categoryId，null 收件箱排最后", () => {
    const cats = [
      todo({ id: "a", categoryId: "c2", order: 1 }),
      todo({ id: "b", categoryId: "c1", order: 0 }),
      todo({ id: "c", categoryId: null }),
      todo({ id: "d", done: true }),
    ];
    expect(sortTodos(cats, "category").map((t) => t.id)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
  it("created 按 createdAt", () => {
    const list2 = [
      todo({ id: "a", createdAt: "2026-09-18T00:00:00Z" }),
      todo({ id: "b", createdAt: "2026-09-16T00:00:00Z" }),
    ];
    expect(sortTodos(list2, "created").map((t) => t.id)).toEqual(["b", "a"]);
  });
  it("不修改原数组", () => {
    const src = [todo({ id: "a", order: 1 }), todo({ id: "b", order: 0 })];
    sortTodos(src, "manual");
    expect(src.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("Store（乐观更新 + 失败回滚，fake invoke）", () => {
  const emptyState = (): AppState => ({
    version: 1,
    categories: [],
    todos: [],
    settings: {
      theme: "glass",
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      autoCollapse: false,
      sortMode: "manual" as const,
      showOnBootOnlyToday: true,
    },
  });

  it("addTodo 成功：乐观插入后以服务端返回替换", async () => {
    const serverTodo = todo({ id: "t1", title: "新待办" });
    const invoke = vi.fn().mockResolvedValue(serverTodo);
    const store = new Store(invoke);
    store.state = emptyState();
    await store.addTodo("t1", "新待办", null, null, null);
    expect(store.state.todos.map((t) => t.id)).toEqual(["t1"]);
    expect(store.state.todos[0].createdAt).toBe("2026-09-17T00:00:00Z"); // 服务端副本
    expect(invoke).toHaveBeenCalledWith("add_todo", {
      id: "t1",
      title: "新待办",
      categoryId: null,
      dueDate: null,
      dueTime: null,
    });
  });

  it("addTodo 失败：回滚到原状态且错误上抛", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("写入失败"));
    const store = new Store(invoke);
    store.state = emptyState();
    await expect(
      store.addTodo("t1", "新待办", null, null, null),
    ).rejects.toThrow("写入失败");
    expect(store.state.todos).toHaveLength(0);
  });

  it("updateTodo patch 三态：undefined 不改、显式 null 清空（传输契约）", async () => {
    const updated = todo({
      id: "t1",
      title: "原题",
      categoryId: null,
      dueDate: "2026-09-20",
    });
    const invoke = vi.fn().mockResolvedValue(updated);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(todo({ id: "t1", title: "原题", categoryId: "c1" }));
    await store.updateTodo("t1", { dueDate: "2026-09-20", categoryId: null });
    const [, args] = invoke.mock.calls[0];
    // JSON.stringify 契约：undefined 字段被丢弃（=不改），null 保留（=清空）
    expect(JSON.parse(JSON.stringify(args.patch))).toEqual({
      dueDate: "2026-09-20",
      categoryId: null,
    });
    expect(store.state.todos[0].categoryId).toBeNull();
    expect(store.state.todos[0].dueDate).toBe("2026-09-20");
  });

  it("deleteCategory：分类移除且其下待办移入收件箱", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.categories.push({
      id: "c1",
      name: "工作",
      color: "#3b82f6",
      order: 0,
    });
    store.state.todos.push(todo({ id: "t1", categoryId: "c1" }));
    await store.deleteCategory("c1");
    expect(store.state.categories).toHaveLength(0);
    expect(store.state.todos[0].categoryId).toBeNull();
    expect(invoke).toHaveBeenCalledWith("delete_category", { id: "c1" });
  });

  it("deleteTodo 失败：回滚恢复原条目", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("删除失败"));
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(todo({ id: "t1" }));
    await expect(store.deleteTodo("t1")).rejects.toThrow("删除失败");
    expect(store.state.todos.map((t) => t.id)).toEqual(["t1"]);
  });

  it("load：以服务端状态整体替换", async () => {
    const remote = emptyState();
    remote.todos.push(todo({ id: "t9" }));
    const invoke = vi.fn().mockResolvedValue(remote);
    const store = new Store(invoke);
    await store.load();
    expect(store.state.todos[0].id).toBe("t9");
    expect(invoke).toHaveBeenCalledWith("get_state");
  });

  it("reorder：按 ids 顺序重排 order", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(
      todo({ id: "a", order: 0 }),
      todo({ id: "b", order: 1 }),
    );
    await store.reorder(["b", "a"]);
    expect(store.state.todos.find((t) => t.id === "b")?.order).toBe(0);
    expect(store.state.todos.find((t) => t.id === "a")?.order).toBe(1);
    expect(invoke).toHaveBeenCalledWith("reorder", { ids: ["b", "a"] });
  });
});

describe("toggleTodo（Task 7：doneAt 记录与清空）", () => {
  // 模块级空状态（Store describe 内的 emptyState 局部于此不可见）
  const blankState = (): AppState => ({
    version: 1,
    categories: [],
    todos: [],
    settings: {
      theme: "glass",
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      autoCollapse: false,
      sortMode: "manual" as const,
      showOnBootOnlyToday: true,
    },
  });

  it("完成后 doneAt 记录时刻，取消后清空为 null", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const store = new Store(invoke);
    store.state = blankState();
    store.state.todos.push(todo({ id: "t1" }));
    await store.toggleTodo("t1");
    expect(store.state.todos[0].done).toBe(true);
    expect(store.state.todos[0].doneAt).not.toBeNull();
    await store.toggleTodo("t1");
    expect(store.state.todos[0].done).toBe(false);
    expect(store.state.todos[0].doneAt).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(1, "toggle_todo", { id: "t1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "toggle_todo", { id: "t1" });
  });
});

describe("删除撤销字段保真（Task 7，镜像 render.ts onDelete 撤销流程）", () => {
  const blankState = (): AppState => ({
    version: 1,
    categories: [],
    todos: [],
    settings: {
      theme: "glass",
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      autoCollapse: false,
      sortMode: "manual" as const,
      showOnBootOnlyToday: true,
    },
  });

  const fakeAdd = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "add_todo") {
      const a = args as {
        id: string;
        title: string;
        categoryId: string | null;
        dueDate: string | null;
        dueTime: string | null;
      };
      // Rust 侧 order = todos.len()，前端随后 reorder 校正，故 999 无碍
      return todo({
        id: a.id,
        title: a.title,
        categoryId: a.categoryId,
        dueDate: a.dueDate,
        dueTime: a.dueTime,
        order: 999,
      });
    }
    return undefined;
  };

  it("撤销重建：字段全部保真，reorder 恢复原位次（中部）", async () => {
    const store = new Store(vi.fn().mockImplementation(fakeAdd));
    store.state = blankState();
    store.state.todos.push(
      todo({ id: "t0", title: "更早", order: 0 }),
      todo({
        id: "t1",
        title: "被删项",
        categoryId: "c1",
        dueDate: "2026-09-17",
        dueTime: "14:00",
        order: 1,
      }),
      todo({ id: "t2", title: "更晚", order: 2 }),
    );
    await store.deleteTodo("t1");
    expect(store.state.todos.map((t) => t.id)).toEqual(["t0", "t2"]);

    const orig = {
      title: "被删项",
      categoryId: "c1",
      dueDate: "2026-09-17",
      dueTime: "14:00",
      order: 1,
    };
    const newId = "rebuild-1";
    await store.addTodo(
      newId,
      orig.title,
      orig.categoryId,
      orig.dueDate,
      orig.dueTime,
    );
    const undone = store.state.todos
      .filter((t) => !t.done)
      .sort((a, b) => a.order - b.order);
    const ids = undone.map((t) => t.id);
    ids.splice(ids.indexOf(newId), 1);
    const rank = undone.filter(
      (t) => t.id !== newId && t.order < orig.order,
    ).length;
    ids.splice(rank, 0, newId);
    await store.reorder(ids);

    const rebuilt = store.state.todos.find((t) => t.id === newId)!;
    expect(rebuilt.title).toBe("被删项");
    expect(rebuilt.categoryId).toBe("c1");
    expect(rebuilt.dueDate).toBe("2026-09-17");
    expect(rebuilt.dueTime).toBe("14:00");
    expect(rebuilt.order).toBe(1);
    expect(
      store.state.todos
        .filter((t) => !t.done)
        .sort((a, b) => a.order - b.order)
        .map((t) => t.id),
    ).toEqual(["t0", newId, "t2"]);
  });

  it("撤销重建：被删项在首位时恢复到首位", async () => {
    const store = new Store(vi.fn().mockImplementation(fakeAdd));
    store.state = blankState();
    store.state.todos.push(
      todo({ id: "t0", order: 0 }),
      todo({ id: "t1", order: 1 }),
    );
    await store.deleteTodo("t0");
    const orig = {
      title: "x",
      categoryId: null,
      dueDate: null,
      dueTime: null,
      order: 0,
    };
    const newId = "rebuild-2";
    await store.addTodo(
      newId,
      orig.title,
      orig.categoryId,
      orig.dueDate,
      orig.dueTime,
    );
    const undone = store.state.todos
      .filter((t) => !t.done)
      .sort((a, b) => a.order - b.order);
    const ids = undone.map((t) => t.id);
    ids.splice(ids.indexOf(newId), 1);
    const rank = undone.filter(
      (t) => t.id !== newId && t.order < orig.order,
    ).length;
    ids.splice(rank, 0, newId);
    await store.reorder(ids);
    expect(store.state.todos.find((t) => t.id === newId)?.order).toBe(0);
  });
});

describe("fmtDue（Task 7：日期 meta 文案；2026-09-17 为周四）", () => {
  const T0 = "2026-09-17";
  it("今天 + 时间 → 14:00", () =>
    expect(fmtDue(todo({ dueDate: T0, dueTime: "14:00" }), T0)).toEqual({
      text: "14:00",
      over: false,
    }));
  it("今天无时间 → null（已在今天组）", () =>
    expect(fmtDue(todo({ dueDate: T0 }), T0)).toBeNull());
  it("昨天 → 红色 昨天到期", () =>
    expect(fmtDue(todo({ dueDate: "2026-09-16" }), T0)).toEqual({
      text: "昨天到期",
      over: true,
    }));
  it("3 天前 → n 天前", () =>
    expect(fmtDue(todo({ dueDate: "2026-09-14" }), T0)).toEqual({
      text: "3 天前",
      over: true,
    }));
  it("两天后 → 周六", () =>
    expect(fmtDue(todo({ dueDate: "2026-09-19" }), T0)).toEqual({
      text: "周六",
      over: false,
    }));
  it("10 天后 → 9/27", () =>
    expect(fmtDue(todo({ dueDate: "2026-09-27" }), T0)).toEqual({
      text: "9/27",
      over: false,
    }));
  it("已完成 → null", () =>
    expect(fmtDue(todo({ dueDate: "2026-09-16", done: true }), T0)).toBeNull());
});

describe("activeCategoryAfterDelete（Task 8：删除分类后的选中态回退）", () => {
  it("删除正在选中的分类 → 回全部(null)", () =>
    expect(activeCategoryAfterDelete("c1", "c1")).toBe(null));
  it("删除未选中的分类 → 保持选中", () =>
    expect(activeCategoryAfterDelete("c2", "c1")).toBe("c2"));
  it("当前未选中(null) → 保持 null", () =>
    expect(activeCategoryAfterDelete(null, "c1")).toBe(null));
});

describe("reorderAfterDrop（Task 8：拖拽落点后的未完成全表顺序）", () => {
  const state = (): AppState => ({
    version: 1,
    categories: [],
    todos: [
      todo({ id: "o1", dueDate: "2026-09-16", order: 0 }),
      todo({ id: "t1", order: 1 }),
      todo({ id: "t2", order: 2 }),
      todo({ id: "l1", dueDate: "2026-09-18", order: 3 }),
      todo({ id: "d1", done: true, order: 4 }),
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
  });

  it("today 组内：t2 拖到 t1 上方 → t2 在前，其余组与已完成不受影响", () => {
    const ids = reorderAfterDrop(state(), TODAY, "t2", "t1", "above");
    expect(ids).toEqual(["o1", "t2", "t1", "l1"]);
  });

  it("below 语义：t1 拖到 t2 下方 → t2 在前", () => {
    const ids = reorderAfterDrop(state(), TODAY, "t1", "t2", "below");
    expect(ids).toEqual(["o1", "t2", "t1", "l1"]);
  });

  it("同组内拖回原位 → 顺序不变（回归：原位放置不乱序）", () => {
    const ids = reorderAfterDrop(state(), TODAY, "t1", "t2", "above");
    expect(ids).toEqual(["o1", "t1", "t2", "l1"]);
  });
});

describe("setSettings（Task 9：autoCollapse 持久化透传）", () => {
  it("autoCollapse 透传到 set_settings 并更新本地镜像", async () => {
    const server = {
      theme: "glass",
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      autoCollapse: true,
      sortMode: "manual",
      showOnBootOnlyToday: true,
    } as AppState["settings"];
    const invoke = vi.fn().mockResolvedValue(server);
    const store = new Store(invoke);
    store.state = {
      version: 1,
      categories: [],
      todos: [],
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
    const st = await store.setSettings({ autoCollapse: true });
    expect(st.autoCollapse).toBe(true);
    expect(store.state.settings.autoCollapse).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { autoCollapse: true },
    });
  });

  it("sortMode 切换：透传 set_settings、本地镜像更新且镜像排序结果随模式变化", async () => {
    const invoke = vi.fn().mockImplementation(async (_cmd, args) => ({
      ...baseSettings(),
      ...args.patch,
    }));
    const store = new Store(invoke);
    store.state = {
      version: 1,
      categories: [],
      todos: [
        todo({ id: "a", order: 1 }),
        todo({ id: "b", dueDate: "2026-09-16", order: 0 }),
      ],
      settings: baseSettings(),
    };
    const st = await store.setSettings({ sortMode: "due" });
    expect(st.sortMode).toBe("due");
    expect(store.state.settings.sortMode).toBe("due");
    expect(invoke).toHaveBeenCalledWith("set_settings", {
      patch: { sortMode: "due" },
    });
    // 切到 due 后：昨天到期项排到 manual 首位（order 1）之前
    expect(sortTodos(store.state.todos, "due").map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
  });
});

function baseSettings(): AppState["settings"] {
  return {
    theme: "glass",
    width: 340,
    posX: null,
    posY: null,
    autoStart: true,
    autoCollapse: false,
    sortMode: "manual",
    showOnBootOnlyToday: true,
  };
}

describe("nextSaturdayISO（本周末快捷项）", () => {
  it("周三 → 本周六", () =>
    expect(nextSaturdayISO("2026-09-16")).toBe("2026-09-19"));
  it("周六当天 → 当天", () =>
    expect(nextSaturdayISO("2026-09-19")).toBe("2026-09-19"));
  it("周日 → 下周六", () =>
    expect(nextSaturdayISO("2026-09-20")).toBe("2026-09-26"));
});

describe("isDoneToday（主列表只显示今日完成）", () => {
  it("今天完成 → true", () =>
    expect(isDoneToday(todo({ done: true, doneAt: "2026-09-17T10:00:00Z" }), TODAY)).toBe(true));
  it("昨天完成 → false（进历史）", () =>
    expect(isDoneToday(todo({ done: true, doneAt: "2026-09-16T10:00:00Z" }), TODAY)).toBe(false));
  it("doneAt 缺失 → false", () =>
    expect(isDoneToday(todo({ done: true }), TODAY)).toBe(false));
  it("未完成 → false", () =>
    expect(isDoneToday(todo({ done: false, doneAt: "2026-09-17T10:00:00Z" }), TODAY)).toBe(false));
});
