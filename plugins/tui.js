// tmux-opencode-sessions — OpenCode TUI plugin.
//
// Publishes the state of every OpenCode session this TUI shows (one letter
// each) into the tmux global environment, keyed by this process:
//   TMUX_OPENCODE_TUI_<pid>_PANE      tmux pane id of this TUI (%N)
//   TMUX_OPENCODE_TUI_<pid>_SESSIONS  session ids in tab order (space-separated)
//   TMUX_OPENCODE_TUI_<pid>_STATES    states aligned element-for-element
// scripts/window-sessions.sh renders these into the bottom tmux window
// status line; see README.
//
// States: running (R, blue), idle (I, default), done (D, red),
// needs-input (Q, yellow). Idle sessions that dispatched tasks to the
// local agorad publish "agora" (A, blue) or "agora-blocked" (I*, yellow)
// instead of plain idle; the source is the lightweight POST /marks poll
// (non-terminal tasks only), not the heavy /board face.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve the TUI plugin helper inside OpenCode; fall back to an identity
// shim so the module also loads under plain Node (tests, syntax checks).
let Plugin = null;
try {
  ({ Plugin } = await import("@opencode/plugin/tui"));
} catch {
  /* plain Node: no OpenCode runtime */
}

const PLUGIN_ID = "tmux-opencode-sessions";
const TICK_MS = 1000; // tab open/close reconciliation cadence
const GUARD_MS = 2000; // late permission/form replies after done stay done
const AGORA_TICK_MS = 2000; // local agorad /marks poll cadence
const AGORA_TIMEOUT_MS = 1000; // /marks request timeout

// Task states that keep an idle dispatcher marked "agora"; "blocked" is
// handled separately and wins when both exist.
const AGORA_ACTIVE = new Set([
  "todo",
  "dispatched",
  "running",
  "done",
  "verify_failed",
  "reopened",
]);

// Map the /marks response's tasks object ({tid: {state, dispatcher_sid}},
// non-terminal tasks only) to sessionID -> "agora" | "agora-blocked".
// Malformed shapes (non-object map, null/string rows, missing fields,
// unknown states) are ignored, never thrown.
const classifyAgora = (tasks) => {
  const marks = new Map();
  if (tasks === null || typeof tasks !== "object" || Array.isArray(tasks)) return marks;
  for (const row of Object.values(tasks)) {
    if (row === null || typeof row !== "object") continue;
    const { dispatcher_sid: sid, state } = row;
    if (typeof sid !== "string" || typeof state !== "string") continue;
    if (state === "blocked") marks.set(sid, "agora-blocked");
    else if (AGORA_ACTIVE.has(state) && marks.get(sid) !== "agora-blocked") marks.set(sid, "agora");
  }
  return marks;
};

// Local agorad connection: home via $AGORA_HOME, else the first non-empty
// line of ~/.agora-home, else ~/.opencode-agora-plaza; then <home>/.agora
// service.json (port) and root.token (plain text or {"token":"..."}).
// Returns null on anything missing or malformed.
const readAgoraConfig = () => {
  try {
    let home = process.env.AGORA_HOME;
    if (!home) {
      try {
        home = fs
          .readFileSync(join(homedir(), ".agora-home"), "utf8")
          .split("\n")
          .find((line) => line.trim() !== "")
          ?.trim();
      } catch {
        /* fall through to the default home */
      }
    }
    if (!home) home = join(homedir(), ".opencode-agora-plaza");
    const svc = JSON.parse(fs.readFileSync(join(home, ".agora", "service.json"), "utf8"));
    const rawToken = fs.readFileSync(join(home, ".agora", "root.token"), "utf8").trim();
    let token;
    try {
      const parsed = JSON.parse(rawToken);
      token = parsed && typeof parsed === "object" && typeof parsed.token === "string" ? parsed.token : rawToken;
    } catch {
      token = rawToken; // plain-text token file
    }
    if (typeof svc?.port !== "number" || !token) return null;
    return { port: svc.port, token };
  } catch {
    return null;
  }
};

const runTmux = (args) =>
  new Promise((resolve) => {
    execFile("tmux", args, { stdio: "ignore" }, () => resolve());
  });

// data.listen hands us {details}; payload placement varies across releases,
// so accept the documented shape plus the server-bus variants.
const eventOf = (raw) => {
  const d = raw?.details ?? raw ?? {};
  const payload = d.data ?? {};
  return {
    type: d.type ?? payload.type ?? null,
    sessionID:
      d.sessionID ?? payload.sessionID ?? d.form?.sessionID ?? payload.form?.sessionID ?? null,
  };
};

export const setup = (context) => {
  // process.env.TMUX_PANE is the authoritative pane; without it, do nothing.
  const pane = process.env.TMUX_PANE;
  if (!pane) return;

  const PREFIX = `TMUX_OPENCODE_TUI_${process.pid}`;
  const states = new Map(); // sessionID -> base state (never "agora")
  const doneAt = new Map(); // sessionID -> when done was set (late-reply guard)
  const agoraMarks = new Map(); // sessionID -> "agora" | "agora-blocked" (idle-only overlay)
  let lastSnapshot = "";
  let writes = Promise.resolve(); // serialize tmux writes against reentry
  let stopped = false;

  // Sessions this TUI shows: tab order when tabs are enabled, otherwise the
  // single session the router is on.
  const trackedSessions = () => {
    try {
      if (context.ui?.tabs?.enabled?.()) {
        const ids = [];
        for (const tab of context.ui.tabs.list() ?? []) {
          if (tab?.sessionID) ids.push(tab.sessionID);
        }
        return [...new Set(ids)];
      }
    } catch {
      /* fall through to the router */
    }
    try {
      const current = context.ui?.router?.current?.();
      return current?.type === "session" && current.sessionID ? [current.sessionID] : [];
    } catch {
      return [];
    }
  };

  // Raw status from the server API (installed contract: "running"/"idle";
  // busy/retry legacy extras); string or {status} shape, undefined on
  // error/unknown. Used for fresh sessions and by the reconcile tick.
  const statusValue = (sessionID) => {
    try {
      const status = context.data.session.status(sessionID);
      return typeof status === "string" ? status : status?.status;
    } catch {
      return undefined;
    }
  };
  // Fresh sessions start from the server's own status: work in flight
  // (running/busy/retry) reads as running; anything else as idle.
  const initialState = (sessionID) => {
    const value = statusValue(sessionID);
    return value === "running" || value === "busy" || value === "retry" ? "running" : "idle";
  };

  // Idle sessions render their agora marker instead of plain "idle"; every
  // other base state passes through untouched.
  const publishedState = (id) => {
    const base = states.get(id);
    return base === "idle" ? agoraMarks.get(id) ?? "idle" : base;
  };

  const write = () => {
    if (stopped) return; // cleanup queued the unsets; never re-publish after them
    const ids = [...states.keys()];
    const snapshot = `${pane}\u0000${ids.join(" ")}\u0000${ids.map(publishedState).join(" ")}`;
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    writes = writes
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_PANE`, pane]))
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_SESSIONS`, ids.join(" ")]))
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_STATES`, ids.map(publishedState).join(" ")]))
      .then(() => runTmux(["refresh-client"]));
    return writes;
  };

  // Reconcile tracked sessions with the live tab list (order included —
  // SESSIONS must mirror tab order even after tab moves), then publish.
  const reconcile = () => {
    if (stopped) return;
    const ids = trackedSessions();
    const ordered = new Map(ids.map((id) => [id, states.get(id) ?? initialState(id)]));
    // The status API lags events, so it may only upgrade — and a latched
    // done trusts a "running" reading only past the late-noise guard, the
    // same window that filters trailing permission/form replies. A live
    // "running" revives a stale idle and reopens done; an "idle" reading
    // never downgrades event-driven running/done/needs-input.
    for (const [id, value] of ordered) {
      if (value !== "idle" && value !== "done") continue;
      if (Date.now() - (doneAt.get(id) ?? 0) < GUARD_MS) continue;
      if (statusValue(id) !== "running") continue;
      ordered.set(id, "running");
      doneAt.delete(id);
    }
    states.clear();
    for (const [id, value] of ordered) states.set(id, value);
    for (const id of [...doneAt.keys()]) if (!ids.includes(id)) doneAt.delete(id);
    return write();
  };

  const applyEvent = ({ type, sessionID }) => {
    if (!type || !sessionID || !states.has(sessionID)) return; // foreign/background sessions: not ours
    switch (type) {
      case "session.execution.started":
      case "session.instructions.updated":
        states.set(sessionID, "running");
        doneAt.delete(sessionID);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed": // installed OpenCode failed-turn event
      case "session.error": // pre-2.4.1 failed-turn event, kept for compatibility
        states.set(sessionID, "done");
        doneAt.set(sessionID, Date.now());
        break;
      case "session.execution.interrupted":
        states.set(sessionID, "idle");
        break;
      case "permission.asked":
      case "form.created":
        states.set(sessionID, "needs-input");
        doneAt.delete(sessionID); // a fresh question starts a new cycle; the old done timestamp no longer applies
        break;
      case "permission.replied":
      case "form.replied":
      case "form.cancelled":
        // Replies right after done are trailing UI noise, not a new turn.
        if (Date.now() - (doneAt.get(sessionID) ?? 0) < GUARD_MS) return;
        states.set(sessionID, "running");
        break;
      case "session.viewed":
        // Viewing a done tab clears done only; other states stand.
        if (states.get(sessionID) === "done") states.set(sessionID, "idle");
        else return;
        break;
      case "session.deleted":
        states.delete(sessionID);
        doneAt.delete(sessionID);
        break;
      default:
        return;
    }
    return write();
  };

  // Single-flight /marks poll: one request in flight at most; a new tick
  // while one runs is dropped, not queued. Any failure (missing config,
  // fetch error, timeout, non-2xx, malformed payload) clears the markers
  // so idle sessions fall back to plain "idle" — never touching R/D/Q.
  let agoraInflight = false;
  const pollAgora = async () => {
    if (stopped || agoraInflight) return;
    agoraInflight = true;
    let marks = new Map();
    try {
      const cfg = readAgoraConfig();
      if (cfg) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), AGORA_TIMEOUT_MS);
        timer.unref();
        try {
          const res = await fetch(`http://127.0.0.1:${cfg.port}/marks`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-agora-token": cfg.token },
            body: JSON.stringify({}),
            signal: abort.signal,
          });
          if (res.ok) marks = classifyAgora((await res.json())?.tasks);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {
      /* degrade: marks stay empty */
    } finally {
      agoraInflight = false;
    }
    if (stopped) return; // a response racing cleanup must not republish
    agoraMarks.clear();
    for (const [id, mark] of marks) agoraMarks.set(id, mark);
    return write();
  };

  const stopListen = context.data.listen((event) => {
    void applyEvent(eventOf(event));
  });
  void reconcile(); // publish immediately at setup
  const timer = setInterval(() => void reconcile(), TICK_MS); // tab open/close
  timer.unref(); // a missed cleanup must not pin the host's event loop
  void pollAgora(); // markers restored from the current marks, not event history
  const agoraTimer = setInterval(() => void pollAgora(), AGORA_TICK_MS);
  agoraTimer.unref();

  // Cleanup: stop tracking and remove all three published keys.
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(agoraTimer);
    stopListen();
    for (const suffix of ["PANE", "SESSIONS", "STATES"]) {
      writes = writes.then(() => runTmux(["set-environment", "-gu", `${PREFIX}_${suffix}`]));
    }
  };
};

export default Plugin
  ? Plugin.define({ id: PLUGIN_ID, setup })
  : { id: PLUGIN_ID, setup };
