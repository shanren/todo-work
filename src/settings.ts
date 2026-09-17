// 设置面板（Task 9）：⚙ 弹层。主题/宽度即时生效；失焦自动收起仅持久化（监听在 Task 10）。
import type { Store } from "./state";
import type { ThemeMode } from "./types";
import { applyTheme } from "./themes";
import { resizeWindowTo } from "./bridge";
import { openPopup } from "./render";

interface RowSpec<T extends string | number> {
  label: string;
  options: { value: T; text: string }[];
  current: T;
  onPick: (v: T) => void;
}

function buildRow<T extends string | number>(
  popup: HTMLElement,
  spec: RowSpec<T>,
): void {
  const row = document.createElement("div");
  row.className = "popup-row";
  const label = document.createElement("div");
  label.className = "popup-label";
  label.textContent = spec.label;
  const opts = document.createElement("div");
  opts.className = "popup-opts";
  for (const o of spec.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = o.value === spec.current ? "popup-opt on" : "popup-opt";
    btn.textContent = o.text;
    btn.addEventListener("click", () => {
      opts
        .querySelectorAll(".popup-opt")
        .forEach((el) => el.classList.remove("on"));
      btn.classList.add("on");
      spec.onPick(o.value);
    });
    opts.append(btn);
  }
  row.append(label, opts);
  popup.append(row);
}

function buildSwitch(
  popup: HTMLElement,
  label: string,
  current: boolean,
  onToggle: (v: boolean) => void,
): void {
  const row = document.createElement("div");
  row.className = "popup-row";
  const text = document.createElement("span");
  text.className = "popup-label";
  text.textContent = label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = current ? "popup-opt on" : "popup-opt";
  btn.textContent = current ? "开" : "关";
  btn.addEventListener("click", () => {
    const next = !current;
    btn.classList.toggle("on", next);
    btn.textContent = next ? "开" : "关";
    current = next;
    onToggle(next);
  });
  row.append(text, btn);
  popup.append(row);
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

    buildRow<ThemeMode>(popup, {
      label: "主题",
      current: s.theme,
      options: [
        { value: "system", text: "跟随系统" },
        { value: "glass", text: "毛玻璃" },
        { value: "paper", text: "纸感" },
        { value: "dark", text: "暗夜" },
      ],
      onPick: (theme) => {
        store
          .setSettings({ theme })
          .then((st) => {
            applyTheme(st.theme);
            refresh();
          })
          .catch(refresh);
      },
    });

    buildRow<number>(popup, {
      label: "宽度",
      current: s.width,
      options: [
        { value: 300, text: "紧凑" },
        { value: 340, text: "标准" },
        { value: 380, text: "宽松" },
      ],
      onPick: (width) => {
        store
          .setSettings({ width })
          .then(() => resizeWindowTo(width).catch(refresh))
          .then(refresh)
          .catch(refresh);
      },
    });

    buildSwitch(popup, "开机自启", s.autoStart, (v) => {
      store.setSettings({ autoStart: v }).then(refresh).catch(refresh);
    });

    buildSwitch(popup, "失焦 5 分钟后自动收起", s.autoCollapse, (v) => {
      store.setSettings({ autoCollapse: v }).then(refresh).catch(refresh);
    });

    const hint = document.createElement("div");
    hint.className = "popup-label";
    hint.textContent = "Esc / 点头部空白可收起到托盘";
    popup.append(hint);
    void close;
  });
}
