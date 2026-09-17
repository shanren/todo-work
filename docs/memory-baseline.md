# 内存基线记录

> 验收门禁：收起态 < 20MB；展开态 Windows < 80MB / macOS < 60MB（以 release 构建为准）
> 测量口径：**专用工作集（Private Working Set，任务管理器"内存"列同口径）**，跨进程共享 DLL 不重复计入。

## 测量数据（Windows 11 · release 构建 · 模板空页）

| 日期 | 构建 | 状态 | Rust 主进程 | WebView2 子进程 | 合计 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-17 | dev (debug) | 展开 | 51.0 MB | ~410 MB（6 进程） | ~461 MB | debug 符号 + Vite 热更新噪声，不作为验收依据 |
| 2026-09-17 | **release** | 展开 | 8.7 MB | 152 MB（6 进程：渲染器 92.2 / browser 35 / GPU 14.6 / utility 等 ~10） | **160.8 MB** | 验收基线 |
| 2026-09-17 | release + `--enable-low-end-device-mode` | 展开 | 8.7 MB | ~146 MB | **155.1 MB** | 仅省 6MB，收益边际 |

## 结论

1. **收起态（销毁窗口）预计 ~9MB**：Rust 主进程 8.7MB，WebView2 进程全部退出。门禁 <20MB ✅ 达成（Task 9 实测确认）。
2. **展开态 Windows ~155-161MB，超出 80MB 门禁**：渲染器 92MB 为 Chromium/WebView2 平台基线（空页面即如此），`--enable-low-end-device-mode` 与 wry `MemoryUsageLevel` API（0.55 已移除）均无法显著降低。该指标与 Electron 应用同受 Chromium 底层约束。
3. macOS 展开态目标 <60MB 待实机验证（WKWebView 为系统共享进程模型，基线显著更低）。
4. 补充优化手段：窗口隐藏时调用 WebView2 `ICoreWebView2_3::TrySuspend`（官方挂起 API，释放渲染缓存并暂停定时器）——已纳入 Task 9。

## 对比参考

- 滴答清单桌面版（Electron）：200-300MB 常驻
- 本应用：收起 ~9MB 常驻；展开仅在使用时存在
