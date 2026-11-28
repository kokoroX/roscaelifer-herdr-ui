import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// `main.js` imports `herdr`, `gpui-kit`, and `gpui-base`, while `store.js` uses
// gpui-shell's `fs/promises` (`fs.exists`). Stub them so RoscaeliferQueue's
// watcher, close, visibility, and workspace concurrency logic can be tested
// deterministically under plain Node.
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
    if (specifier === "fs/promises") {
      return { url: "fs-promises:mock", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "herdr:mock") {
      return {
        format: "module",
        source: `
          const mock = () => globalThis.__roscaeliferLifecycleMock || {};
          export const agents = () => mock().agents?.() ?? [];
          export const checking = () => mock().checking?.() ?? false;
          export const closeOverlay = (...args) => mock().closeOverlay?.(...args) ?? null;
          export const exec = (...args) => mock().exec ? mock().exec(...args) : Promise.resolve({ code: 0, stdout: "", stderr: "" });
          export const focused = () => mock().focused?.() ?? null;
          export const hc = (...args) => mock().hc ? mock().hc(...args) : Promise.resolve({ code: 0, stdout: "", stderr: "" });
          export const home = () => mock().home?.() ?? "/home/tester";
          export const nextCommand = () => mock().nextCommand ? mock().nextCommand() : new Promise(() => {});
          export const notify = (...args) => mock().notify?.(...args) ?? null;
          export const openOverlay = (...args) => mock().openOverlay?.(...args) ?? null;
          export const panes = () => mock().panes?.() ?? [];
          export const pickFolder = (...args) => mock().pickFolder?.(...args) ?? Promise.resolve(null);
          export const props = () => mock().props?.() ?? {};
          export const readTextFile = async (...args) => mock().readTextFile ? mock().readTextFile(...args) : null;
          export const run = (...args) => mock().run?.(...args) ?? null;
          export const setShared = (...args) => mock().setShared?.(...args) ?? null;
          export const settings = () => mock().settings?.() ?? {};
          export const shared = (key) => mock().shared?.(key) ?? null;
          export const spaces = () => mock().spaces?.() ?? [];
          export const terminals = () => mock().terminals?.() ?? [];
          export const theme = () => mock().theme?.() ?? {};
          export const watchFolder = (dir) => mock().watchFolder ? mock().watchFolder(dir) : Object.assign(new Promise(() => {}), { cancel() {} });
          export const window = () => mock().window ? mock().window() : { visible: true, active: true };
        `,
        shortCircuit: true,
      };
    }
    if (url === "fs-promises:mock") {
      return {
        format: "module",
        source: `
          const mock = () => globalThis.__roscaeliferLifecycleMock || {};
          export const exists = async (p) => mock().exists ? Boolean(await mock().exists(p)) : false;
        `,
        shortCircuit: true,
      };
    }
    if (url === "gpui-kit:mock") {
      return {
        format: "module",
        source: `
          function makeChain() {
            const proxy = new Proxy(function () {}, {
              get(_target, prop) {
                if (prop === "then") return undefined;
                return () => proxy;
              },
              apply() {
                return proxy;
              },
            });
            return proxy;
          }
          function stub() { return makeChain(); }
          stub.new = () => makeChain();
          export class View {}
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
          function makeChain() {
            const proxy = new Proxy(function () {}, {
              get(_target, prop) {
                if (prop === "then") return undefined;
                return () => proxy;
              },
              apply() {
                return proxy;
              },
            });
            return proxy;
          }
          function stub() { return makeChain(); }
          stub.new = () => makeChain();
          export const v_flex = stub;
          export const h_flex = stub;
          export const Button = stub;
          export const Checkbox = stub;
          export const Input = stub;
          export const InputState = stub;
          export const Popup = stub;
          export const Progress = stub;
          export const ProgressIndicator = stub;
          export const ProgressTrack = stub;
          export const ScrollHandle = stub;
          export const Scrollbar = stub;
          export const Select = stub;
          export const Switch = stub;
          export const Tab = stub;
          export const Tabs = stub;
          export const TextView = stub;
          export const Textarea = stub;
          export const TextareaState = stub;
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: RoscaeliferQueue } = await import("../mods/roscaelifer-queue/main.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockCx() {
  const pendingTasks = new Set();
  const afterTimers = [];
  const everyTimers = [];
  let notifyCount = 0;

  const cx = {
    get notifyCount() {
      return notifyCount;
    },
    pendingTasks,
    afterTimers,
    everyTimers,
    focus_handle() {
      return { focus() {} };
    },
    notify() {
      notifyCount += 1;
    },
    spawn(fn) {
      let done = false;
      const p = Promise.resolve()
        .then(() => fn(cx))
        .finally(() => {
          done = true;
          pendingTasks.delete(p);
        });
      pendingTasks.add(p);
      return {
        cancel() {},
        is_done() {
          return done;
        },
      };
    },
    timer: {
      after(ms, fn) {
        const entry = {
          ms,
          fn,
          cancelled: false,
          fired: false,
          cancel() {
            this.cancelled = true;
          },
          fire() {
            if (this.cancelled || this.fired) return;
            this.fired = true;
            fn(cx);
          },
        };
        afterTimers.push(entry);
        return entry;
      },
      every(ms, fn) {
        const entry = {
          ms,
          fn,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
          tick() {
            if (!this.cancelled) fn(cx);
          },
        };
        everyTimers.push(entry);
        return entry;
      },
    },
    async flush(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
  return cx;
}

function withLifecycleMock(mock, fn) {
  globalThis.__roscaeliferLifecycleMock = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete globalThis.__roscaeliferLifecycleMock;
    });
}

function makeSnapshotJson() {
  return JSON.stringify({
    schema_version: 1,
    tasks: [],
    events: [],
    envs: [],
    formulas: [],
    runner: { active: false, lock_held: false },
    bd: { enabled: false, issues: [] },
  });
}

test("init under checking() starts zero HostModule async tasks", async () => {
  const calls = {
    readTextFile: 0,
    nextCommand: 0,
    watchFolder: 0,
    exec: 0,
  };
  const cx = createMockCx();
  await withLifecycleMock(
    {
      checking: () => true,
      readTextFile: async () => {
        calls.readTextFile += 1;
        return null;
      },
      nextCommand: () => {
        calls.nextCommand += 1;
        return new Promise(() => {});
      },
      watchFolder: () => {
        calls.watchFolder += 1;
        return Object.assign(new Promise(() => {}), { cancel() {} });
      },
      exec: async () => {
        calls.exec += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.init({}, cx);
      await cx.flush();
      assert.deepEqual(calls, {
        readTextFile: 0,
        nextCommand: 0,
        watchFolder: 0,
        exec: 0,
      });
      assert.equal(cx.everyTimers.length, 0);
    },
  );
});

test("clearWatchers + ensureWatchers for same dir never spawns duplicate watchFolder", async () => {
  const watches = [];
  const cx = createMockCx();
  await withLifecycleMock(
    {
      checking: () => false,
      exists: async () => true,
      watchFolder: (dir) => {
        const d = deferred();
        const handle = Object.assign(d.promise, {
          dir,
          cancelled: false,
          cancel() {
            this.cancelled = true;
            d.resolve([]);
          },
        });
        watches.push({ dir, handle, d });
        return handle;
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.closed = false;
      view.watchers = new Map();
      view.watchCooldownUntil = new Map();
      view.watchGeneration = 0;
      view.panelMode = "single";
      view.ctx = {
        projectId: "p1",
        repo: "/repos/one",
        bdDir: "",
        db: "",
        machine: "",
      };

      view.ensureWatchers(cx);
      await cx.flush();
      assert.equal(watches.length, 2);

      // Simulate clearWatchers() followed immediately by ensureWatchers()
      // before microtasks from the cancelled watch resolve.
      view.clearWatchers();
      view.ensureWatchers(cx);
      await cx.flush();

      // Only 2 fresh watches (one per dir), never duplicated by the cancelled loops.
      assert.equal(watches.length, 4);
      const activePerDir = new Map();
      for (const w of watches) {
        if (!w.handle.cancelled) {
          activePerDir.set(w.dir, (activePerDir.get(w.dir) || 0) + 1);
        }
      }
      assert.equal(activePerDir.get("/repos/one/.roscaelifer"), 1);
      assert.equal(activePerDir.get("/repos/one/.beads"), 1);

      view.close(cx);
    },
  );
});

test("non-existent directories skip watchFolder and stay on cooldown", async () => {
  let existsCalls = 0;
  let watchCalls = 0;
  const cx = createMockCx();
  await withLifecycleMock(
    {
      checking: () => false,
      exists: async (p) => {
        existsCalls += 1;
        return p === "/repos/missing/.roscaelifer";
      },
      watchFolder: (dir) => {
        watchCalls += 1;
        const d = deferred();
        return Object.assign(d.promise, { cancel: () => d.resolve([]) });
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.closed = false;
      view.watchers = new Map();
      view.watchCooldownUntil = new Map();
      view.watchGeneration = 0;
      view.panelMode = "single";
      view.ctx = {
        projectId: "p-missing",
        repo: "/repos/missing",
        bdDir: "",
        db: "",
        machine: "",
      };

      view.ensureWatchers(cx);
      await cx.flush();
      assert.equal(existsCalls, 2);
      assert.equal(watchCalls, 1);
      assert.equal(view.watchers.has("/repos/missing/.beads"), false);
      assert.ok((view.watchCooldownUntil.get("/repos/missing/.beads") || 0) > Date.now());

      // A subsequent ensureWatchers should not re-probe the missing dir while in cooldown.
      view.ensureWatchers(cx);
      await cx.flush();
      assert.equal(existsCalls, 2);
      assert.equal(watchCalls, 1);

      view.close(cx);
    },
  );
});

test("reclaimed watch resolving [] exits loop and cools down instead of spinning", async () => {
  const watches = [];
  const cx = createMockCx();
  await withLifecycleMock(
    {
      checking: () => false,
      exists: async () => true,
      watchFolder: (dir) => {
        const d = deferred();
        const handle = Object.assign(d.promise, { cancel: () => d.resolve([]) });
        watches.push({ dir, d, handle });
        return handle;
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.closed = false;
      view.watchers = new Map();
      view.watchCooldownUntil = new Map();
      view.watchGeneration = 0;
      view.panelMode = "single";
      view.ctx = {
        projectId: "p-reclaim",
        repo: "/repos/reclaim",
        bdDir: "",
        db: "",
        machine: "",
      };

      view.ensureWatchers(cx);
      await cx.flush();
      assert.equal(watches.length, 2);

      // Simulate Herdr reclaiming one of the watches by resolving with [].
      watches[0].d.resolve([]);
      await cx.flush();

      assert.equal(watches.length, 2);
      assert.equal(view.watchers.has(watches[0].dir), false);
      assert.ok((view.watchCooldownUntil.get(watches[0].dir) || 0) > Date.now());

      // Calling ensureWatchers again during cooldown must not re-arm the reclaimed watch.
      view.ensureWatchers(cx);
      await cx.flush();
      assert.equal(watches.length, 2);

      view.close(cx);
    },
  );
});

test("close() during in-flight refreshWorkspace prevents post-close watchers and timers", async () => {
  const snapshotGate = deferred();
  let watchCalls = 0;
  const cx = createMockCx();
  const projectsConfig = {
    version: 1,
    activeProject: "p1",
    panelMode: "multi",
    pinnedProjects: ["p1", "p2"],
    projects: [
      { id: "p1", name: "One", repo: "/repos/one", db: "/repos/one/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
      { id: "p2", name: "Two", repo: "/repos/two", db: "/repos/two/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
    ],
  };

  await withLifecycleMock(
    {
      checking: () => false,
      exists: async () => true,
      readTextFile: async () => JSON.stringify(projectsConfig),
      watchFolder: () => {
        watchCalls += 1;
        const d = deferred();
        return Object.assign(d.promise, { cancel: () => d.resolve([]) });
      },
      exec: async (_cmd, args) => {
        if (args[0] === "snapshot" && args[1] === "--help") {
          return { code: 0, stdout: "--compact --brief", stderr: "" };
        }
        if (args[0] === "snapshot") {
          await snapshotGate.promise;
          return { code: 0, stdout: makeSnapshotJson(), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.init({}, cx);
      await cx.flush();

      // Close the view while snapshots are still in flight.
      view.close(cx);
      snapshotGate.resolve();
      await cx.flush();

      assert.equal(view.closed, true);
      assert.equal(watchCalls, 0);
      assert.equal(view.watchers.size, 0);
      assert.equal(view.pollTimer, null);
    },
  );
});

test("refreshWorkspace bounds concurrent snapshot fetches to 2 and preserves per-project errors", async () => {
  let activeSnapshots = 0;
  let maxConcurrentSnapshots = 0;
  const cx = createMockCx();
  const projectsConfig = {
    version: 1,
    activeProject: "p1",
    panelMode: "multi",
    pinnedProjects: ["p1", "p2", "p3", "p4"],
    projects: [
      { id: "p1", name: "One", repo: "/repos/p1", db: "/repos/p1/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
      { id: "p2", name: "Two", repo: "/repos/p2", db: "/repos/p2/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
      { id: "p3", name: "Three", repo: "/repos/p3", db: "/repos/p3/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
      { id: "p4", name: "Four", repo: "/repos/p4", db: "/repos/p4/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
    ],
  };

  await withLifecycleMock(
    {
      checking: () => false,
      exists: async () => false,
      readTextFile: async () => JSON.stringify(projectsConfig),
      exec: async (_cmd, args) => {
        if (args[0] === "snapshot" && args[1] === "--help") {
          return { code: 0, stdout: "--compact --brief", stderr: "" };
        }
        if (args[0] === "snapshot") {
          activeSnapshots += 1;
          maxConcurrentSnapshots = Math.max(maxConcurrentSnapshots, activeSnapshots);
          await new Promise((r) => setTimeout(r, 15));
          activeSnapshots -= 1;
          const dbArg = args[args.indexOf("--db") + 1] || "";
          if (dbArg.includes("/p3/")) {
            return { code: 1, stdout: "", stderr: "boom p3" };
          }
          return { code: 0, stdout: makeSnapshotJson(), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.init({}, cx);
      // Wait for all 4 sequential-bounded batches to complete.
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        await cx.flush(2);
      }

      assert.ok(maxConcurrentSnapshots >= 1 && maxConcurrentSnapshots <= 2, `maxConcurrent=${maxConcurrentSnapshots}`);
      assert.equal(view.projectSnapshots.length, 4);
      assert.equal(view.projectSnapshots[0].error, null);
      assert.equal(view.projectSnapshots[1].error, null);
      assert.match(view.projectSnapshots[2].error, /boom p3/);
      assert.equal(view.projectSnapshots[3].error, null);

      view.close(cx);
    },
  );
});

test("pollTimer pauses while window is hidden and resumes when render() sees it visible", async () => {
  let visible = false;
  let snapshotCalls = 0;
  const cx = createMockCx();
  const projectsConfig = {
    version: 1,
    activeProject: "p1",
    panelMode: "single",
    pinnedProjects: ["p1"],
    projects: [
      { id: "p1", name: "One", repo: "/repos/vis", db: "/repos/vis/.roscaelifer/roscaelifer.db", bdDir: "", config: "", formulasDir: "", bin: "", env: "", machine: "" },
    ],
  };

  await withLifecycleMock(
    {
      checking: () => false,
      window: () => ({ visible, active: visible }),
      exists: async () => false,
      readTextFile: async () => JSON.stringify(projectsConfig),
      exec: async (_cmd, args) => {
        if (args[0] === "snapshot" && args[1] === "--help") {
          return { code: 0, stdout: "--compact --brief", stderr: "" };
        }
        if (args[0] === "snapshot") {
          snapshotCalls += 1;
          return { code: 0, stdout: makeSnapshotJson(), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    async () => {
      const view = new RoscaeliferQueue();
      view.init({}, cx);
      await cx.flush();
      assert.equal(snapshotCalls, 1);

      const activePoll = cx.everyTimers.find((t) => !t.cancelled);
      assert.ok(activePoll);

      // Window hidden: poll tick skips refresh and records deferred wake.
      activePoll.tick();
      await cx.flush();
      assert.equal(snapshotCalls, 1);
      assert.equal(view.pollDeferredWhileHidden, true);

      // Window becomes visible and render() runs: schedules silent catch-up refresh.
      visible = true;
      view.render(cx);
      assert.equal(view.pollDeferredWhileHidden, false);
      const wakeTimer = cx.afterTimers.find((t) => !t.cancelled && !t.fired);
      assert.ok(wakeTimer);
      wakeTimer.fire();
      await cx.flush();
      assert.equal(snapshotCalls, 2);

      view.close(cx);
    },
  );
});
