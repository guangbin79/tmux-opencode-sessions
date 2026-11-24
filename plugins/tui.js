// tmux-opencode-sessions — OpenCode TUI plugin.
//
// Publishes the state of every OpenCode session this TUI shows (one letter
// each) into the tmux global environment, keyed by this process:
//   TMUX_OPENCODE_TUI_<pid>_PANE      tmux pane id of this TUI (%N)
//   TMUX_OPENCODE_TUI_<pid>_SESSIONS  session ids in tab order (space-separated)
//   TMUX_OPENCODE_TUI_<pid>_STATES    states aligned element-for-element
// scripts/pane-sessions.sh renders these into pane border labels; see README.
//
// States: running (R, blue), idle (I, default), done (D, red),
// needs-input (Q, yellow).
import { execFile } from "node:child_process";

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
  const states = new Map(); // sessionID -> state
  const doneAt = new Map(); // sessionID -> when done was set (late-reply guard)
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

  // Fresh sessions start from the server's own status: busy/retry means work
  // in flight; anything else (including unknown) reads as idle.
  const initialState = (sessionID) => {
    try {
      const status = context.data.session.status(sessionID);
      const value = typeof status === "string" ? status : status?.status;
      return value === "busy" || value === "retry" ? "running" : "idle";
    } catch {
      return "idle";
    }
  };

  const write = () => {
    const snapshot = `${pane}\u0000${[...states.keys()].join(" ")}\u0000${[...states.values()].join(" ")}`;
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    writes = writes
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_PANE`, pane]))
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_SESSIONS`, [...states.keys()].join(" ")]))
      .then(() => runTmux(["set-environment", "-g", `${PREFIX}_STATES`, [...states.values()].join(" ")]))
      .then(() => runTmux(["refresh-client"]));
    return writes;
  };

  // Reconcile tracked sessions with the live tab list, then publish.
  const reconcile = () => {
    if (stopped) return;
    const ids = trackedSessions();
    for (const id of ids) if (!states.has(id)) states.set(id, initialState(id));
    for (const id of [...states.keys()]) if (!ids.includes(id)) states.delete(id);
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
      case "session.error":
        states.set(sessionID, "done");
        doneAt.set(sessionID, Date.now());
        break;
      case "session.execution.interrupted":
        states.set(sessionID, "idle");
        break;
      case "permission.asked":
      case "form.created":
        states.set(sessionID, "needs-input");
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

  const stopListen = context.data.listen((event) => {
    void applyEvent(eventOf(event));
  });
  void reconcile(); // publish immediately at setup
  const timer = setInterval(() => void reconcile(), TICK_MS); // tab open/close

  // Cleanup: stop tracking and remove all three published keys.
  return () => {
    stopped = true;
    clearInterval(timer);
    stopListen();
    for (const suffix of ["PANE", "SESSIONS", "STATES"]) {
      writes = writes.then(() => runTmux(["set-environment", "-gu", `${PREFIX}_${suffix}`]));
    }
  };
};

export default Plugin
  ? Plugin.define({ id: PLUGIN_ID, setup })
  : { id: PLUGIN_ID, setup };
