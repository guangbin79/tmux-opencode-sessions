// TUI state-transition tests: event→state mapping, multi-session
// independence, foreign sessions, viewed semantics, late-reply guard,
// session.deleted, and reload restoration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "../../plugins/tui.js";
import { makeContext, lastValue, hasUnset, callCount, sleep, waitUntil } from "../helpers/context-stub.mjs";

process.env.TMUX_PANE = "%9"; // fixed fixture pane; overrides the host tmux pane
const KEY = (suffix) => `TMUX_OPENCODE_TUI_${process.pid}_${suffix}`;
const LOG = process.env.FAKE_TMUX_LOG;
const fresh = () => fs.writeFileSync(LOG, "");

// Boot a plugin instance and register guaranteed cleanup, even on failure.
const boot = async (t, opts = { tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] }) => {
  const ctx = makeContext(opts);
  const cleanup = setup(ctx.context);
  t.after(() => cleanup());
  // STATES is written last; once visible the initial publish is complete.
  await waitUntil(() => lastValue(KEY("STATES")) !== undefined, 3000, "initial publish");
  return { ...ctx, cleanup };
};

test("initializes each tracked tab session from session.status(): busy/retry→running, else idle", async (t) => {
  fresh();
  const ctx = await boot(t, {
    tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }, { sessionID: "ses_c" }],
    status: { ses_a: { status: "busy" }, ses_b: "idle", ses_c: { status: "retry" } },
  });
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle running", 3000, "busy/retry mapping");
  assert.equal(lastValue(KEY("PANE")), "%9");
  assert.equal(lastValue(KEY("SESSIONS")), "ses_a ses_b ses_c");
  ctx.emit("session.execution.started", { sessionID: "ses_b" }); // live events still flow after init
  await waitUntil(() => lastValue(KEY("STATES")) === "running running running", 3000, "post-init event");
});

test("tab move republishes SESSIONS in the new tab order", async (t) => {
  fresh();
  const ctx = await boot(t);
  ctx.state.tabs = [{ sessionID: "ses_b" }, { sessionID: "ses_a" }];
  await waitUntil(
    () => lastValue(KEY("SESSIONS")) === "ses_b ses_a" && lastValue(KEY("STATES")) === "idle idle",
    3000,
    "reordered tabs",
  );
});

test("a fresh question after done restarts the reply cycle: asked→replied flips to running", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done idle");
  emit("permission.asked", { sessionID: "ses_a" }); // genuine question, not trailing noise
  await waitUntil(() => lastValue(KEY("STATES")) === "needs-input idle");
  emit("permission.replied", { sessionID: "ses_a" }); // arrives <2s after the OLD done
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle");
});

test("execution cycle: started→running, succeeded→done; instructions.updated→running; error→done; interrupted→idle", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("session.execution.started", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle");
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done idle");
  emit("session.instructions.updated", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle");
  emit("session.error", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done idle");
  emit("session.execution.interrupted", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle idle");
});

test("needs-input cycle: permission.asked/form.created→needs-input, replied/cancelled→running", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("permission.asked", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle needs-input");
  emit("permission.replied", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle running");
  emit("form.created", { form: { sessionID: "ses_b" } });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle needs-input");
  emit("form.cancelled", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle running");
  emit("form.replied", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle running");
});

test("sessions are independent: ses_a done while ses_b flips running→needs-input", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  emit("session.execution.started", { sessionID: "ses_b" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done running");
  emit("form.created", { form: { sessionID: "ses_b" } });
  await waitUntil(() => lastValue(KEY("STATES")) === "done needs-input");
});

test("events for untracked (foreign/background) sessions change nothing and write nothing", async (t) => {
  fresh();
  const { emit } = await boot(t);
  await sleep(100);
  const states = lastValue(KEY("STATES"));
  const writes = callCount(/^set-environment -g /);
  emit("session.execution.started", { sessionID: "ses_ghost" });
  emit("session.execution.succeeded", { sessionID: "ses_ghost" });
  emit("session.deleted", { sessionID: "ses_ghost" });
  emit("session.execution.started", {}); // no session id at all
  await sleep(250);
  assert.equal(lastValue(KEY("STATES")), states);
  assert.equal(callCount(/^set-environment -g /), writes);
});

test("session.viewed clears done only; running and needs-input untouched", async (t) => {
  fresh();
  const { emit } = await boot(t, {
    tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }, { sessionID: "ses_c" }],
  });
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  emit("session.execution.started", { sessionID: "ses_b" });
  emit("permission.asked", { sessionID: "ses_c" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done running needs-input");
  emit("session.viewed", { sessionID: "ses_a" });
  emit("session.viewed", { sessionID: "ses_b" });
  emit("session.viewed", { sessionID: "ses_c" });
  await waitUntil(() => lastValue(KEY("STATES")) === "idle running needs-input");
});

test("late-reply guard: reply within 2s after done stays done; after 2s flips to running", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done idle");
  emit("form.replied", { sessionID: "ses_a" }); // <2s after done: trailing UI noise
  await sleep(300);
  assert.equal(lastValue(KEY("STATES")), "done idle");
  await sleep(2100); // guard window elapsed
  emit("permission.replied", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle");
});

test("session.deleted removes that session from the published lists", async (t) => {
  fresh();
  const { emit } = await boot(t);
  emit("session.execution.succeeded", { sessionID: "ses_a" });
  await waitUntil(() => lastValue(KEY("STATES")) === "done idle");
  emit("session.deleted", { sessionID: "ses_a" });
  await waitUntil(
    () => lastValue(KEY("SESSIONS")) === "ses_b" && lastValue(KEY("STATES")) === "idle",
    3000,
    "ses_a removed",
  );
});

test("reload restoration: cleanup unsets all three keys; a fresh setup republishes from session status", async (t) => {
  fresh();
  const first = makeContext({
    tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }],
    status: { ses_a: { status: "busy" }, ses_b: "idle" },
  });
  const stop1 = setup(first.context);
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle");
  const unsets = callCount(/^set-environment -gu /); // count-based: immune to stale unsets
  stop1();
  await waitUntil(() => callCount(/^set-environment -gu /) >= unsets + 3, 3000, "stop1 unsets all three");
  const second = makeContext({
    tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }],
    status: { ses_a: "idle", ses_b: { status: "busy" } },
  });
  const stop2 = setup(second.context);
  await waitUntil(() => lastValue(KEY("STATES")) === "idle running");
  stop2();
});
