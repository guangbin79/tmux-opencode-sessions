// TUI lifecycle tests: no-TMUX_PANE no-op, tab open/close via the 1s tick,
// write-only-on-change, refresh after changes, tabs-disabled router mode,
// and cleanup unsetting every published key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "../../plugins/tui.js";
import { makeContext, lastValue, hasUnset, callCount, sleep, waitUntil } from "../helpers/context-stub.mjs";

process.env.TMUX_PANE = "%9"; // fixed fixture pane; overrides the host tmux pane
const KEY = (suffix) => `TMUX_OPENCODE_TUI_${process.pid}_${suffix}`;
const LOG = process.env.FAKE_TMUX_LOG;
const fresh = () => fs.writeFileSync(LOG, "");

const boot = async (t, opts = { tabs: [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] }) => {
  const ctx = makeContext(opts);
  const cleanup = setup(ctx.context);
  t.after(() => cleanup());
  await waitUntil(() => lastValue(KEY("STATES")) !== undefined, 3000, "initial publish");
  return { ...ctx, cleanup };
};

test("without TMUX_PANE the plugin is a complete no-op (no tmux calls ever)", async () => {
  fresh();
  const saved = process.env.TMUX_PANE;
  delete process.env.TMUX_PANE;
  try {
    const ctx = makeContext({ tabs: [{ sessionID: "ses_a" }] });
    const cleanup = setup(ctx.context);
    await sleep(1300); // spans at least one reconcile tick
    assert.equal(fs.readFileSync(LOG, "utf8"), "");
    assert.equal(cleanup, undefined);
  } finally {
    process.env.TMUX_PANE = saved;
  }
});

test("tab close drops the session from the published lists within the 1s tick", async (t) => {
  fresh();
  const ctx = await boot(t);
  ctx.state.tabs.shift(); // close the tab holding ses_a
  await waitUntil(
    () => lastValue(KEY("SESSIONS")) === "ses_b" && lastValue(KEY("STATES")) === "idle",
    3000,
    "ses_a dropped",
  );
});

test("tab open picks the new session up within the 1s tick", async (t) => {
  fresh();
  const ctx = await boot(t, { tabs: [{ sessionID: "ses_a" }] });
  ctx.state.tabs.push({ sessionID: "ses_new" });
  await waitUntil(() => lastValue(KEY("SESSIONS")) === "ses_a ses_new", 3000, "ses_new added");
});

test("writes only when the snapshot changes: ticks and no-op events stay silent", async (t) => {
  fresh();
  const ctx = await boot(t);
  const writes = callCount(/^set-environment -g /);
  const refreshes = callCount(/^refresh-client/);
  await sleep(1300); // ≥1 tick with an unchanged snapshot
  assert.equal(callCount(/^set-environment -g /), writes);
  ctx.emit("session.viewed", { sessionID: "ses_a" }); // idle: viewing changes nothing
  await sleep(250);
  assert.equal(callCount(/^set-environment -g /), writes);
  ctx.emit("session.execution.started", { sessionID: "ses_a" }); // real change
  await waitUntil(() => lastValue(KEY("STATES")) === "running idle", 3000, "state change");
  assert.ok(callCount(/^set-environment -g /) > writes);
  assert.ok(callCount(/^refresh-client/) > refreshes); // tmux refreshed after the change
});

test("tabs disabled: tracks the router's current session; home route tracks nothing", async (t) => {
  fresh();
  const ctx = await boot(t, { tabsEnabled: false, route: { type: "session", sessionID: "ses_r" } });
  await waitUntil(() => lastValue(KEY("SESSIONS")) === "ses_r", 3000, "router session");
  ctx.state.route = { type: "home" };
  await waitUntil(() => lastValue(KEY("SESSIONS")) === "", 3000, "home empties the list");
});

test("a late event after cleanup does not re-publish the removed keys", async (t) => {
  fresh();
  const { cleanup, listeners } = await boot(t);
  const handler = listeners[0]; // capture before cleanup removes it
  cleanup();
  await waitUntil(() => callCount(/^set-environment -gu /) >= 3, 3000, "cleanup unsets");
  const writes = callCount(/^set-environment -g /);
  // Simulate a delivery already in flight when cleanup ran (bus buffered).
  handler?.({ details: { type: "session.execution.started", sessionID: "ses_a" } });
  await sleep(300);
  assert.equal(callCount(/^set-environment -g /), writes);
});

test("cleanup unsets all three published keys", async () => {
  fresh();
  const ctx = makeContext({ tabs: [{ sessionID: "ses_a" }] });
  const cleanup = setup(ctx.context);
  await waitUntil(() => lastValue(KEY("SESSIONS")) === "ses_a", 3000, "publish");
  const unsets = callCount(/^set-environment -gu /); // count-based: immune to stale unsets
  cleanup();
  await waitUntil(() => callCount(/^set-environment -gu /) >= unsets + 3, 3000, "three new unsets");
});
