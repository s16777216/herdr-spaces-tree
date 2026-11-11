// Unified Workspace Tree: Spaces with nested live and persisted agent sessions,
// stable colored avatars, worktrees, git status, and Provider + Session ID tracking.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, run, openOverlay, exec, hc, notify, theme, shared, setShared, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 31);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

function cleanTitle(s) {
  if (!s) return "";
  const clean = s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (/^[A-Za-z]:\\.*(cmd|powershell|pwsh|bash|zsh)(\.exe)?\s*$/i.test(clean)) {
    return "Interactive session";
  }
  return clean || "Session";
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function smartAgentName(agent, tabInfo) {
  // If tab is explicitly named by user (tab.named is true and name is set)
  if (tabInfo?.named && tabInfo.name) {
    return tabInfo.name;
  }
  // Check agent / session title
  const title = cleanTitle(agent.title);
  const progName = agent.program?.name;
  if (title && title !== "Interactive session" && title !== "Session" && title !== progName) {
    return title;
  }
  // If tab has a name (e.g. "1")
  if (tabInfo?.name) {
    return `Tab ${tabInfo.name}`;
  }
  if (agent.tab_name) {
    return /^\d+$/.test(agent.tab_name) ? `Tab ${agent.tab_name}` : agent.tab_name;
  }
  return title || progName || "Agent";
}

function isAgent(agent, term) {
  if (!agent) return false;
  if (agent.program?.agent) return true;
  if (agent.program?.shell) return false;
  const app = (agent.app || agent.program?.key || agent.program?.name || "").toLowerCase();
  if (app === "shell" || app === "powershell" || app === "pwsh" || app === "cmd" || app === "bash" || app === "zsh") {
    return false;
  }
  if (term?.status?.app) return true;
  return false;
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

function resolveAgentCli(program, term) {
  if (term?.argv?.length) {
    const first = term.argv[0].toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop();
    if (!["pwsh", "powershell", "cmd", "bash", "zsh", "sh"].includes(first)) {
      return { cmd: first, argv: term.argv };
    }
  }
  const key = (program?.key || "").toLowerCase();
  let cmd = key || "claude";
  if (key === "antigravity") cmd = "agy";
  else if (key === "claude-code") cmd = "claude";
  return { cmd, argv: [cmd] };
}

function hashToHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function extractSessionId(agent, terminal) {
  if (terminal?.report?.session_id) return String(terminal.report.session_id);
  if (terminal?.report?.id) return String(terminal.report.id);
  const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(agent.title ?? "");
  if (uuidMatch) return uuidMatch[0];
  if (terminal?.labels?.session) return String(terminal.labels.session);
  if (terminal?.labels?.sessionId) return String(terminal.labels.sessionId);
  if (terminal?.labels?.["herdr.tab"]) return String(terminal.labels["herdr.tab"]).slice(2, 8);
  if (terminal?.address) return String(terminal.address);
  return agent.tab ? String(agent.tab).slice(0, 6) : "ag";
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d" : `${d}d`;
}

function agentStatus(t, status, compact = false) {
  const color = t[status] ?? t.dim;
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "blocked") return div().flex_none().px(5).h(16).rounded(4).bg(t.blocked + "26").text_size(10).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).bg(status === "done" ? color : t.dim + "00");
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.agentsFolded = new Set(JSON.parse(localStorage.getItem("spaces.agents_folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  loadSessions() {
    try {
      localStorage.removeItem("agent_sessions_v1");
      return JSON.parse(localStorage.getItem("agent_sessions_v2") ?? "{}");
    } catch {
      return {};
    }
  }

  saveSessions(sessions) {
    try {
      localStorage.setItem("agent_sessions_v2", JSON.stringify(sessions));
    } catch {}
  }

  deleteSession(key, cx) {
    const sessions = this.loadSessions();
    delete sessions[key];
    this.saveSessions(sessions);
    if (this.cachedSessions) delete this.cachedSessions[key];
    if (cx) cx.notify();
  }

  syncSessions(liveAgents, allTerminals) {
    const now = Date.now();
    const sessions = this.loadSessions();
    const terminalMap = new Map((allTerminals ?? []).map(t => [t.address, t]));
    let dirty = false;

    for (const a of liveAgents ?? []) {
      const term = terminalMap.get(a.address);
      if (!isAgent(a, term)) continue;

      const sessionId = extractSessionId(a, term);
      const key = `${a.space}::${a.tab}`;
      const space = (spaces() ?? []).find(s => s.id === a.space);
      const tabInfo = (space?.tabs ?? []).find(tab => tab.id === a.tab);
      const displayName = smartAgentName(a, tabInfo);

      const cli = resolveAgentCli(a.program, term);

      sessions[key] = {
        key,
        sessionId,
        shortTag: sessionId.length > 8 ? sessionId.slice(0, 7) : sessionId,
        program: a.program,
        displayName,
        tabName: tabInfo?.name ?? a.tab_name ?? null,
        title: cleanTitle(a.title || a.program?.name),
        space: a.space,
        space_name: a.space_name,
        tab: a.tab,
        cwd: term?.cwd ?? null,
        launchCmd: cli.cmd,
        launchArgv: cli.argv,
        lastSeen: now,
      };
      dirty = true;
    }

    const currentSpaces = spaces() ?? [];
    const allValidTabs = new Set();
    for (const sp of currentSpaces) {
      for (const tab of sp.tabs ?? []) {
        allValidTabs.add(tab.id);
      }
    }

    for (const [k, s] of Object.entries(sessions)) {
      if (!s.program?.agent || (allValidTabs.size > 0 && !allValidTabs.has(s.tab)) || now - s.lastSeen > 30 * 86400000) {
        delete sessions[k];
        dirty = true;
      }
    }

    if (dirty) this.saveSessions(sessions);
    return sessions;
  }

  spaceAgentRows(space, t) {
    const live = (this.liveAgents ?? []).filter(a => a.space === space.id);
    const liveTabKeys = new Set(live.map(a => `${a.space}::${a.tab}`));
    const validTabIds = new Set((space.tabs ?? []).map(tab => tab.id));

    const dormant = Object.values(this.cachedSessions ?? {}).filter(s =>
      s.space === space.id &&
      validTabIds.has(s.tab) &&
      !liveTabKeys.has(s.key)
    );

    if (!live.length && !dormant.length) return [];
    if (this.agentsFolded.has(space.id)) return [];

    const now = Date.now();
    const all = [
      ...live.map(a => ({ type: "live", a })),
      ...dormant.map(s => ({ type: "dormant", s }))
    ];
    const total = all.length;

    return all.map((item, idx) => {
      const isLast = idx === total - 1;
      return item.type === "live"
        ? this.liveAgentRow(item.a, t, isLast)
        : this.dormantSessionRow(item.s, t, now, isLast);
    });
  }

  liveAgentRow(a, t, isLast = false) {
    const space = (spaces() ?? []).find(s => s.id === a.space);
    const tabInfo = (space?.tabs ?? []).find(tab => tab.id === a.tab);
    const term = this.terminalsMap?.get(a.address);
    const sessionId = extractSessionId(a, term);
    const shortTag = sessionId.length > 8 ? sessionId.slice(0, 7) : sessionId;
    const displayName = smartAgentName(a, tabInfo);
    const pic = icon(a.program, 13, t.foreground) || svg("mods/workspace-chrome/terminal.svg").size(13).flex_none().text_color(t.dim);

    return h_flex()
      .relative()
      .id(`live-ag-${a.address}`)
      .h(27)
      .pl(30)
      .pr(8)
      .gap(7)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click(() => {
        if (a.pane) run("pane.focus", { pane: a.pane });
        else run("pane.focus", { terminal: a.address });
      })
      .on_mouse_down("right", (_e, cx) => {
        _e.stop_propagation?.();
        this.openAgentMenu(a, sessionId, shortTag, displayName, term?.cwd);
      })
      // Tree Indent Guide Rails (Rounded Corner)
      .child(
        div()
          .absolute()
          .left(16)
          .top(0)
          .w(11)
          .h(14)
          .border_l(1.5)
          .border_b(1.5)
          .border_color(t.input ?? (t.border + "66"))
          .rounded_bl(6)
      )
      .when(!isLast, el => el.child(
        div()
          .absolute()
          .left(16)
          .top(13.5)
          .bottom(0)
          .w(1.5)
          .bg(t.input ?? (t.border + "66"))
      ))
      .child(pic)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(displayName)
      )
      .child(agentStatus(t, a.status));
  }

  async wakeDormantSession(s, mode = "resume") {
    if (s.space) {
      run("space.select", { id: s.space });
    }
    if (s.tab) {
      run("tab.select", { id: s.tab });
    }

    const launch = buildAgentLaunch(s.program, s, mode);
    const cmd = launch.cmd;
    const argv = launch.argv;
    const allPanes = panes() ?? [];
    const pane = allPanes.find(p => p.tab === s.tab && p.terminal);

    if (pane?.terminal) {
      run("pane.focus", { pane: pane.pane });
      const term = (terminals() ?? []).find(t => t.address === pane.terminal);
      if (term && (!term.status || term.status.state !== "working")) {
        notify({ title: `接續 ${s.program?.name || "Agent"}`, body: `正在載入歷史對話...` });
        await hc(["send", term.address, cmd]).catch(() => {});
      }
    } else {
      this.deleteSession(s.key);
      notify({ title: `接續 ${s.program?.name || "Agent"}`, body: `開啟新分頁...` });
      run("tab.new", {
        space: s.space,
        name: s.displayName || s.tabName || s.program?.name || "Agent",
        folder: s.cwd || undefined,
        argv
      });
    }
  }

  dormantSessionRow(s, t, now, isLast = false) {
    const ago = duration(now - s.lastSeen);
    const pic = icon(s.program, 13, t.dim) || svg("mods/workspace-chrome/terminal.svg").size(13).flex_none().text_color(t.dim);
    const displayName = s.displayName || s.tabName || s.title || s.program?.name || "Agent";

    return h_flex()
      .relative()
      .id(`dormant-${s.key}`)
      .h(27)
      .pl(30)
      .pr(8)
      .gap(7)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hoveredDormant = s.key;
        else if (this.hoveredDormant === s.key) this.hoveredDormant = null;
        cx.notify();
      })
      .on_click(() => this.wakeDormantSession(s))
      .on_mouse_down("right", (_e, cx) => {
        _e.stop_propagation?.();
        this.openDormantMenu(s);
      })
      // Tree Indent Guide Rails (Rounded Corner)
      .child(
        div()
          .absolute()
          .left(16)
          .top(0)
          .w(11)
          .h(14)
          .border_l(1.5)
          .border_b(1.5)
          .border_color(t.input ?? (t.border + "66"))
          .rounded_bl(6)
      )
      .when(!isLast, el => el.child(
        div()
          .absolute()
          .left(16)
          .top(13.5)
          .bottom(0)
          .w(1.5)
          .bg(t.input ?? (t.border + "66"))
      ))
      .child(pic)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .text_color(t.dim)
          .child(displayName)
      )
      .when(this.hoveredDormant === s.key, el => el.child(
        div().id(`del-${s.key}`).size(16).flex_none().rounded(4).flex().items_center().justify_center().text_color(t.dim)
          .hover(s => s.bg(t.raised).text_color(t.foreground))
          .tooltip("Dismiss saved session")
          .on_click((_e, cx) => {
            _e.stop_propagation?.();
            this.deleteSession(s.key, cx);
          })
          .child(svg("mods/workspace-chrome/x.svg").size(10))
      ));
  }

  openAgentMenu(a, sessionId, shortTag, displayName, cwd) {
    openOverlay({
      mod: "agent-tab-menu",
      kind: "popup",
      width: 190,
      height: 145,
      props: {
        type: "live",
        tabId: a.tab,
        paneId: a.pane,
        spaceId: a.space,
        sessionId,
        shortTag,
        title: displayName,
        program: a.program,
        cwd
      }
    });
  }

  openDormantMenu(s) {
    openOverlay({
      mod: "agent-tab-menu",
      kind: "popup",
      width: 195,
      height: 195,
      props: {
        type: "dormant",
        tabId: s.tab,
        spaceId: s.space,
        program: s.program,
        session: s,
        launchCmd: s.launchCmd,
        launchArgv: s.launchArgv,
        sessionId: s.sessionId,
        shortTag: s.shortTag,
        title: s.displayName || s.title,
        cwd: s.cwd,
        sessionKey: s.key
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : [this.row(r, t), ...this.spaceAgentRows(r.w, t)]);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);

    const live = (this.liveAgents ?? []).filter(a => a.space === w.id);
    const liveTabKeys = new Set(live.map(a => `${a.space}::${a.tab}`));
    const dormant = Object.values(this.cachedSessions ?? {}).filter(s => s.space === w.id && !liveTabKeys.has(s.key));
    const totalAgents = live.length + dormant.length;
    const hasBlocked = live.some(a => a.status === "blocked");
    const hasWorking = live.some(a => a.status === "working");
    const isFolded = this.agentsFolded.has(w.id);

    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(7)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(totalAgents > 0, el => el.child(
            h_flex().gap(3).items_center().px(6).h(18).rounded(9).bg(t.raised)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .tooltip(`${totalAgents} agent session(s) (click to ${isFolded ? "expand" : "collapse"})`)
              .on_mouse_down("left", (_e, cx) => {
                _e.stop_propagation?.();
                isFolded ? this.agentsFolded.delete(w.id) : this.agentsFolded.add(w.id);
                localStorage.setItem("spaces.agents_folded", JSON.stringify([...this.agentsFolded]));
                cx.notify();
              })
              .when(hasWorking, e => e.child(svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900)))
              .when(hasBlocked, e => e.child(div().size(5).rounded(3).bg(t.blocked)))
              .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(String(totalAgents)))
              .child(svg(`mods/workspace-chrome/chevron-${isFolded ? "right" : "down"}.svg`).size(9).text_color(t.dim))
          )),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    const allTerms = terminals() ?? [];
    this.terminalsMap = new Map(allTerms.map(t => [t.address, t]));
    this.liveAgents = agents() ?? [];
    this.cachedSessions = this.syncSessions(this.liveAgents, allTerms);

    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
