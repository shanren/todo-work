// 与 src-tauri/src/store.rs 的 serde camelCase 输出逐字段对齐（Spec §3 store.json 结构）。
// Rust 侧 Option<T> → TS `T | null`；勿在本文件引入任何运行时逻辑。

/** glass | paper | dark | system（Spec §6 主题系统） */
export type ThemeMode = "glass" | "paper" | "dark" | "system";

/** manual | due | category | created（Spec §3 settings.sortMode） */
export type SortMode = "manual" | "due" | "category" | "created";

export interface Todo {
  /** 前端 crypto.randomUUID() 生成，Rust 侧不生成 */
  id: string;
  title: string;
  /** null = 收件箱 */
  categoryId: string | null;
  /** null = 继承分类色；覆盖则存 "#hex" */
  color: string | null;
  /** null = 无到期，格式 "YYYY-MM-DD" */
  dueDate: string | null;
  /** null = 全天，格式 "HH:MM" */
  dueTime: string | null;
  done: boolean;
  /** 完成时刻（RFC3339），取消完成时清空为 null */
  doneAt: string | null;
  createdAt: string;
  /** 手动排序键 */
  order: number;
}

export interface Category {
  id: string;
  name: string;
  /** "#hex" */
  color: string;
  order: number;
}

export interface Settings {
  theme: ThemeMode;
  /** 300 | 340 | 380 */
  width: number;
  /** null = 默认右上角 16px */
  posX: number | null;
  posY: number | null;
  autoStart: boolean;
  /** 失焦自动收起开关 */
  autoCollapse: boolean;
  /** 失焦自动收起延时（分钟），1–120 */
  autoCollapseMinutes: number;
  sortMode: SortMode;
  showOnBootOnlyToday: boolean;
}

export interface AppState {
  version: number;
  categories: Category[];
  todos: Todo[];
  settings: Settings;
}
