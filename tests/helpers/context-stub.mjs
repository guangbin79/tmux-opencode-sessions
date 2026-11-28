// Stub driver utilities for TUI plugin tests.
// The stub context mimics the OpenCode TUI plugin context surface this
// plugin uses: ui.tabs.enabled/list, ui.router.current, data.session.status,
// data.listen. Tests observe behavior through the fake tmux log.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-memory agora marks stub: an isolated HTTP server on 127.0.0.1 plus a
// temp AGORA_HOME pointing at it, so no test ever reaches the real local
// agorad. Serves the /marks contract ({"tasks":{...}}) on /marks only and
// 404s every other path; empty marks by default; tests mutate `tasks`,
// `mode` ("ok" | "500" | "garbage") and `delayMs` (>= the plugin timeout
// simulates a timeout), and inspect recorded requests.
const STUB_TOKEN = "stub-root-token";
let boardState = null;
const tmpBase = () => {
  try {
    fs.mkdirSync("/tmp/opencode", { recursive: true });
    return "/tmp/opencode";
  } catch {
    return os.tmpdir();
  }
};

export const board = () => {
  if (boardState) return boardState;
  const home = fs.mkdtempSync(path.join(tmpBase(), "agora-stub-"));
  const state = {
    home,
    tokenFile: path.join(home, ".agora", "root.token"),
    tasks: {},
    mode: "ok",
    delayMs: 0,
    requests: [],
  };
  // Claim AGORA_HOME synchronously: even the plugin's very first poll must
  // resolve here, never to the developer's real agora home.
  process.env.AGORA_HOME = home;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url, body, token: req.headers["x-agora-token"] });
      if (req.url !== "/marks") { // agorad serves the marks face only here
        res.writeHead(404, { "content-type": "application/json", connection: "close" });
        res.end("{}");
        return;
      }
      const respond = () => {
        try {
          const ok = state.mode !== "500";
          res.writeHead(ok ? 200 : 500, { "content-type": "application/json", connection: "close" });
          res.end(state.mode === "garbage" ? "not-json{" : JSON.stringify({ tasks: state.tasks }));
        } catch {
          /* the client may have aborted (timeout) before our delayed reply */
        }
      };
      if (state.delayMs) setTimeout(respond, state.delayMs).unref();
      else respond();
    });
  });
  server.unref(); // a listening stub must not keep the test process alive
  state.ready = new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      fs.mkdirSync(path.join(home, ".agora"), { recursive: true });
      fs.writeFileSync(path.join(home, ".agora", "service.json"), JSON.stringify({ port: server.address().port }));
      fs.writeFileSync(state.tokenFile, `${STUB_TOKEN}\n`);
      resolve();
    }),
  );
  boardState = state;
  return state;
};

export const boardReady = () => board().ready;

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
  status = {}, // sessionID -> "running" | "idle" (installed contract; busy/retry legacy, both shapes exercised)
  route = { type: "home" },
} = {}) => {
  board(); // isolate this process from the real local agorad before any setup()
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
  return { context, state, emit, listeners };
};
