import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, notify, panes, terminals, hc } from "herdr";

function deleteDormantSession(key) {
  try {
    const raw = localStorage.getItem("agent_sessions_v2");
    if (raw) {
      const parsed = JSON.parse(raw);
      delete parsed[key];
      localStorage.setItem("agent_sessions_v2", JSON.stringify(parsed));
    }
  } catch {}
}

function buildAgentLaunch(program, session, mode = "resume") {
  const key = (program?.key || "").toLowerCase();
  let baseCmd = key || "claude";
  if (key === "antigravity") baseCmd = "agy";
  else if (key === "claude-code") baseCmd = "claude";

  if (mode === "new") {
    return { cmd: baseCmd, argv: [baseCmd] };
  }

  // mode === "resume"
  if (baseCmd === "claude") {
    const sid = session?.sessionId;
    const hasFullUuid = sid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid);
    if (hasFullUuid) {
      return { cmd: `claude --resume ${sid}`, argv: ["claude", "--resume", sid] };
    }
    return { cmd: "claude --continue", argv: ["claude", "--continue"] };
  }

  if (baseCmd === "agy") {
    const sid = session?.sessionId;
    if (sid && (sid.includes("-") || sid.length >= 16)) {
      return { cmd: `agy --conversation ${sid}`, argv: ["agy", "--conversation", sid] };
    }
    return { cmd: "agy --continue", argv: ["agy", "--continue"] };
  }

  return { cmd: `${baseCmd} --continue`, argv: [baseCmd, "--continue"] };
}

export default class AgentTabMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    const p = props() ?? {};
    if (p.type === "dormant") {
      const launchHelper = async (mode) => {
        if (p.spaceId) run("space.select", { id: p.spaceId });
        if (p.tabId) run("tab.select", { id: p.tabId });
        const launch = buildAgentLaunch(p.program, p.session || p, mode);
        const cmd = launch.cmd;
        const argv = launch.argv;
        const name = p.program?.name || "Agent";
        if (p.tabId) {
          const allPanes = panes() ?? [];
          const pane = allPanes.find(pn => pn.tab === p.tabId && pn.terminal);
          if (pane?.terminal) {
            run("pane.focus", { pane: pane.pane });
            const term = (terminals() ?? []).find(t => t.address === pane.terminal);
            if (term && (!term.status || term.status.state !== "working")) {
              notify({ title: `${mode === "resume" ? "接續" : "啟動"} ${name}`, body: mode === "resume" ? "正在載入歷史對話..." : "正在開啟新對話..." });
              await hc(["send", term.address, cmd]).catch(() => {});
              return;
            }
          }
        }
        if (p.sessionKey) {
          deleteDormantSession(p.sessionKey);
        }
        notify({ title: `${mode === "resume" ? "接續" : "啟動"} ${name}`, body: "開啟新分頁..." });
        run("tab.new", { space: p.spaceId, name: p.title || name, folder: p.cwd || undefined, argv });
      };

      return [
        {
          label: "接續對話 (Resume)",
          icon: "mods/workspace-chrome/terminal.svg",
          action: () => launchHelper("resume")
        },
        {
          label: "開立新對話",
          icon: "mods/workspace-chrome/square-pen.svg",
          action: () => launchHelper("new")
        },
        {
          label: "複製 Session ID",
          icon: "mods/git/icons/copy.svg",
          hint: p.shortTag ? `#${p.shortTag}` : "",
          action: (cx) => {
            const val = p.sessionId || p.shortTag || "";
            if (val) {
              cx.write_to_clipboard(val);
              notify({ title: "已複製 Session ID", body: `#${p.shortTag || val}` });
            }
          }
        },
        ...(p.cwd ? [{
          label: "複製路徑",
          icon: "mods/workspace-chrome/folder.svg",
          action: (cx) => {
            cx.write_to_clipboard(p.cwd);
            notify({ title: "已複製工作路徑", body: p.cwd });
          }
        }] : []),
        {
          label: "前往工作區",
          icon: "mods/workspace-chrome/monitor.svg",
          action: () => {
            if (p.spaceId) run("space.select", { id: p.spaceId });
          }
        },
        {
          label: "從記錄中清除",
          icon: "mods/workspace-chrome/x.svg",
          danger: true,
          action: () => {
            if (p.sessionKey) {
              deleteDormantSession(p.sessionKey);
              notify({ title: "已清除記錄" });
            }
          }
        }
      ];
    }

    // Live agent menu
    return [
      {
        label: "重新命名",
        icon: "mods/workspace-chrome/square-pen.svg",
        action: () => {
          if (p.tabId) run("tab.rename", { id: p.tabId });
        }
      },
      {
        label: "複製 Session ID",
        icon: "mods/git/icons/copy.svg",
        hint: p.shortTag ? `#${p.shortTag}` : "",
        action: (cx) => {
          const val = p.sessionId || p.shortTag || "";
          if (val) {
            cx.write_to_clipboard(val);
            notify({ title: "已複製 Session ID", body: `#${p.shortTag || val}` });
          }
        }
      },
      ...(p.cwd ? [{
        label: "複製路徑",
        icon: "mods/workspace-chrome/folder.svg",
        action: (cx) => {
          cx.write_to_clipboard(p.cwd);
          notify({ title: "已複製工作路徑", body: p.cwd });
        }
      }] : []),
      {
        label: "關閉分頁",
        icon: "mods/workspace-chrome/x.svg",
        danger: true,
        action: () => {
          if (p.tabId) run("tab.close", { id: p.tabId });
        }
      }
    ];
  }

  choose(i, cx) {
    const list = this.items();
    const it = list[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it.action(cx);
  }

  render(cx) {
    const t = theme();
    const list = this.items();
    return v_flex()
      .id("agent-tab-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(4)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && it.danger, el => el.child(div().mx(6).my(3).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`atmi-${i}`)
                .h(28)
                .px(8)
                .gap(8)
                .rounded(5)
                .items_center()
                .justify_between()
                .cursor_pointer()
                .text_color(it.danger ? (t.blocked || "#ef4444") : t.foreground)
                .when(i === this.at, el => el.bg(t.selected))
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.choose(i, cx))
                .child(svg(it.icon).size(13).flex_none().text_color(it.danger ? (t.blocked || "#ef4444") : t.muted))
                .child(div().flex_1().min_w(0).truncate().child(it.label))
                .when(Boolean(it.hint), el => el.child(
                  div().text_size(10.5).text_color(t.dim).child(it.hint)
                ))
            )
        )
      );
  }
}
