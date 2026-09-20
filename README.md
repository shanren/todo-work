# Todo — 轻量级桌面待办工具

一款 Windows / macOS 桌面常驻的轻量待办工具，基于 **Tauri 2 + Vanilla TypeScript + Rust** 构建。

- **轻** — 空闲内存占用小（收起态 < 20MB），安装包 < 15MB，冷启动 < 1s
- **快** — 开机静默自启，有当日待办时自动在桌面右上角弹出小窗
- **简** — 单栏列表式界面，3 秒内完成「看一眼 → 勾掉一项」
- **隐私** — 完全本地存储，无任何遥测，无云同步依赖

## 功能特性

- ✅ **待办管理** — 回车即添加、点击完成（划线 + 沉底动画）、行内编辑、拖拽排序，支持按到期时间 / 分类 / 创建时间一键切换排序
- 📌 **常驻形态** — 无标题栏自绘窗口（340px），可拖动并记住位置；收起为右上角小圆点角标（显示今日剩余数）；全屏应用自动隐藏、退出恢复
- 🏷️ **分类与颜色** — 自定义分类 + 颜色标签，快速辨识
- ⏰ **到期提醒** — 过期未完成项置顶「已过期」分组，红色弱化提示；失焦自动收起（时长可配置）
- 🔄 **主题切换** — 毛玻璃浅色 / 纸感浅色 / 毛玻璃深色，支持跟随系统
- 💾 **本地数据** — JSON 文件存储于系统应用数据目录（`%APPDATA%` / `~/Library/Application Support`），自动备份最近 5 份；数据目录缺失时自动重建
- 🚀 **开机自启** — 静默自启，不抢焦点（基于 `tauri-plugin-autostart`）

## 项目结构

```text
todo-work/
├── todo-app/          # 应用主体（Tauri 2 项目）
│   ├── src/           # 前端：Vanilla TS + Vite
│   ├── src-tauri/     # 桌面端：Rust（Tauri 2）
│   ├── docs/          # 截图、应用图标、检查清单
│   └── README.md      # 应用级说明
├── docs/              # 项目文档
│   ├── 需求细化-v1.md                    # 产品需求文档
│   └── superpowers/                      # 设计规格与实施计划
├── mockups/
│   └── style-samples.html              # 三种主题风格样例
└── README.md
```

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Vanilla TypeScript、Vite 8、Vitest 5 |
| 桌面端 | Tauri 2（Rust） |
| 插件 | `@tauri-apps/plugin-autostart`、`@tauri-apps/plugin-opener` |
| 目标平台 | Windows 10+ / macOS 12+ |

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/)（含 cargo）
- Windows：[WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 通常已内置）；macOS：Xcode Command Line Tools

### 开发

```bash
cd todo-app
npm install

# 仅启动前端（浏览器预览）
npm run dev

# 启动 Tauri 桌面应用（开发模式，热重载）
npm run tauri dev
```

### 构建发布包

```bash
cd todo-app
npm run tauri build
```

产物位于 `todo-app/src-tauri/target/release/bundle/`。

### 运行测试

```bash
cd todo-app
npx vitest run
```

## 文档

- [需求细化 v1](docs/需求细化-v1.md) — 产品定位、窗口形态、功能与非功能需求
- [设计规格](docs/superpowers/specs/) / [实施计划](docs/superpowers/plans/)
- [风格样例](mockups/style-samples.html) — 用浏览器打开即可预览三种主题
- 应用截图见 [todo-app/docs/screenshots/](todo-app/docs/screenshots/)

## 路线图

- **v1**（当前）— 待办管理、分类颜色、到期分组、主题切换、开机自启、本地存储
- **v1.1** — 快捷语法输入（`明天` `周五` `!高`）、数据导出/导入、提醒通知
- **v2（评估）** — 云同步

## License

MIT
