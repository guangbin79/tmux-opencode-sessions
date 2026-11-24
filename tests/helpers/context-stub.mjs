// Stub driver utilities for TUI plugin tests.
// The stub context mimics the OpenCode TUI plugin context surface this
// plugin uses: ui.tabs.enabled/list, ui.router.current, data.session.status,
// data.listen. Tests observe behavior through the fake tmux log.
import fs from "node:fs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const calls = () =>
  fs.readFileSync(process.env.FAKE_TMUX_LOG, "utf8").split("\n").filter(Boolean);

// Latest value written for KEY across set-environment -g KEY VALUE lines.
export const lastValue = (key) => {
  const hit = calls().filter((l) => l.startsWith(`set-environment -g ${key} `)).pop();
  return hit === undefined ? undefined : hit.split(" ").slice(3).join(" ");
};

export const hasUnset = (key) => calls().includes(`set-environment -gu ${key}`);

export const callCount = (re) => calls().filter((l) => re.test(l)).length;

// Wait for pred to become true; a timeout is always a test failure.
export const waitUntil = async (pred, ms = 3000, what = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  if (pred()) return true;
  throw new Error(`waitUntil timeout (${ms}ms): ${what}`);
};

// Build a stub TUI context. `state` is mutable so tests can change tabs,
// tab-enablement, or the router route mid-run (the plugin polls).
export const makeContext = ({
  tabsEnabled = true,
  tabs = [],
  status = {}, // sessionID -> {status:"busy"} | "idle" (both shapes exercised)
  route = { type: "home" },
} = {}) => {
  const listeners = [];
  const state = { tabsEnabled, tabs, status, route };
  const context = {
    ui: {
      tabs: {
        enabled: () => state.tabsEnabled,
        list: () => state.tabs.map((t) => ({ ...t })),
      },
      router: { current: () => state.route },
    },
    data: {
      session: { status: (id) => state.status[id] },
      listen: (fn) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };
  // Emit a server event the way data.listen delivers it ({details:{type,...}}).
  const emit = (type, data = {}) => {
    for (const fn of [...listeners]) fn({ details: { type, ...data } });
  };
  return { context, state, emit };
};
