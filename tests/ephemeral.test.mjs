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

test("normalizeQueue classifies orphan terminal bead tasks as ephemeral closed or action items", () => {
  const queue = store.normalizeQueue({
    config: { default_env: "local", envs: [{ name: "local", kind: "local" }] },
    tasks: [
      {
        id: "t-worker-done",
        bead_id: "rsc-worker-closed",
        formula_name: "worker-inplace",
        status: "done",
        steps: [],
      },
      {
        id: "t-wisp-cancelled",
        bead_id: "rsc-wisp-closed",
        formula_name: "custom-formula",
        status: "cancelled",
        steps: [],
      },
    ],
    bd: { available: true, ready_ids: [], issues: [] },
  });

  const done = queue.itemsById.get("rsc-worker-closed");
  const cancelled = queue.itemsById.get("rsc-wisp-closed");
  assert.equal(done.column, "closed");
  assert.equal(done.ephemeral, true);
  assert.equal(cancelled.column, "action");
  assert.equal(cancelled.actionReason, "cancelled");
  assert.equal(cancelled.ephemeral, true);
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

test("deferred detection, board filters, type synchronization and cache invalidation", () => {
  for (const item of [{ bdStatus: "deferred" }, { bdStatus: "backlog" }, { beadColumn: "backlog" }]) assert.equal(store.isDeferredItem(item), true);
  assert.equal(store.isDeferredItem(null), false);
  const board = new boardMod.BoardController();
  const items = [
    { id: "a", priority: 0, issueType: "Bug", env: "local", _searchText: "bug p0" },
    { id: "b", priority: 1, issueType: "TASK", env: "local", bdStatus: "deferred", _searchText: "task p1 deferred" },
    { id: "c", priority: null, issueType: "bug", env: "local", _searchText: "bug" },
    { id: "d", priority: 2, issueType: "zebra", env: "remote" },
  ];
  const queue = { items, envs: [{ name: "local" }], columns: { ready: items } };
  assert.deepEqual(board.syncTypeFilter(queue), ["bug", "task", "zebra"]);
  const hidden = board.getFilteredColumns(queue, { showDeferred: false });
  assert.deepEqual(hidden.visibleAll.map((i) => i.id), ["a", "c", "d"]);
  assert.equal(board.getFilteredColumns(queue, { showDeferred: false }), hidden);
  board.priorityFilters.add(0); board.priorityFilters.add(1);
  board.typeFilters.add("bug"); board.typeFilters.add("task");
  assert.deepEqual(board.getFilteredColumns(queue, { showDeferred: true }).visibleAll.map((i) => i.id), ["a", "b"]);
  assert.equal(board.matchesFilter(items[2]), false);
  board.envFilter = "local"; board.query = "P1";
  assert.equal(board.matchesFilter(items[1], { showDeferred: false }), false);
  assert.equal(board.matchesFilter(items[1], { showDeferred: true }), true);
  board.syncTypeFilter({ items: [items[0]] });
  assert.deepEqual([...board.typeFilters], ["bug"]);
  assert.equal(board.matchesFilter(items[1]), false);
});

test("beads backlog column follows deferred visibility", () => {
  const board = new boardMod.BoardController(null, { mode: "beads" });
  const item = { id: "d", beadId: "d", beadColumn: "backlog", issueType: "task" };
  const queue = { items: [item], beadColumns: { backlog: [item] } };
  assert.equal(board.getBoardColumns(false).some((col) => col.key === "backlog"), false);
  assert.equal(board.getBoardColumns(true).some((col) => col.key === "backlog"), true);
  assert.equal(board.getFilteredColumns(queue, { showDeferred: false }).visibleAll.length, 0);
  assert.equal(board.getFilteredColumns(queue, { showDeferred: true }).columns.backlog.length, 1);
});

test("wave data and grouped wave caches respond to deferred visibility", () => {
  const deps = new depsMod.DepsController();
  const items = [{ id: "a", issueType: "task" }, { id: "b", issueType: "task", bdStatus: "deferred", blockedBy: ["a"] }];
  const queue = { items }; const epics = []; const projects = [{ id: "a" }, { id: "b" }];
  const groups = [{ id: "a", items }];
  assert.equal(deps.scopeItems(items, epics, null, { showDeferred: false }).length, 1);
  const hidden = deps.getWaveData(queue, epics, items, { showDeferred: false });
  assert.equal(hidden.scopedItems.length, 1);
  assert.equal(deps.getWaveData(queue, epics, items, { showDeferred: false }), hidden);
  assert.equal(deps.getWaveData(queue, epics, items, { showDeferred: true }).waves.length, 2);
  const options = { showEphemeral: true, showDeferred: false, projectFilter: "all" };
  const grouped = deps.getGroupedWaveSections(queue, epics, groups, projects, options);
  assert.equal(grouped.totalNodes, 1);
  assert.equal(deps.getGroupedWaveSections(queue, epics, groups, projects, options), grouped);
  assert.equal(deps.getGroupedWaveSections(queue, epics, groups, projects, { ...options, showDeferred: true }).totalNodes, 2);
});

test("project counts combine ephemeral and deferred visibility and search indexes status, type and priority", () => {
  const snapshot = { config: {}, tasks: [], bd: { available: true, ready_ids: [], issues: [
    { id: "a", title: "A", status: "open", issue_type: "bug", priority: 1 },
    { id: "b", title: "B", status: "deferred", issue_type: "task", priority: 0 },
    { id: "c", title: "C", status: "open", issue_type: "task", ephemeral: true },
    { id: "d", title: "D", status: "deferred", issue_type: "task", ephemeral: true },
  ] } };
  const queue = store.normalizeQueue(snapshot);
  assert.match(queue.itemsById.get("a")._searchText, /bug/);
  assert.match(queue.itemsById.get("a")._searchText, /p1/);
  assert.match(queue.itemsById.get("b")._searchText, /deferred backlog/);
  const project = store.mergeNormalizedQueues([{ projectId: "a", queue }]).projects[0];
  for (const [showEphemeral, showDeferred, count] of [[true, true, 4], [false, true, 2], [true, false, 2], [false, false, 1]]) {
    assert.equal(boardMod.projectDisplayCount(project, { showEphemeral, showDeferred }), count);
    assert.equal(boardMod.projectDisplayCount(project, { showEphemeral, showDeferred, excludeClosedStats: true }), count);
  }
});

test("fetchSnapshot defaults closedLimit to all and passes --include-ephemeral only when includeEphemeral is true", async () => {
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
  const legacyRunner = {
    ...runner,
    supportsAllClosed: false,
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
      await store.fetchSnapshot(ctx, legacyRunner, { bd: true, includeEphemeral: false });
    },
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0].args.includes("--include-ephemeral"), false);
  assert.equal(calls[0].args.includes("--all-closed"), true);
  assert.equal(calls[1].args.includes("--include-ephemeral"), true);
  assert.equal(calls[1].args.includes("--all-closed"), true);
  assert.equal(calls[2].args.includes("--all-closed"), false);
  assert.deepEqual(calls[2].args.slice(calls[2].args.indexOf("--closed-limit"), calls[2].args.indexOf("--closed-limit") + 2), [
    "--closed-limit",
    "50000",
  ]);
});
