import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// `store.js` imports `herdr`, which only exists inside the Herdr UI runtime.
// Mock it so project config + queue merging can be exercised under plain node.
// `board.js` additionally imports the GPUI element builders, which only exist
// inside the runtime too, so those are stubbed as well: the pure helpers under
// test never call them.
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
const actionsMod = await import("../mods/roscaelifer-queue/actions.js");
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

function project(id, name, overrides = {}) {
  return {
    id,
    name,
    repo: `/repos/${id}`,
    machine: "",
    db: `/repos/${id}/.roscaelifer/roscaelifer.db`,
    bdDir: `/repos/${id}/.beads`,
    config: `/repos/${id}/roscaelifer.toml`,
    formulasDir: `/repos/${id}/formulas`,
    bin: "",
    env: "",
    updatedAt: 0,
    ...overrides,
  };
}

function makeQueue(projectId, items, extra = {}) {
  const columns = { ready: [], queue: [], running: [], action: [], review: [], closed: [] };
  const beadColumns = { backlog: [], ready: [], in_progress: [], blocked: [], closed: [] };
  for (const item of items) {
    if (columns[item.column]) columns[item.column].push(item);
    if (item.beadId && beadColumns[item.beadColumn]) beadColumns[item.beadColumn].push(item);
  }
  return {
    items,
    columns,
    beadColumns,
    epics: [],
    envs: [{ name: "local", kind: "local", maxRunning: 2, runningWorkSteps: 1 }],
    formulas: [{ name: "worker-inplace" }, { name: `${projectId}-only` }],
    events: [],
    mirrorIntegrations: [],
    intakePreview: [],
    runner: { active: false, lock_held: false, db: `/repos/${projectId}/.roscaelifer/roscaelifer.db` },
    bdAvailable: true,
    bdError: null,
    defaultEnv: "local",
    generatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function makeItem(id, overrides = {}) {
  return {
    id,
    beadId: id,
    taskId: null,
    title: `Item ${id}`,
    column: "ready",
    beadColumn: "ready",
    priority: 2,
    labels: [],
    isOptedIn: false,
    isReady: true,
    agentStatus: null,
    project: null,
    _searchText: String(id).toLowerCase(),
    ...overrides,
  };
}

test("normalizeProjectsConfig keeps legacy configs single-project and drops stale pins", () => {
  const legacy = store.normalizeProjectsConfig({
    version: 1,
    activeProject: "alpha",
    projects: [project("alpha", "Alpha")],
  });
  assert.equal(legacy.panelMode, "single");
  assert.deepEqual(legacy.pinnedProjects, []);
  assert.equal(legacy.version, 1);

  const multi = store.normalizeProjectsConfig({
    version: 1,
    activeProject: "alpha",
    panelMode: "multi",
    pinnedProjects: ["beta", "beta", "missing", "", "alpha", 42],
    projects: [project("alpha", "Alpha"), project("beta", "Beta")],
  });
  assert.equal(multi.panelMode, "multi");
  assert.deepEqual(multi.pinnedProjects, ["beta", "alpha"]);
  assert.equal(multi.activeProject, "alpha");

  const bogusMode = store.normalizeProjectsConfig({
    version: 1,
    activeProject: "",
    panelMode: "everything",
    projects: [],
  });
  assert.equal(bogusMode.panelMode, "single");
  assert.deepEqual(bogusMode.projects, []);
});

test("setPanelProjectsConfig persists panelMode + pinnedProjects headlessly", async () => {
  const raw = JSON.stringify({
    version: 1,
    activeProject: "alpha",
    projects: [project("alpha", "Alpha"), project("beta", "Beta")],
  });
  await withHerdrMock(
    {
      checking: () => true,
      home: () => "/home/tester",
      readTextFile: async () => raw,
    },
    async () => {
      const saved = await store.setPanelProjectsConfig({
        panelMode: "multi",
        pinnedProjects: ["beta", "alpha", "beta"],
      });
      assert.equal(saved.panelMode, "multi");
      assert.deepEqual(saved.pinnedProjects, ["beta", "alpha"]);
      assert.equal(saved.activeProject, "alpha");

      const single = await store.setPanelProjectsConfig({
        panelMode: "single",
        pinnedProjects: ["beta", "alpha"],
      });
      assert.equal(single.panelMode, "single");
      assert.deepEqual(single.pinnedProjects, ["beta", "alpha"]);
    },
  );
});

test("resolveWorkspaceProjects honours active, pinned and block-level props", async () => {
  const config = store.normalizeProjectsConfig({
    version: 1,
    activeProject: "alpha",
    panelMode: "multi",
    pinnedProjects: ["alpha", "beta"],
    projects: [project("alpha", "Alpha"), project("beta", "Beta"), project("gamma", "Gamma")],
  });

  const workspace = store.resolveWorkspaceProjects(config, {});
  assert.equal(workspace.mode, "multi");
  assert.deepEqual(
    workspace.projects.map((ctx) => ctx.projectId),
    ["alpha", "beta"],
  );
  assert.equal(workspace.projects[0].label, "Alpha");

  const single = store.resolveWorkspaceProjects(
    store.normalizeProjectsConfig({ ...config, panelMode: "single" }),
    {},
  );
  assert.equal(single.mode, "single");
  assert.deepEqual(single.projects.map((ctx) => ctx.projectId), ["alpha"]);

  const override = store.resolveWorkspaceProjects(config, {
    projects: [project("gamma", "Gamma"), project("alpha", "Alpha")],
  });
  assert.equal(override.mode, "multi");
  assert.deepEqual(override.projects.map((ctx) => ctx.projectId), ["gamma", "alpha"]);

  const emptyPins = store.resolveWorkspaceProjects(
    store.normalizeProjectsConfig({ ...config, pinnedProjects: [] }),
    {},
  );
  assert.deepEqual(emptyPins.projects.map((ctx) => ctx.projectId), ["alpha"]);
});

test("mergeNormalizedQueues namespaces ids and keeps raw ids for routing", () => {
  const alphaCtx = { projectId: "alpha", repo: "/repos/alpha", db: "/repos/alpha/db.sqlite" };
  const betaCtx = { projectId: "beta", repo: "/repos/beta", db: "/repos/beta/db.sqlite" };
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "alpha",
      projectName: "Alpha",
      projectCtx: alphaCtx,
      queue: makeQueue("alpha", [
        makeItem("rsc-1", { priority: 1, isOptedIn: true }),
        makeItem("rsc-2", { column: "running", beadColumn: "in_progress", taskId: "77" }),
      ]),
    },
    {
      projectId: "beta",
      projectName: "Beta",
      projectCtx: betaCtx,
      queue: makeQueue("beta", [makeItem("rsc-1", { priority: 0 })]),
    },
  ]);

  const ids = merged.items.map((item) => item.id).sort();
  assert.deepEqual(ids, ["alpha::rsc-1", "alpha::rsc-2", "beta::rsc-1"]);
  const alphaItem = merged.itemsById.get("alpha::rsc-1");
  assert.equal(alphaItem.rawId, "rsc-1");
  assert.equal(alphaItem.beadId, "rsc-1");
  assert.equal(alphaItem.projectId, "alpha");
  assert.equal(alphaItem.projectName, "Alpha");
  assert.equal(alphaItem.projectCtx, alphaCtx);
  assert.match(alphaItem.projectColor, /^#[0-9a-f]{6}$/i);
  assert.equal(merged.itemsById.get("beta::rsc-1").projectCtx, betaCtx);
  assert.equal(merged.itemsById.get("beta::rsc-1").projectId, "beta");
  // Search text keeps the project name searchable.
  assert.match(alphaItem._searchText, /alpha/);

  // beta::rsc-1 is P0 so it leads the merged Ready column.
  assert.deepEqual(
    merged.columns.ready.map((item) => item.uid),
    ["beta::rsc-1", "alpha::rsc-1"],
  );
  assert.deepEqual(merged.beadColumns.in_progress.map((item) => item.uid), ["alpha::rsc-2"]);
  assert.equal(merged.panelMode, "multi");
  assert.deepEqual(
    merged.projects.map((p) => [p.id, p.name, p.itemCount]),
    [
      ["alpha", "Alpha", 2],
      ["beta", "Beta", 1],
    ],
  );
  // Same project id always gets the same color.
  assert.equal(store.projectColorFor("alpha"), alphaItem.projectColor);
});

test("mergeNormalizedQueues keeps healthy projects when one fails", () => {
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "alpha",
      projectName: "Alpha",
      queue: makeQueue("alpha", [makeItem("rsc-1")]),
    },
    {
      status: "rejected",
      reason: new Error("snapshot exited 1"),
      projectId: "beta",
      projectName: "Beta",
    },
  ]);

  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].uid, "alpha::rsc-1");
  assert.equal(merged.error, null);
  const beta = merged.projects.find((p) => p.id === "beta");
  assert.equal(beta.error, "snapshot exited 1");
  assert.equal(beta.itemCount, 0);
  const alpha = merged.projects.find((p) => p.id === "alpha");
  assert.equal(alpha.error, null);
  // Beta still reports an idle runner in the aggregate.
  assert.equal(merged.runner.total, 2);
  assert.equal(merged.runner.activeCount, 0);

  const allFailed = store.mergeNormalizedQueues([
    { status: "rejected", reason: "alpha down", projectId: "alpha", projectName: "Alpha" },
    { status: "rejected", reason: "beta down", projectId: "beta", projectName: "Beta" },
  ]);
  assert.equal(allFailed.items.length, 0);
  assert.match(allFailed.error, /alpha down/);
  assert.match(allFailed.error, /beta down/);
});

test("mergeNormalizedQueues merges envs, events and mirror integrations per project", () => {
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "alpha",
      projectName: "Alpha",
      queue: makeQueue("alpha", [makeItem("rsc-1")], {
        envs: [{ name: "local", maxRunning: 2, runningWorkSteps: 1 }],
        events: [
          { id: 1, created_at: "2026-01-01T00:00:00Z", task_id: "1", to: "running" },
          { id: 2, created_at: "2026-01-03T00:00:00Z", task_id: "1", to: "done" },
        ],
        mirrorIntegrations: [{ group_id: "g1", status: "merged" }],
        runner: { active: true, lock_held: true, pid: 111, db: "/repos/alpha/db" },
      }),
    },
    {
      projectId: "beta",
      projectName: "Beta",
      queue: makeQueue("beta", [makeItem("rsc-1")], {
        envs: [
          { name: "local", maxRunning: 5, runningWorkSteps: 3 },
          { name: "gpu", maxRunning: 1, runningWorkSteps: 1 },
        ],
        events: [{ id: 3, created_at: "2026-01-02T00:00:00Z", task_id: "9", to: "queued" }],
        mirrorIntegrations: [{ group_id: "g2", status: "conflict" }],
        runner: { active: false, lock_held: false, pid: null, db: "/repos/beta/db" },
      }),
    },
  ]);

  const local = merged.envsByName.get("local");
  assert.equal(local.runningWorkSteps, 4);
  assert.equal(local.maxRunning, 5);
  assert.deepEqual(Object.keys(local.byProject).sort(), ["alpha", "beta"]);
  assert.equal(merged.envsByName.get("gpu").runningWorkSteps, 1);
  assert.deepEqual(merged.formulas.map((f) => f.name), ["worker-inplace", "alpha-only", "beta-only"]);

  // Newest event first, each tagged with its owning project.
  assert.deepEqual(
    merged.events.map((ev) => [ev.id, ev.projectId, ev.projectName]),
    [
      [2, "alpha", "Alpha"],
      [3, "beta", "Beta"],
      [1, "alpha", "Alpha"],
    ],
  );
  assert.deepEqual(
    merged.mirrorIntegrations.map((mi) => [mi.group_id, mi.projectId]),
    [
      ["g1", "alpha"],
      ["g2", "beta"],
    ],
  );
  assert.equal(merged.runner.active, true);
  assert.equal(merged.runner.activeCount, 1);
  assert.equal(merged.runner.total, 2);
  assert.deepEqual(
    merged.runner.perProject.map((p) => [p.projectId, p.active, p.db]),
    [
      ["alpha", true, "/repos/alpha/db"],
      ["beta", false, "/repos/beta/db"],
    ],
  );
});

test("saveGlobalProjectsConfig writes panelMode and pinnedProjects into projects.json", async () => {
  const writes = [];
  await withHerdrMock(
    {
      checking: () => false,
      home: () => "/home/tester",
      exec: async (cmd, args) => {
        writes.push({ cmd, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async () => {
      const saved = await store.saveGlobalProjectsConfig({
        version: 1,
        activeProject: "alpha",
        panelMode: "multi",
        pinnedProjects: ["alpha", "beta"],
        projects: [project("alpha", "Alpha"), project("beta", "Beta")],
      });
      assert.equal(writes.length, 1);
      const payload = JSON.parse(writes[0].args[4]);
      assert.equal(payload.panelMode, "multi");
      assert.deepEqual(payload.pinnedProjects, ["alpha", "beta"]);
      assert.equal(payload.activeProject, "alpha");
      assert.equal(Object.keys(payload.projects).length, 2);
      assert.equal(saved.panelMode, "multi");
    },
  );
});

test("mergeNormalizedQueues namespaces epics and remaps their children", () => {
  const item = makeItem("rsc-1", { parent: "rsc-epic" });
  const queue = makeQueue("alpha", [item], {
    epics: [
      {
        id: "rsc-epic",
        title: "Epic",
        status: "open",
        children: [item],
        counts: { total: 1, closed: 0, review: 0 },
        progress: 0,
      },
    ],
  });
  const merged = store.mergeNormalizedQueues([{ projectId: "alpha", projectName: "Alpha", queue }]);
  const epic = merged.epics[0];
  assert.equal(epic.id, "alpha::rsc-epic");
  assert.equal(epic.rawId, "rsc-epic");
  assert.equal(epic.projectId, "alpha");
  assert.equal(epic.children[0].uid, "alpha::rsc-1");
  assert.equal(merged.itemsById.get("alpha::rsc-epic").issueType, "epic");
});

test("mergeNormalizedQueues accepts raw snapshots and namespaces them too", () => {
  const snapshot = {
    schema_version: 3,
    config: { default_env: "local", envs: [], formulas: [] },
    tasks: [],
    bd: {
      available: true,
      issues: [
        {
          id: "rsc-9",
          title: "From snapshot",
          status: "open",
          priority: 2,
          issue_type: "task",
        },
      ],
      ready_ids: ["rsc-9"],
    },
    events: [],
    runner: { active: false, lock_held: false },
    generated_at: "2026-02-02T00:00:00Z",
  };
  const merged = store.mergeNormalizedQueues(
    [{ projectId: "gamma", projectName: "Gamma", snapshot }],
    { agents: [], terminals: [], spaces: [], panes: [] },
  );
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].id, "gamma::rsc-9");
  assert.equal(merged.items[0].beadId, "rsc-9");
  assert.equal(merged.items[0].projectName, "Gamma");
});

function makeActionsClient() {
  return actionsMod.createActions({
    getCtx: () => null,
    getRunner: () => null,
    onBusyChange: () => {},
    onRefresh: async () => {},
  });
}

test("resolveWorktreeOwnerSpace matches envSpace by id, machine-prefixed id and name", () => {
  const local = { id: "space-local", name: "Local Space", folder: "/repos/alpha", machine: "" };
  const remote = { id: "m1/space-remote", name: "remote-env", folder: "/repos/beta", machine: "m1" };
  const spaces = [local, remote];

  assert.equal(actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "space-local" }), local);
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "space-local", machine: "" }),
    local,
  );
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "space-remote", machine: "m1" }),
    remote,
  );
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "m1/space-remote", machine: "m1" }),
    remote,
  );
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "remote-env", machine: "m1" }),
    remote,
  );
  // An envSpace from another machine must not match.
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({ spaces, envSpace: "space-local", machine: "m1" }),
    null,
  );
  assert.equal(actionsMod.resolveWorktreeOwnerSpace({ spaces }), null);
});

test("resolveWorktreeOwnerSpace takes the deepest project folder and skips container dirs", () => {
  const homeDir = "/Users/tester";
  const repo = { id: "space-repo", name: "Repo", folder: "/Users/tester/work/roscaelifer/", machine: "" };
  const workRoot = { id: "space-work", name: "Work", folder: "/Users/tester/work", machine: "" };
  const spaces = [workRoot, repo];

  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({
      spaces,
      projectRepo: "/Users/tester/work/roscaelifer",
      homeDir,
    }),
    repo,
  );
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({
      spaces,
      projectRepo: "/Users/tester/work/roscaelifer/.worktrees/wt-1",
      homeDir,
    }),
    repo,
  );
  // Prefix must land on a real path segment boundary.
  assert.equal(
    actionsMod.resolveWorktreeOwnerSpace({
      spaces: [{ id: "space-x", name: "X", folder: "/Users/tester/work/rosc", machine: "" }],
      projectRepo: "/Users/tester/work/roscaelifer",
      homeDir,
    }),
    null,
  );
  // Container directories never own a worktree.
  const containers = [
    "/",
    "/tmp",
    "/private/tmp",
    "/Users",
    "/home",
    homeDir,
    `${homeDir}/code`,
    `${homeDir}/work`,
    `${homeDir}/worktrees`,
  ];
  for (const folder of containers) {
    const container = { id: `space-${folder}`, name: folder, folder, machine: "" };
    assert.equal(
      actionsMod.resolveWorktreeOwnerSpace({
        spaces: [container],
        projectRepo: `${homeDir}/work/roscaelifer`,
        homeDir,
      }),
      null,
      `expected ${folder} not to own a worktree`,
    );
  }
});

test("openWorktree selects the owning space and opens a tab there", async () => {
  const runs = [];
  const owner = { id: "space-repo", name: "Repo", folder: "/Users/tester/work/roscaelifer", machine: "" };
  await withHerdrMock(
    {
      spaces: () => [owner],
      home: () => "/Users/tester",
      run: (...args) => runs.push(args),
    },
    async () => {
      const actions = makeActionsClient();
      actions.openWorktree({
        name: "rsc-1",
        folder: "/Users/tester/work/roscaelifer/.worktrees/wt-1",
        projectRepo: "/Users/tester/work/roscaelifer",
      });
    },
  );

  assert.deepEqual(runs, [
    ["space.select", { id: "space-repo" }],
    [
      "tab.new",
      {
        space: "space-repo",
        folder: "/Users/tester/work/roscaelifer/.worktrees/wt-1",
        name: "rsc-1",
      },
    ],
  ]);
  assert.equal(runs.some(([action]) => action === "space.new"), false);
});

test("openWorktree matches remote spaces by machine", async () => {
  const runs = [];
  const local = { id: "space-local", name: "Repo", folder: "/repos/alpha", machine: "" };
  const remote = { id: "m1/space-remote", name: "Repo Remote", folder: "/repos/alpha", machine: "m1" };
  await withHerdrMock(
    {
      spaces: () => [local, remote],
      home: () => "/Users/tester",
      run: (...args) => runs.push(args),
    },
    async () => {
      const actions = makeActionsClient();
      actions.openWorktree({ folder: "/repos/alpha/wt", machine: "m1", projectRepo: "/repos/alpha" });
    },
  );

  assert.deepEqual(runs, [
    ["space.select", { id: "m1/space-remote" }],
    ["tab.new", { space: "m1/space-remote", folder: "/repos/alpha/wt" }],
  ]);
});

test("openWorktree falls back to space.new when no owning space matches", async () => {
  const runs = [];
  const containerOnly = { id: "space-work", name: "Work", folder: "/Users/tester/work", machine: "" };
  await withHerdrMock(
    {
      spaces: () => [containerOnly],
      home: () => "/Users/tester",
      run: (...args) => runs.push(args),
    },
    async () => {
      const actions = makeActionsClient();
      actions.openWorktree({
        name: "rsc-2",
        folder: "/tmp/wt-2",
        machine: "",
        projectRepo: "/elsewhere/repo",
      });
      actions.openWorktree({ folder: "/tmp/wt-3" });
    },
  );

  assert.deepEqual(runs, [
    ["space.new", { folder: "/tmp/wt-2", name: "rsc-2" }],
    ["space.new", { folder: "/tmp/wt-3" }],
  ]);
});

test("shouldVirtualizeColumn always virtualizes closed and only long active columns", () => {
  const { shouldVirtualizeColumn, VIRTUALIZE_COLUMN_THRESHOLD } = boardMod;
  assert.equal(VIRTUALIZE_COLUMN_THRESHOLD, 20);

  // `closed` is unbounded, so it is virtualized even when empty.
  assert.equal(shouldVirtualizeColumn("closed", 0), true);
  assert.equal(shouldVirtualizeColumn("closed", 3), true);
  assert.equal(shouldVirtualizeColumn("closed", 5000), true);

  // Active columns keep their inline action buttons until they get long.
  for (const key of [
    "backlog",
    "ready",
    "queue",
    "running",
    "in_progress",
    "blocked",
    "action",
    "review",
  ]) {
    assert.equal(shouldVirtualizeColumn(key, 0), false, key);
    assert.equal(shouldVirtualizeColumn(key, 20), false, key);
    assert.equal(shouldVirtualizeColumn(key, 21), true, key);
    assert.equal(shouldVirtualizeColumn(key, 94), true, key);
  }
});

test("BoardController.scrollBy keeps fractional offsets but only notifies on integer moves", () => {
  const scrollBy = boardMod.BoardController.prototype.scrollBy;
  const notifies = [];
  const cx = { notify: () => notifies.push("notify") };
  const board = Object.assign(Object.create(boardMod.BoardController.prototype), {
    scrollX: 10,
    viewportW: 100,
    contentW: 500,
    _minContentW: 0,
  });

  // 10 -> 9.6 renders at the same integer offset, so no rebuild.
  scrollBy.call(board, 0.4, cx);
  assert.equal(board.scrollX, 9.6);
  assert.deepEqual(notifies, []);

  // 9.6 -> 9.2 crosses into the next pixel.
  scrollBy.call(board, 0.4, cx);
  assert.equal(board.scrollX, 9.2);
  assert.equal(Math.round(board.scrollX), 9);
  assert.deepEqual(notifies, ["notify"]);

  // Clamped at the left edge: no change, no notify.
  board.scrollX = 0;
  scrollBy.call(board, 12, cx);
  assert.equal(board.scrollX, 0);
  assert.deepEqual(notifies, ["notify"]);

  // Clamped at the right edge.
  board.scrollX = 395;
  notifies.length = 0;
  scrollBy.call(board, -12, cx);
  assert.equal(board.scrollX, 400);
  assert.deepEqual(notifies, ["notify"]);
});

test("DepsController.scrollWavesBy keeps fractional offsets but only notifies on integer moves", () => {
  const scrollWavesBy = depsMod.DepsController.prototype.scrollWavesBy;
  const notifies = [];
  const cx = { notify: () => notifies.push("notify") };
  const deps = Object.assign(Object.create(depsMod.DepsController.prototype), {
    wavesScrollX: 10,
    wavesViewportW: 100,
    wavesContentW: 500,
    _minWavesContentW: 0,
  });

  scrollWavesBy.call(deps, 0.4, cx);
  assert.equal(deps.wavesScrollX, 9.6);
  assert.deepEqual(notifies, []);

  scrollWavesBy.call(deps, 0.4, cx);
  assert.equal(Math.round(deps.wavesScrollX), 9);
  assert.deepEqual(notifies, ["notify"]);
});

test("BoardController.maxScrollX and scrollBy refuse unmeasured viewports and clamp to _minContentW", () => {
  const { maxScrollX, clampScrollX, scrollBy } = boardMod.BoardController.prototype;
  const notifies = [];
  const cx = { notify: () => notifies.push("notify") };
  const board = Object.assign(Object.create(boardMod.BoardController.prototype), {
    scrollX: 0,
    viewportW: 0,
    contentW: 1560,
    _minContentW: 1560,
  });

  // Unmeasured viewport must not scroll past 0 into blank space.
  assert.equal(maxScrollX.call(board), 0);
  scrollBy.call(board, -200, cx);
  assert.equal(board.scrollX, 0);
  assert.deepEqual(notifies, []);

  // Measured viewport strictly clamps to _minContentW even if contentW is stale/larger.
  board.viewportW = 1000;
  board.contentW = 2400;
  board._minContentW = 1560;
  assert.equal(maxScrollX.call(board), 560);
  scrollBy.call(board, -9999, cx);
  assert.equal(board.scrollX, 560);
  assert.deepEqual(notifies, ["notify"]);

  // Viewport wider than content allows zero horizontal scroll.
  board.viewportW = 1600;
  assert.equal(maxScrollX.call(board), 0);
  assert.equal(clampScrollX.call(board), true);
  assert.equal(board.scrollX, 0);

  // Non-finite wheel deltas are ignored.
  board.viewportW = 1000;
  notifies.length = 0;
  scrollBy.call(board, Number.NaN, cx);
  assert.equal(board.scrollX, 0);
  assert.deepEqual(notifies, []);
});

test("DepsController.maxWavesScrollX and scrollWavesBy refuse unmeasured viewports and clamp to _minWavesContentW", () => {
  const { maxWavesScrollX, clampWavesScrollX, scrollWavesBy } = depsMod.DepsController.prototype;
  const notifies = [];
  const cx = { notify: () => notifies.push("notify") };
  const deps = Object.assign(Object.create(depsMod.DepsController.prototype), {
    wavesScrollX: 0,
    wavesViewportW: 0,
    wavesContentW: 1170,
    _minWavesContentW: 1170,
  });

  // Unmeasured viewport must not scroll past 0.
  assert.equal(maxWavesScrollX.call(deps), 0);
  scrollWavesBy.call(deps, -150, cx);
  assert.equal(deps.wavesScrollX, 0);
  assert.deepEqual(notifies, []);

  // Measured viewport clamps strictly to _minWavesContentW even if wavesContentW is stale/larger.
  deps.wavesViewportW = 800;
  deps.wavesContentW = 2000;
  deps._minWavesContentW = 1170;
  assert.equal(maxWavesScrollX.call(deps), 370);
  scrollWavesBy.call(deps, -5000, cx);
  assert.equal(deps.wavesScrollX, 370);
  assert.deepEqual(notifies, ["notify"]);

  // Viewport wider than waves or empty waves (0) clamps back to 0.
  deps.wavesViewportW = 1200;
  assert.equal(maxWavesScrollX.call(deps), 0);
  assert.equal(clampWavesScrollX.call(deps), true);
  assert.equal(deps.wavesScrollX, 0);

  deps.wavesViewportW = 800;
  deps.wavesScrollX = 200;
  deps.wavesContentW = 0;
  deps._minWavesContentW = 0;
  assert.equal(maxWavesScrollX.call(deps), 0);
  assert.equal(clampWavesScrollX.call(deps), true);
  assert.equal(deps.wavesScrollX, 0);

  // Non-finite wheel deltas are ignored.
  notifies.length = 0;
  scrollWavesBy.call(deps, Number.NaN, cx);
  assert.equal(deps.wavesScrollX, 0);
  assert.deepEqual(notifies, []);
});

test("findEventItem resolves events through an O(1) project-scoped index", () => {
  const proto = depsMod.DepsController.prototype;
  const items = [
    makeItem("alpha::rsc-1", { id: "alpha::rsc-1", taskId: "7", projectId: "alpha" }),
    makeItem("beta::rsc-1", { id: "beta::rsc-1", taskId: "7", projectId: "beta" }),
    makeItem("alpha::rsc-9", { id: "alpha::rsc-9", beadId: "rsc-9", projectId: "alpha" }),
  ];
  const index = proto.buildEventItemIndex.call({}, items);

  assert.equal(proto.findEventItem.call({}, index, "7", "alpha").id, "alpha::rsc-1");
  assert.equal(proto.findEventItem.call({}, index, "7", "beta").id, "beta::rsc-1");
  // bead ids and raw ids both resolve.
  assert.equal(proto.findEventItem.call({}, index, "rsc-9", "alpha").id, "alpha::rsc-9");
  // A task from another project never links to a same-numbered item.
  assert.equal(proto.findEventItem.call({}, index, "7", "gamma"), null);
  // Without a project tag the first match wins.
  assert.equal(proto.findEventItem.call({}, index, "7", null).id, "alpha::rsc-1");
  // Unknown or empty task ids link to nothing.
  assert.equal(proto.findEventItem.call({}, index, "404", "alpha"), null);
  assert.equal(proto.findEventItem.call({}, index, "", "alpha"), null);
});

test("isClosedQueueItem treats closed column and fallback closed statuses accurately", () => {
  const { isClosedQueueItem } = store;

  assert.equal(isClosedQueueItem({ column: "closed", bdStatus: "closed" }), true);
  assert.equal(isClosedQueueItem({ beadId: null, taskStatus: "done", column: "closed" }), true);
  assert.equal(isClosedQueueItem({ beadId: null, taskStatus: "cancelled", column: "closed", actionReason: null }), true);
  // Pre-closed beads awaiting review or still running stay active/open.
  assert.equal(isClosedQueueItem({ bdStatus: "closed", column: "review" }), false);
  assert.equal(isClosedQueueItem({ bdStatus: "closed", column: "running" }), false);
  assert.equal(isClosedQueueItem({ column: "ready", bdStatus: "open" }), false);
  assert.equal(isClosedQueueItem({ column: "queue", bdStatus: "open" }), false);
  assert.equal(isClosedQueueItem({ column: "action", taskStatus: "failed" }), false);
  // Fallback when column is absent.
  assert.equal(isClosedQueueItem({ bdStatus: "closed" }), true);
  assert.equal(isClosedQueueItem({ status: "closed" }), true);
  assert.equal(isClosedQueueItem({ status: "open" }), false);
  assert.equal(isClosedQueueItem(null), false);
});

test("mergeNormalizedQueues computes openItemCount and closedItemCount per project", () => {
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "alpha",
      projectName: "Alpha",
      queue: makeQueue("alpha", [
        makeItem("rsc-1", { column: "ready", bdStatus: "open" }),
        makeItem("rsc-2", { column: "running", bdStatus: "in_progress" }),
        makeItem("rsc-3", { column: "review", bdStatus: "closed" }),
        makeItem("rsc-4", { column: "closed", beadColumn: "closed", bdStatus: "closed" }),
        makeItem("task:99", { beadId: null, column: "closed", taskStatus: "done", bdStatus: null }),
      ]),
    },
    {
      status: "rejected",
      reason: new Error("down"),
      projectId: "beta",
      projectName: "Beta",
    },
  ]);

  const alpha = merged.projects.find((p) => p.id === "alpha");
  assert.equal(alpha.itemCount, 5);
  assert.equal(alpha.openItemCount, 3);
  assert.equal(alpha.closedItemCount, 2);

  const beta = merged.projects.find((p) => p.id === "beta");
  assert.equal(beta.itemCount, 0);
  assert.equal(beta.openItemCount, 0);
  assert.equal(beta.closedItemCount, 0);
});

test("projectDisplayCount and totalProjectsDisplayCount toggle closed stats exclusion", () => {
  const { projectDisplayCount, totalProjectsDisplayCount } = boardMod;
  const projects = [
    { id: "a", itemCount: 185, openItemCount: 12, closedItemCount: 173 },
    { id: "b", itemCount: 170, openItemCount: 5, closedItemCount: 165 },
    { id: "c", itemCount: 20 },
  ];

  assert.equal(projectDisplayCount(projects[0], { excludeClosedStats: false }), 185);
  assert.equal(projectDisplayCount(projects[0], { excludeClosedStats: true }), 12);
  // Falls back to itemCount when openItemCount is absent.
  assert.equal(projectDisplayCount(projects[2], { excludeClosedStats: true }), 20);
  assert.equal(projectDisplayCount(null, { excludeClosedStats: true }), null);

  assert.equal(totalProjectsDisplayCount(projects, { excludeClosedStats: false }), 375);
  assert.equal(totalProjectsDisplayCount(projects, { excludeClosedStats: true }), 37);
});

test("project display counts combine showEphemeral and countClosedStats consistently", () => {
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "alpha",
      projectName: "Alpha",
      queue: makeQueue("alpha", [
        makeItem("rsc-open", { ephemeral: false, column: "ready", bdStatus: "open" }),
        makeItem("rsc-ephemeral-closed", {
          ephemeral: true,
          column: "closed",
          beadColumn: "closed",
          bdStatus: "closed",
        }),
      ]),
    },
    {
      projectId: "beta",
      projectName: "Beta",
      queue: makeQueue("beta", [
        makeItem("rsc-only-ephemeral-closed", {
          ephemeral: true,
          column: "closed",
          beadColumn: "closed",
          bdStatus: "closed",
        }),
      ]),
    },
  ]);

  const alpha = merged.projects.find((project) => project.id === "alpha");
  const beta = merged.projects.find((project) => project.id === "beta");
  assert.deepEqual(
    [alpha.itemCount, alpha.openItemCount, alpha.closedItemCount],
    [2, 1, 1],
  );
  assert.deepEqual(
    [alpha.nonEphemeralItemCount, alpha.nonEphemeralOpenItemCount, alpha.nonEphemeralClosedItemCount],
    [1, 1, 0],
  );
  assert.deepEqual(
    [beta.itemCount, beta.openItemCount, beta.closedItemCount],
    [1, 0, 1],
  );
  assert.deepEqual(
    [beta.nonEphemeralItemCount, beta.nonEphemeralOpenItemCount, beta.nonEphemeralClosedItemCount],
    [0, 0, 0],
  );

  const { projectDisplayCount, totalProjectsDisplayCount } = boardMod;
  const projects = merged.projects;
  for (const showEphemeral of [false, true]) {
    for (const countClosedStats of [false, true]) {
      const excludeClosedStats = !countClosedStats;
      const alphaCount = projectDisplayCount(alpha, { showEphemeral, excludeClosedStats });
      const betaCount = projectDisplayCount(beta, { showEphemeral, excludeClosedStats });
      const total = totalProjectsDisplayCount(projects, { showEphemeral, excludeClosedStats });
      if (!countClosedStats) {
        assert.equal(alphaCount, 1);
        assert.equal(betaCount, 0);
        assert.equal(total, 1);
      } else if (showEphemeral) {
        assert.equal(alphaCount, 2);
        assert.equal(betaCount, 1);
        assert.equal(total, 3);
      } else {
        assert.equal(alphaCount, 1);
        assert.equal(betaCount, 0);
        assert.equal(total, 1);
      }
    }
  }
});

test("normalizeQueue resolves dispatch model from attempt, vars, metadata, and static formula steps while ignoring templates", () => {
  const queue = store.normalizeQueue({
    config: {
      default_env: "local",
      envs: [{ name: "local", kind: "local" }],
      formulas: [
        {
          name: "static-formula",
          vars: { provider: "pi", model: "formula-var-model" },
          steps: [
            { id: "work", kind: "work", provider: "claude-worker", model: "group/strong" },
          ],
        },
        {
          name: "templated-formula",
          vars: { provider: "pi-worker", model: "group/cheap" },
          steps: [
            { id: "work", kind: "work", provider: "{{.Vars.provider}}", model: "{{.Vars.model}}" },
          ],
        },
      ],
    },
    tasks: [
      {
        id: "t-attempt",
        title: "Attempt model wins",
        bead_id: "rsc-1",
        formula_name: "static-formula",
        status: "active",
        vars: { provider: "var-prov", model: "var-model" },
        steps: [
          {
            step_id: "work",
            kind: "work",
            status: "running",
            current_attempt: {
              n: 1,
              status: "running",
              thread_id: "herdr:local:t1",
              provider: "pi-worker",
              model: "group/cheap",
            },
          },
        ],
      },
      {
        id: "t-vars",
        title: "Task vars fallback",
        bead_id: "rsc-2",
        formula_name: "templated-formula",
        status: "active",
        vars: { provider: "claude-worker", model: "group/standard" },
        steps: [
          { step_id: "work", kind: "work", status: "pending" },
        ],
      },
      {
        id: "t-template-skip",
        title: "Ignores unrendered template and falls back to formula vars",
        formula_name: "templated-formula",
        status: "active",
        vars: {},
        steps: [
          { step_id: "work", kind: "work", status: "running" },
        ],
      },
    ],
    bd: {
      available: true,
      ready_ids: ["rsc-3"],
      issues: [
        { id: "rsc-1", title: "Issue 1", status: "in_progress", labels: ["roscaelifer"] },
        { id: "rsc-2", title: "Issue 2", status: "open", labels: ["roscaelifer"] },
        {
          id: "rsc-3",
          title: "Metadata fallback",
          status: "open",
          labels: ["roscaelifer", "formula:static-formula"],
          metadata: {
            "roscaelifer.var.provider": "pi-worker",
            "roscaelifer.var.model": "group/fast",
          },
        },
        {
          id: "rsc-4",
          title: "Static formula step fallback",
          status: "open",
          labels: ["roscaelifer", "formula:static-formula"],
        },
      ],
    },
  });

  const byId = new Map(queue.items.map((item) => [item.id, item]));
  const i1 = byId.get("rsc-1");
  assert.equal(i1.dispatchProvider, "pi-worker");
  assert.equal(i1.dispatchModel, "group/cheap");
  assert.equal(i1.dispatchModelLabel, "pi-worker · group/cheap");
  assert.equal(i1.currentStep.currentAttempt.provider, "pi-worker");
  assert.equal(i1.currentStep.currentAttempt.model, "group/cheap");

  const i2 = byId.get("rsc-2");
  assert.equal(i2.dispatchModelLabel, "claude-worker · group/standard");

  const i3 = byId.get("rsc-3");
  assert.equal(i3.dispatchModelLabel, "pi-worker · group/fast");

  const i4 = byId.get("rsc-4");
  assert.equal(i4.dispatchModelLabel, "claude-worker · group/strong");

  const i5 = byId.get("task:t-template-skip");
  assert.equal(i5.dispatchModelLabel, "pi-worker · group/cheap");
});

test("env filter tabs show only running work-step counts and hide zeros", () => {
  const envs = [
    {
      name: "local",
      maxRunning: 1,
      runningWorkSteps: 0,
      byProject: {
        p1: { maxRunning: 1, runningWorkSteps: 0 },
        p2: { maxRunning: 2, runningWorkSteps: 0 },
      },
    },
    {
      name: "roommate",
      maxRunning: 4,
      runningWorkSteps: 2,
      byProject: {
        p1: { maxRunning: 4, runningWorkSteps: 1 },
        p2: { maxRunning: 4, runningWorkSteps: 1 },
      },
    },
    {
      name: "gpu",
      maxRunning: 2,
      runningWorkSteps: 1,
      byProject: {
        p2: { maxRunning: 2, runningWorkSteps: 1 },
      },
    },
  ];

  // Unselected project: all envs sum running counts only
  assert.equal(boardMod.formatEnvTabRunningBadge(envs[0], "all"), null);
  assert.equal(boardMod.formatEnvTabRunningBadge(envs[1], "all"), "2");
  assert.equal(boardMod.formatEnvTabRunningBadge(envs[2], "all"), "1");
  assert.equal(boardMod.formatAllEnvsRunningBadge(envs, "all"), "3");

  // All zero running -> All Envs and specific tabs show no badge even with maxRunning > 0
  const idleEnvs = envs.map((e) => ({ ...e, runningWorkSteps: 0, byProject: undefined }));
  assert.equal(boardMod.formatEnvTabRunningBadge(idleEnvs[0], "all"), null);
  assert.equal(boardMod.formatEnvTabRunningBadge(idleEnvs[1], "all"), null);
  assert.equal(boardMod.formatAllEnvsRunningBadge(idleEnvs, "all"), null);

  // Scoped to project p1: gpu is absent from p1 so it must report 0/null instead of leaking p2
  assert.deepEqual(boardMod.resolveScopedEnvCounts(envs[2], "p1"), { maxRunning: 0, runningWorkSteps: 0 });
  assert.equal(boardMod.formatEnvTabRunningBadge(envs[2], "p1"), null);
  assert.equal(boardMod.formatEnvTabRunningBadge(envs[1], "p1"), "1");
  assert.equal(boardMod.formatAllEnvsRunningBadge(envs, "p1"), "1");
});

test("formatRunningLimitMeta summarizes concurrency limits for the Running column header", () => {
  const cappedEnvs = [
    {
      name: "local",
      maxRunning: 1,
      runningWorkSteps: 0,
      byProject: {
        p1: { maxRunning: 1, runningWorkSteps: 0 },
        p2: { maxRunning: 1, runningWorkSteps: 0 },
      },
    },
    {
      name: "roommate",
      maxRunning: 4,
      runningWorkSteps: 4,
      byProject: {
        p1: { maxRunning: 4, runningWorkSteps: 4 },
      },
    },
  ];

  const allMeta = boardMod.formatRunningLimitMeta(cappedEnvs, { envFilter: "all", projectFilter: "all" });
  assert.deepEqual(allMeta, {
    text: "max 5",
    tooltip: "Concurrency limit · local: 0/1 · roommate: 4/4",
    atCapacity: false,
  });

  const roommateMeta = boardMod.formatRunningLimitMeta(cappedEnvs, { envFilter: "roommate", projectFilter: "all" });
  assert.deepEqual(roommateMeta, {
    text: "max 4",
    tooltip: "roommate: 4/4 running",
    atCapacity: true,
  });

  const localMeta = boardMod.formatRunningLimitMeta(cappedEnvs, { envFilter: "local", projectFilter: "all" });
  assert.deepEqual(localMeta, {
    text: "max 1",
    tooltip: "local: 0/1 running",
    atCapacity: false,
  });

  // Project p2 only has local -> roommate should not be included in All Envs total
  const p2Meta = boardMod.formatRunningLimitMeta(cappedEnvs, { envFilter: "all", projectFilter: "p2" });
  assert.deepEqual(p2Meta, {
    text: "max 1",
    tooltip: "Concurrency limit · local: 0/1",
    atCapacity: false,
  });
  assert.equal(boardMod.formatRunningLimitMeta(cappedEnvs, { envFilter: "roommate", projectFilter: "p2" }), null);

  // Mixed capped + unlimited envs -> max N+
  const mixedEnvs = [
    { name: "local", maxRunning: 1, runningWorkSteps: 1 },
    { name: "cloud", maxRunning: 0, runningWorkSteps: 2 },
  ];
  assert.deepEqual(boardMod.formatRunningLimitMeta(mixedEnvs, { envFilter: "all" }), {
    text: "max 1+",
    tooltip: "Concurrency limit · local: 1/1 · cloud: 2 (unlimited)",
    atCapacity: false,
  });
  assert.equal(boardMod.formatRunningLimitMeta(mixedEnvs, { envFilter: "cloud" }), null);

  // All unlimited -> null
  assert.equal(
    boardMod.formatRunningLimitMeta([{ name: "local", maxRunning: 0, runningWorkSteps: 3 }], { envFilter: "all" }),
    null,
  );
});
