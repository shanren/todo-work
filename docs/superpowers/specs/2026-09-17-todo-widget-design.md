# 轻量桌面 Todo 小窗 — 设计定稿（Spec）

> 日期：2026-09-17 · 状态：已确认 · 需求来源：`docs/需求细化-v1.md` · 样例：`mockups/style-samples.html`

## 1. 目标

Windows / macOS 桌面常驻的轻量待办小窗：开机自启、当日有待办则显示于右上角、三主题切换、空闲内存展开态 Windows < 80MB / macOS < 60MB、收起态 < 20MB、安装包 < 15MB。

## 2. 技术栈

- Tauri 2（Rust 后端 + 系统 WebView 前端）
- 前端：**纯原生 TypeScript，无框架、无构建期依赖到 web 字体**（Vite 仅做 TS 编译与打包）
- 持久化：单 JSON 文件 + 滚动备份（保留最近 5 份）
- 插件：`tauri-plugin-autostart`、`tauri-plugin-single-instance`；托盘用 Tauri 内置 tray
- 测试：Rust 侧 `cargo test`；前端逻辑模块用 Vitest；UI 手动验收清单

## 3. 数据模型（`store.json`）

```jsonc
{
  "version": 1,
  "categories": [
    { "id": "c1", "name": "工作", "color": "#3b82f6", "order": 0 }
  ],
  "todos": [
    {
      "id": "t1",
      "title": "整理季度汇报大纲",
      "categoryId": "c1",          // null = 收件箱
      "color": null,                // null = 继承分类色；覆盖则存 "#hex"
      "dueDate": "2026-09-17",      // null = 无到期
      "dueTime": "14:00",           // null = 全天
      "done": false,
      "doneAt": null,
      "createdAt": "2026-09-17T08:00:00Z",
      "order": 0
    }
  ],
  "settings": {
    "theme": "glass",               // glass | paper | dark | system
    "width": 340,                    // 300 | 340 | 380
    "posX": null, "posY": null,      // null = 默认右上角 16px
    "autoStart": true,
    "sortMode": "manual",            // manual | due | category | created
    "showOnBootOnlyToday": true
  }
}
```

- ID 生成：前端 `crypto.randomUUID()`，Rust 侧不生成
- 写盘策略：任何变更后 debounce 500ms 原子写（写临时文件 → rename）；每日首写前滚动备份 `store.json.1..5`

## 4. 今日判定逻辑（Rust 侧，`today.rs`）

`is_today(todo, local_date)`：`dueDate == today`，或 `dueDate == null && done == false`（无到期的未完成视为"今日待清理"）→ 开机判断用它。

补充：`dueDate < today && !done` → 归入"已过期"分组。

> 注：此逻辑必须 Rust 单测覆盖（今天/明天/昨天/无到期/已完成 5 例）。

## 5. 窗口生命周期

```text
开机自启(静默) → 启动
  ├─ 存在今日待办 → 创建/显示主窗（右上角）
  └─ 无 → 仅托盘
收起（Esc / 点头部 / 点"收起"）→ 销毁 WebView 窗口 → 托盘角标显示剩余数
唤起（托盘点击 / 全局快捷键 v1.1）→ 重建窗口（状态从 Rust 内存恢复）
托盘菜单：显示/隐藏 · 快速添加 · 设置 · 开机自启 ✓ · 退出
```

- 主窗：340×自适应，`decorations: false`，`transparent: true`（毛玻璃主题需要），`skipTaskbar: true`
- 数据常驻 Rust 侧内存（`Mutex<State>`），窗口销毁不丢状态 —— 这是收起态 <20MB 的关键
- 全屏检测：v1 简化为"失焦 5 分钟自动收起"（可关），真·全屏前台检测放 v1.1

## 6. UI 结构（与样例一致）

```text
┌ 头部：日期 + 星期 ｜ ⚙ ⛶ ┐
│ 分类 chips：全部 · 工作 · 生活 · … · ＋ │
│ 分组标签：已过期 / 今天 / 已完成          │
│ 条目：色条 + 圆形checkbox + 标题 + meta ｜ hover ✕ │
│ 底部：＋ 添加待办，回车确认               │
└ 页脚：今日 n/m · 进度条 · 收起 ▸ ┘
```

### 主题系统（CSS 变量，`themes.css`）

`:root[data-theme="glass|paper|dark"]` 三组变量：`--bg --bg-blur --border --text --muted --accent --chip-bg --chip-on`。切换只改 `data-theme` 属性；`system` 由前端 matchMedia 监听映射为 glass/dark。三套主题共用全部结构样式，仅变量不同。

### 交互细节

- 完成：勾选 → 划线变灰 → 300ms 后移动到"已完成"组；再点恢复原位置
- 删除：hover 显示 ✕ → 删除 → 底部 toast"已删除 · 撤销"(5s)
- 编辑：单击标题行内编辑（input 替换文本，Enter 保存 / Esc 取消）
- 拖拽：HTML5 drag & drop，同组内重排 `order`，manual 模式下生效
- 排序切换：头部 ⛶ 菜单（手动/按到期/按分类/按创建）

## 7. 模块划分

**Rust（`src-tauri/src/`）**

| 模块 | 职责 |
| --- | --- |
| `main.rs` | 入口：加载状态 → 启动判定 → 建窗/托盘；注册命令 |
| `store.rs` | State 结构体、加载/原子保存/滚动备份、Mutex 管理 |
| `today.rs` | 今日/过期判定（纯函数，单测） |
| `commands.rs` | IPC 命令层（见 §8），薄封装调用 store |

**前端（`src/`）**

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 启动：拉取状态 → 渲染 → 绑定事件 |
| `state.ts` | 前端状态镜像 + 变更后调 IPC + debounce 持久化信号 |
| `render.ts` | 全量重渲染（列表 <100 条，无需 diff） |
| `themes.ts` | 主题应用与 system 监听 |
| `drag.ts` | 拖拽排序 |
| `types.ts` | 与 Rust 对齐的 TS 类型 |

## 8. IPC 命令（Tauri command 签名）

```rust
get_state() -> State
add_todo(id, title, categoryId, dueDate, dueTime) -> Todo   // id 由前端 crypto.randomUUID() 生成
 toggle_todo(id) -> Todo
update_todo(id, patch: TodoPatch) -> Todo   // TodoPatch 三态：缺省=不改 / null=清空 / 有值=设置（title/categoryId/color/dueDate/dueTime）
delete_todo(id) -> ()
reorder(ids: Vec<String>) -> ()             // 拖拽后整表提交顺序；未列出项按原相对顺序排尾
add_category(id, name, color) -> Category
update_category(id, name: Option<String>, color: Option<String>) -> Category  // 重命名/换色为独立操作
delete_category(id) -> ()                   // 其下待办 categoryId 置 null
set_settings(patch) -> Settings
quick_add(id, text) -> Todo                 // 托盘快速添加（v1 仅标题，语法解析 v1.1）
```

> 实现注记（Task 4）：变更逻辑在 `commands.rs::ops` 纯函数模块（接受 `&mut State`，可脱离 Tauri 单测），命令封装只做 lock → 变更 → 落盘。

## 9. 错误处理

- JSON 损坏：启动时检测 → 用最近备份恢复 → 都损坏则空状态启动并 toast 提示
- 写盘失败：内存保留变更，下次变更重试；托盘气泡提示一次
- WebView 崩溃：窗口自动重建（Tauri `on_window_event` → recreate），状态无损

## 10. 内存预算落实（验收门禁）

1. 无框架、无 web 字体、DOM 节点 < 200
2. 收起 = 销毁窗口，仅 Rust 进程（实测 8.7MB）
3. 「隐藏/收起」一律**销毁窗口**（无 hide 态）：托盘与 Esc/收起按钮同路径；重建窗口 ~100ms 可接受；wry 的 MemoryUsageLevel API 与 WebView2 TrySuspend 均不需要（已审查决定，Task 9 实现）
4. M1 完成时实测：任务管理器（专用工作集口径）记录展开态与收起态数值，写入 `docs/memory-baseline.md`，超标则先优化再进 M2

> 实测修订（2026-09-17）：Windows 展开态 WebView2 平台基线 ~155-161MB（空页即 92MB 渲染器），80MB 门禁不可达；已提请修订为：收起态 <20MB（达成）、Windows 展开态 ≤170MB、macOS 展开态 <60MB（待实机验证）

## 11. 测试策略

- Rust：`today.rs` 5 例、store 读写/备份/损坏恢复用 `tempdir` 单测
- 前端：`state.ts`（增删改查排序纯逻辑）、主题映射用 Vitest；渲染与拖拽走手动清单（样例 HTML 已验证观感）
- 手动验收清单：`docs/manual-checklist.md`（M3 后执行）
