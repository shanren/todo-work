import { describe, it, expect, vi } from 'vitest';
import { buckets, sortTodos, Store } from './state';
import type { AppState, Todo } from './types';

const TODAY = '2026-09-17';

// 与 Rust store.rs serde camelCase 输出对齐的测试工厂
const todo = (o: Partial<Todo> = {}): Todo => ({
  id: 'x',
  title: 'x',
  categoryId: null,
  color: null,
  dueDate: null,
  dueTime: null,
  done: false,
  doneAt: null,
  createdAt: '2026-09-17T00:00:00Z',
  order: 0,
  ...o,
});

describe('buckets（与 Rust today.rs 规则一致）', () => {
  it('今天到期 → today', () => expect(buckets(todo({ dueDate: TODAY }), TODAY)).toBe('today'));
  it('无到期未完成 → today', () => expect(buckets(todo(), TODAY)).toBe('today'));
  it('昨天未完成 → overdue', () =>
    expect(buckets(todo({ dueDate: '2026-09-16' }), TODAY)).toBe('overdue'));
  it('明天未完成 → later', () =>
    expect(buckets(todo({ dueDate: '2026-09-18' }), TODAY)).toBe('later'));
  it('已完成 → done（无论到期日）', () =>
    expect(buckets(todo({ done: true, dueDate: '2026-09-16' }), TODAY)).toBe('done'));
  it('非法日期按无到期处理 → today', () =>
    expect(buckets(todo({ dueDate: '2026-13-40' }), TODAY)).toBe('today'));
});

describe('sortTodos（已完成项始终排最后）', () => {
  const list = [
    todo({ id: 'a', order: 2 }),
    todo({ id: 'b', order: 1 }),
    todo({ id: 'c', dueDate: '2026-09-16' }),
    todo({ id: 'd', done: true }),
  ];
  it('manual 按 order（计划原断言 b,a,c,d 自相矛盾：c 的 order=0 应排最前，已修正）', () =>
    expect(sortTodos(list, 'manual').map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']));
  it('due 按到期日（有到期在前）', () =>
    expect(sortTodos(list, 'due').map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']));
  it('category 按 categoryId，null 收件箱排最后', () => {
    const cats = [
      todo({ id: 'a', categoryId: 'c2', order: 1 }),
      todo({ id: 'b', categoryId: 'c1', order: 0 }),
      todo({ id: 'c', categoryId: null }),
      todo({ id: 'd', done: true }),
    ];
    expect(sortTodos(cats, 'category').map((t) => t.id)).toEqual(['b', 'a', 'c', 'd']);
  });
  it('created 按 createdAt', () => {
    const list2 = [
      todo({ id: 'a', createdAt: '2026-09-18T00:00:00Z' }),
      todo({ id: 'b', createdAt: '2026-09-16T00:00:00Z' }),
    ];
    expect(sortTodos(list2, 'created').map((t) => t.id)).toEqual(['b', 'a']);
  });
  it('不修改原数组', () => {
    const src = [todo({ id: 'a', order: 1 }), todo({ id: 'b', order: 0 })];
    sortTodos(src, 'manual');
    expect(src.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('Store（乐观更新 + 失败回滚，fake invoke）', () => {
  const emptyState = (): AppState => ({
    version: 1,
    categories: [],
    todos: [],
    settings: {
      theme: 'glass',
      width: 340,
      posX: null,
      posY: null,
      autoStart: true,
      sortMode: 'manual' as const,
      showOnBootOnlyToday: true,
    },
  });

  it('addTodo 成功：乐观插入后以服务端返回替换', async () => {
    const serverTodo = todo({ id: 't1', title: '新待办' });
    const invoke = vi.fn().mockResolvedValue(serverTodo);
    const store = new Store(invoke);
    store.state = emptyState();
    await store.addTodo('t1', '新待办', null, null, null);
    expect(store.state.todos.map((t) => t.id)).toEqual(['t1']);
    expect(store.state.todos[0].createdAt).toBe('2026-09-17T00:00:00Z'); // 服务端副本
    expect(invoke).toHaveBeenCalledWith('add_todo', {
      id: 't1', title: '新待办', categoryId: null, dueDate: null, dueTime: null,
    });
  });

  it('addTodo 失败：回滚到原状态且错误上抛', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('写入失败'));
    const store = new Store(invoke);
    store.state = emptyState();
    await expect(store.addTodo('t1', '新待办', null, null, null)).rejects.toThrow('写入失败');
    expect(store.state.todos).toHaveLength(0);
  });

  it('updateTodo patch 三态：undefined 不改、显式 null 清空（传输契约）', async () => {
    const updated = todo({ id: 't1', title: '原题', categoryId: null, dueDate: '2026-09-20' });
    const invoke = vi.fn().mockResolvedValue(updated);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(todo({ id: 't1', title: '原题', categoryId: 'c1' }));
    await store.updateTodo('t1', { dueDate: '2026-09-20', categoryId: null });
    const [, args] = invoke.mock.calls[0];
    // JSON.stringify 契约：undefined 字段被丢弃（=不改），null 保留（=清空）
    expect(JSON.parse(JSON.stringify(args.patch))).toEqual({
      dueDate: '2026-09-20',
      categoryId: null,
    });
    expect(store.state.todos[0].categoryId).toBeNull();
    expect(store.state.todos[0].dueDate).toBe('2026-09-20');
  });

  it('deleteCategory：分类移除且其下待办移入收件箱', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.categories.push({ id: 'c1', name: '工作', color: '#3b82f6', order: 0 });
    store.state.todos.push(todo({ id: 't1', categoryId: 'c1' }));
    await store.deleteCategory('c1');
    expect(store.state.categories).toHaveLength(0);
    expect(store.state.todos[0].categoryId).toBeNull();
    expect(invoke).toHaveBeenCalledWith('delete_category', { id: 'c1' });
  });

  it('deleteTodo 失败：回滚恢复原条目', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('删除失败'));
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(todo({ id: 't1' }));
    await expect(store.deleteTodo('t1')).rejects.toThrow('删除失败');
    expect(store.state.todos.map((t) => t.id)).toEqual(['t1']);
  });

  it('load：以服务端状态整体替换', async () => {
    const remote = emptyState();
    remote.todos.push(todo({ id: 't9' }));
    const invoke = vi.fn().mockResolvedValue(remote);
    const store = new Store(invoke);
    await store.load();
    expect(store.state.todos[0].id).toBe('t9');
    expect(invoke).toHaveBeenCalledWith('get_state');
  });

  it('reorder：按 ids 顺序重排 order', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const store = new Store(invoke);
    store.state = emptyState();
    store.state.todos.push(todo({ id: 'a', order: 0 }), todo({ id: 'b', order: 1 }));
    await store.reorder(['b', 'a']);
    expect(store.state.todos.find((t) => t.id === 'b')?.order).toBe(0);
    expect(store.state.todos.find((t) => t.id === 'a')?.order).toBe(1);
    expect(invoke).toHaveBeenCalledWith('reorder', { ids: ['b', 'a'] });
  });
});
