// 设置面板（Task 11 重做）：卡片式行布局 + 分段按钮 + 拟物开关。
// 全部样式只消费 CSS 变量（themes.css），三主题下成立。
import type { Store } from "./state";
import type { ThemeMode } from "./types";
import { applyTheme } from "./themes";
import { resizeWindowTo } from "./bridge";
import { openPopup } from "./render";

/** 一行：左标签 + 右控件区。 */
function row(popup: HTMLElement, label: string): { ctrl: HTMLDivElement } {
  const el = document.createElement("div");
  el.className = "set-row";
  const l = document.createElement("span");
  l.className = "set-label";
  l.textContent = label;
  const ctrl = document.createElement("div");
  ctrl.className = "set-ctrl";
  el.append(l, ctrl);
  popup.append(el);
  return { ctrl };
}

/** 分段按钮组（单选，选中即回调）。 */
function segmented<T extends string | number>(
  ctrl: HTMLDivElement,
  options: { value: T; text: string }[],
  current: T,
  onPick: (v: T) => void,
): void {
  const seg = document.createElement("div");
  seg.className = "seg";
  for (const o of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = o.value === current ? "seg-opt on" : "seg-opt";
    btn.textContent = o.text;
    btn.addEventListener("click", () => {
      seg
        .querySelectorAll(".seg-opt")
        .forEach((el) => el.classList.remove("on"));
      btn.classList.add("on");
      onPick(o.value);
    });
    seg.append(btn);
  }
  ctrl.append(seg);
}

/** 拟物 toggle 开关。 */
function toggle(
  ctrl: HTMLDivElement,
  label: string,
  current: boolean,
  onToggle: (v: boolean) => void,
): void {
  const wrap = document.createElement("label");
  wrap.className = "switch-wrap";
  const text = document.createElement("span");
  text.className = "switch-text";
  text.textContent = label;
  const sw = document.createElement("span");
  sw.className = current ? "switch on" : "switch";
  const knob = document.createElement("span");
  knob.className = "switch-knob";
  sw.append(knob);
  sw.addEventListener("click", (e) => {
    e.preventDefault();
    current = !current;
    sw.classList.toggle("on", current);
    onToggle(current);
  });
  wrap.append(text, sw);
  ctrl.append(wrap);
}

/** ⚙ 设置面板入口（头部按钮与 open-settings 事件共用）。 */
export function openSettingsPanel(
  anchor: HTMLElement,
  store: Store,
  refresh: () => void,
): void {
  openPopup(anchor, (popup, close) => {
    popup.classList.add("popup-settings");
    const s = store.state.settings;

    // 头部：标题 + ✕
    const head = document.createElement("div");
    head.className = "set-head";
    const title = document.createElement("span");
    title.textContent = "设置";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "set-close";
    x.textContent = "✕";
    x.addEventListener("click", () => close());
    head.append(title, x);
    popup.append(head);

    segmented<ThemeMode>(
      row(popup, "主题").ctrl,
      [
        { value: "system", text: "系统" },
        { value: "glass", text: "毛玻璃" },
        { value: "paper", text: "纸感" },
        { value: "dark", text: "暗夜" },
      ],
      s.theme,
      (theme) => {
        store
          .setSettings({ theme })
          .then((st) => {
            applyTheme(st.theme);
            refresh();
          })
          .catch(refresh);
      },
    );

    segmented<number>(
      row(popup, "宽度").ctrl,
      [
        { value: 300, text: "紧凑" },
        { value: 340, text: "标准" },
        { value: 380, text: "宽松" },
      ],
      s.width,
      (width) => {
        store
          .setSettings({ width })
          .then(() => resizeWindowTo(width).catch(refresh))
          .then(refresh)
          .catch(refresh);
      },
    );

    toggle(row(popup, "开机自启").ctrl, "登录时静默启动", s.autoStart, (v) => {
      store.setSettings({ autoStart: v }).then(refresh).catch(refresh);
    });

    toggle(
      row(popup, "失焦自动收起").ctrl,
      "失焦 1 分钟后收起到托盘",
      s.autoCollapse,
      (v) => {
        store.setSettings({ autoCollapse: v }).then(refresh).catch(refresh);
      },
    );
  });
}
