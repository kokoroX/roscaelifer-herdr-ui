import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// `store.js` imports `herdr`, which only exists inside the Herdr UI runtime.
// Mock it so project config + queue merging can be exercised under plain node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr") {
      return { url: "herdr:mock", shortCircuit: true };
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
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const store = await import("../mods/roscaelifer-queue/store.js");

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
