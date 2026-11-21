import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr") {
      return { url: "herdr:mock", shortCircuit: true };
    }
    if (specifier === "gpui-kit") {
      return { url: "gpui-kit:mock", shortCircuit: true };
    }
    if (specifier === "gpui-base") {
      return { url: "gpui-base:mock", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "herdr:mock") {
      return {
        format: "module",
        source: `
          const mock = () => globalThis.__roscaeliferHerdrMock || {};
          export const exec = (...args) => mock().exec?.(...args) ?? { code: 0, stdout: "", stderr: "" };
          export const checking = () => mock().checking?.() ?? true;
          export const home = () => mock().home?.() ?? "/home/tester";
          export const focused = () => mock().focused?.() ?? null;
          export const panes = () => mock().panes?.() ?? [];
          export const spaces = () => mock().spaces?.() ?? [];
          export const readTextFile = async (...args) =>
            mock().readTextFile ? mock().readTextFile(...args) : null;
          export const run = (...args) => mock().run?.(...args) ?? null;
          export const notify = (...args) => mock().notify?.(...args) ?? null;
          export const agents = () => mock().agents?.() ?? [];
          export const terminals = () => mock().terminals?.() ?? [];
          export const settings = () => mock().settings?.() ?? {};
          export const theme = () => mock().theme?.() ?? {};
        `,
        shortCircuit: true,
      };
    }
    if (url === "gpui-kit:mock") {
      return {
        format: "module",
        source: `
          function stub() { return {}; }
          stub.new = () => ({ on() {}, value: () => "", set_value() {}, focus() {} });
          export const div = stub;
          export const svg = stub;
          export const list = stub;
        `,
        shortCircuit: true,
      };
    }
    if (url === "gpui-base:mock") {
      return {
        format: "module",
        source: `
          function stub() { return {}; }
          stub.new = () => ({ on() {}, value: () => "", set_value() {}, focus() {} });
          export const v_flex = stub;
          export const h_flex = stub;
          export const Checkbox = stub;
          export const InputState = stub;
          export const Input = stub;
          export const Button = stub;
          export const Switch = stub;
          export const Tabs = stub;
          export const Tab = stub;
          export const Progress = stub;
          export const ProgressTrack = stub;
          export const ProgressIndicator = stub;
          export const ScrollHandle = stub;
          export const Scrollbar = stub;
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const store = await import("../mods/roscaelifer-queue/store.js");
const boardMod = await import("../mods/roscaelifer-queue/board.js");
const depsMod = await import("../mods/roscaelifer-queue/deps.js");

function withHerdrMock(mock, fn) {
  globalThis.__roscaeliferHerdrMock = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete globalThis.__roscaeliferHerdrMock;
    });
}

test("normalizeQueue sets ephemeral uniformly for ephemeral, legacy wip, and standalone worker items", () => {
  const queue = store.normalizeQueue({
    config: { default_env: "local", envs: [{ name: "local", kind: "local" }] },
    tasks: [
      {
        id: "t-standalone",
        bead_id: "",
        title: "Standalone worker",
        formula_name: "worker-inplace",
        status: "active",
        steps: [],
      },
    ],
    bd: {
      available: true,
      ready_ids: ["rsc-formal", "rsc-ephem", "rsc-legacy-wip"],
      issues: [
        {
          id: "rsc-formal",
          title: "Formal bead",
          status: "open",
          issue_type: "task",
          ephemeral: false,
          labels: ["roscaelifer", "formula:implement"],
        },
        {
          id: "rsc-ephem",
          title: "Ephemeral opted-in bead",
          status: "open",
          issue_type: "task",
          ephemeral: true,
          labels: ["roscaelifer", "formula:worker-inplace"],
        },
        {
          id: "rsc-legacy-wip",
          title: "Legacy wip bead",
          status: "open",
          issue_type: "task",
          ephemeral: false,
          labels: ["roscaelifer", "wip", "formula:worker-inplace"],
        },
      ],
    },
  });

  const formal = queue.itemsById.get("rsc-formal");
  const ephem = queue.itemsById.get("rsc-ephem");
  const legacyWip = queue.itemsById.get("rsc-legacy-wip");
  const standalone = queue.itemsById.get("task:t-standalone");

  assert.equal(formal.ephemeral, false);
  assert.equal(ephem.ephemeral, true);
  assert.equal(legacyWip.ephemeral, true);
  assert.equal(standalone.ephemeral, true);
  assert.equal("isWip" in formal, false);
  assert.equal("isWip" in ephem, false);
  assert.equal("isWip" in standalone, false);
});

test("BoardController.matchesFilter toggles all ephemeral items via showEphemeral", () => {
  const board = new boardMod.BoardController();
  const formal = { id: "rsc-1", ephemeral: false, env: "local", column: "ready", _searchText: "formal" };
  const ephem = { id: "wisp-1", ephemeral: true, env: "local", column: "ready", _searchText: "ephem" };
  const standalone = { id: "task:1", ephemeral: true, env: "local", column: "running", _searchText: "standalone" };

  assert.equal(board.matchesFilter(formal, { showEphemeral: true }), true);
  assert.equal(board.matchesFilter(ephem, { showEphemeral: true }), true);
  assert.equal(board.matchesFilter(standalone, { showEphemeral: true }), true);

  assert.equal(board.matchesFilter(formal, { showEphemeral: false }), true);
  assert.equal(board.matchesFilter(ephem, { showEphemeral: false }), false);
  assert.equal(board.matchesFilter(standalone, { showEphemeral: false }), false);
});

test("DepsController.scopeItems toggles ephemeral items via showEphemeral", () => {
  const deps = new depsMod.DepsController();
  const items = [
    { id: "rsc-1", issueType: "task", ephemeral: false, bdStatus: "open", column: "ready" },
    { id: "wisp-1", issueType: "task", ephemeral: true, bdStatus: "open", column: "ready" },
    { id: "task:1", issueType: "task", ephemeral: true, bdStatus: "open", column: "running" },
  ];

  const shown = deps.scopeItems(items, [], null, { showEphemeral: true });
  assert.deepEqual(
    shown.map((it) => it.id),
    ["rsc-1", "wisp-1", "task:1"],
  );

  const hidden = deps.scopeItems(items, [], null, { showEphemeral: false });
  assert.deepEqual(
    hidden.map((it) => it.id),
    ["rsc-1"],
  );
});

test("fetchSnapshot passes --include-ephemeral only when includeEphemeral is true", async () => {
  const calls = [];
  const ctx = {
    repo: "/repos/demo",
    db: "/repos/demo/.roscaelifer/roscaelifer.db",
    bdDir: "/repos/demo/.beads",
    bin: "/usr/local/bin/roscaelifer",
  };
  const runner = {
    bin: "/usr/local/bin/roscaelifer",
    supportsCompact: true,
    supportsBrief: true,
    supportsIncludeEphemeral: true,
    supportsAllClosed: true,
  };

  await withHerdrMock(
    {
      exec(cmd, args) {
        calls.push({ cmd, args });
        return { code: 0, stdout: JSON.stringify({ tasks: [], config: {}, bd: { available: true, issues: [], ready_ids: [] } }), stderr: "" };
      },
    },
    async () => {
      await store.fetchSnapshot(ctx, runner, { bd: true, includeEphemeral: false });
      await store.fetchSnapshot(ctx, runner, { bd: true, includeEphemeral: true });
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes("--include-ephemeral"), false);
  assert.equal(calls[1].args.includes("--include-ephemeral"), true);
});
