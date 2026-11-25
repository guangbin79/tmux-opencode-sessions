// Agora idle-status tests: the plugin polls the local agorad board and,
// for idle sessions only, publishes "agora" (this session dispatched tasks
// still in flight) or "agora-blocked" (one of them is blocked). Covers
// ownership, active-state membership, precedence, transitions, degradation,
// reload restoration, late responses after cleanup, malformed boards, and
// the request shape (both root-token file formats).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup } from "../../plugins/tui.js";
import { makeContext, lastValue, callCount, calls, sleep, waitUntil, board, boardReady } from "../helpers/context-stub.mjs";

process.env.TMUX_PANE = "%9"; // fixed fixture pane; overrides the host tmux pane
const KEY = (suffix) => `TMUX_OPENCODE_TUI_${process.pid}_${suffix}`;
const LOG = process.env.FAKE_TMUX_LOG;
const fresh = () => fs.writeFileSync(LOG, "");

const b = board();
await boardReady(); // stub board listening + config visible before any setup()

const row = (dispatcher_sid, state) => ({ dispatcher_sid, state });
const tasks = (rows) => Object.fromEntries(rows.map((r, i) => [`ag-${i}`, r]));
// One board poll cycle is 2s; budgets account for it.
const seeStates = (expected, ms = 8000) =>
  waitUntil(() => lastValue(KEY("STATES")) === expected, ms, `STATES → ${expected}`);

const boot = async (t, opts = { tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] }) => {
  fresh();
  const ctx = makeContext(opts);
  const cleanup = setup(ctx.context);
  t.after(() => cleanup());
  await waitUntil(() => lastValue(KEY("STATES")) !== undefined, 3000, "initial publish");
  return { ...ctx, cleanup };
};

test("ownership: markers land only on the dispatching session; blocked wins over active; foreign dispatchers untouched", async (t) => {
  await boot(t, { tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }, { sessionID: "ses_c" }] });
  b.tasks = tasks([
    row("ses_a", "running"), // active…
    row("ses_a", "blocked"), // …plus blocked on the same dispatcher → blocked wins
    row("ses_b", "todo"), // active only
    row("ses_other", "dispatched"), // foreign dispatcher: nobody here owns it
  ]);
  await seeStates("agora-blocked agora idle");
});

test("each active task state (todo/dispatched/running/done/verify_failed/reopened) marks its dispatcher's idle session; terminal does not", async (t) => {
  const ids = ["ses_t1", "ses_t2", "ses_t3", "ses_t4", "ses_t5", "ses_t6", "ses_u"];
  await boot(t, { tabs: ids.map((sessionID) => ({ sessionID })) });
  b.tasks = tasks([
    row("ses_t1", "todo"),
    row("ses_t2", "dispatched"),
    row("ses_t3", "running"),
    row("ses_t4", "done"),
    row("ses_t5", "verify_failed"),
    row("ses_t6", "reopened"),
    row("ses_u", "merged"), // terminal: no marker
  ]);
  await seeStates("agora agora agora agora agora agora idle");
});

test("terminal states, malformed task rows and a non-object tasks map are all ignored", async (t) => {
  await boot(t);
  b.tasks = tasks([row("ses_a", "merged"), row("ses_b", "closed"), row("ses_b", "cancelled")]);
  await seeStates("idle idle");
  b.tasks = {
    "ag-1": null, // null row
    "ag-2": row("ses_b", "dispatched"), // valid row among the malformed ones
    "ag-3": { state: "running" }, // no dispatcher_sid
    "ag-4": { dispatcher_sid: "ses_a" }, // no state
    "ag-5": "row", // not even an object
  };
  await seeStates("idle agora");
  b.tasks = "not-an-object"; // tasks map itself malformed
  await seeStates("idle idle");
});

test("non-idle precedence: running/done/needs-input keep their letters despite active/blocked tasks; markers return once idle again", async (t) => {
  const { emit } = await boot(t);
  emit("session.execution.started", { sessionID: "ses_a" });
  emit("session.execution.succeeded", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "running done");
  b.tasks = tasks([row("ses_a", "blocked"), row("ses_b", "running")]);
  await sleep(2600); // ≥1 poll cycle applies the board while both are busy
  assert.equal(lastValue(KEY("STATES")), "running done");
  emit("permission.asked", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "needs-input done");
  await sleep(2600);
  assert.equal(lastValue(KEY("STATES")), "needs-input done");
  emit("session.execution.interrupted", { sessionID: "ses_a" }); // back to idle
  emit("session.viewed", { sessionID: "ses_b" }); // done → idle
  await seeStates("agora-blocked agora");
});

test("board transitions: active→agora, terminal→plain idle, blocked→agora-blocked", async (t) => {
  await boot(t, { tabs: [{ sessionID: "ses_a" }] });
  b.tasks = tasks([row("ses_a", "dispatched")]);
  await seeStates("agora");
  b.tasks = tasks([row("ses_a", "merged")]);
  await seeStates("idle");
  b.tasks = tasks([row("ses_a", "blocked")]);
  await seeStates("agora-blocked");
});

test("read failures (non-2xx, malformed body, timeout, missing config) clear markers to plain idle; running stays running", async (t) => {
  const { emit } = await boot(t);
  emit("session.execution.started", { sessionID: "ses_b" });
  t.after(() => {
    process.env.AGORA_HOME = b.home;
    b.tasks = {};
    b.mode = "ok";
    b.delayMs = 0;
  });
  const marked = () => {
    b.mode = "ok";
    b.delayMs = 0;
    b.tasks = tasks([row("ses_a", "todo")]);
  };
  marked();
  await seeStates("agora running");
  b.mode = "500";
  await seeStates("idle running");

  marked();
  await seeStates("agora running");
  b.mode = "garbage";
  await seeStates("idle running");

  marked();
  await seeStates("agora running");
  b.delayMs = 1500; // slower than the 1s request timeout → abort
  await seeStates("idle running");

  marked();
  await seeStates("agora running");
  process.env.AGORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agora-empty-")); // no .agora at all
  await seeStates("idle running");
  process.env.AGORA_HOME = b.home;
});

test("reload restores markers from the current board, not from event history", async (t) => {
  b.tasks = tasks([row("ses_a", "running")]);
  const first = makeContext({ tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] });
  const stop1 = setup(first.context);
  await seeStates("agora idle");
  stop1();
  const unsets = callCount(/^set-environment -gu /); // baseline: earlier tests' cleanups also unset
  await waitUntil(() => callCount(/^set-environment -gu /) >= unsets + 3, 3000, "stop1 unsets all three");
  fresh(); // only the new instance's writes are visible from here on
  const second = makeContext({ tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] });
  const stop2 = setup(second.context);
  t.after(() => stop2());
  await seeStates("agora idle"); // fresh instance, zero events: the board is the only source
  b.tasks = {};
  await seeStates("idle idle");
});

test("a board response resolving after cleanup never republishes the removed keys", async (t) => {
  b.tasks = tasks([row("ses_a", "todo")]);
  b.delayMs = 900; // the response outlives the cleanup below
  t.after(() => {
    b.delayMs = 0;
    b.tasks = {};
  });
  fresh(); // only this instance's writes are visible from here on
  const ctx = makeContext({ tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] });
  const reqs = b.requests.length;
  const cleanup = setup(ctx.context);
  t.after(() => cleanup());
  await waitUntil(
    () => b.requests.length > reqs && lastValue(KEY("STATES")) === "idle idle",
    3000,
    "this instance's initial publish and board request",
  );
  cleanup();
  await sleep(250); // every queued chain (mine and the previous test's tail) settles
  const settled = calls();
  assert.deepStrictEqual(
    settled.slice(-3).map((l) => l.split(" ")[2]),
    [`${KEY("PANE")}`, `${KEY("SESSIONS")}`, `${KEY("STATES")}`],
    "cleanup unsets are the last writes",
  );
  await sleep(1250); // the delayed response lands well after cleanup
  assert.deepStrictEqual(calls(), settled); // nothing at all: no republish
});

test("request shape: POST /board with {\"view\":\"full\"} and the root-token header; token file may be plain text or JSON", async (t) => {
  await boot(t, { tabs: [{ sessionID: "ses_a" }] });
  await waitUntil(() => b.requests.length > 0, 3000, "at least one request");
  const first = b.requests.at(-1);
  assert.equal(first.method, "POST");
  assert.equal(first.url, "/board");
  assert.equal(first.body, '{"view":"full"}');
  assert.equal(first.token, "stub-root-token");
  // JSON-format root.token: {"token":"..."}
  fs.writeFileSync(b.tokenFile, JSON.stringify({ token: "stub-json-token" }));
  t.after(() => fs.writeFileSync(b.tokenFile, "stub-root-token\n"));
  const seen = b.requests.length;
  await waitUntil(() => b.requests.length > seen, 6000, "next poll");
  assert.equal(b.requests.at(-1).token, "stub-json-token");
});
