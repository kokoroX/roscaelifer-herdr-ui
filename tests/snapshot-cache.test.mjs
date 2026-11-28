import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// `store.js` imports `herdr`, which only exists inside the Herdr UI runtime.
// Mock it so the pure snapshot-cache helpers can be exercised under plain node.
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

const CACHE_PREFIX = "roscaelifer.snapshotCache.v1:";
const CACHE_INDEX_KEY = "roscaelifer.snapshotCacheIndex.v1";
const MAX_CACHED_SNAPSHOT_CHARS = 512 * 1024;

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
  }
  clear() {
    this.map.clear();
  }
  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

const CTX = {
  repo: "/repos/alpha",
  db: "/repos/alpha/.roscaelifer/roscaelifer.db",
  bdDir: "/repos/alpha/.beads",
  config: "/repos/alpha/roscaelifer.toml",
  formulasDir: "/repos/alpha/formulas",
  machine: "",
};

function cacheKey(ctx = CTX) {
  return `${CACHE_PREFIX}${store.repoIdentityKey(ctx)}`;
}

function withStorage(storage = new MemoryStorage()) {
  globalThis.localStorage = storage;
  return storage;
}

function bigText(chars, seed = "lorem-ipsum") {
  return `${seed} `.repeat(Math.ceil(chars / (seed.length + 1))).slice(0, chars);
}

function slimStep(status = "done") {
  return {
    step_id: "s1",
    kind: "work",
    status,
    ordinal: 0,
    hc_address: null,
    running_since: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    detail: bigText(3000, "step-detail"),
    prompt: bigText(600, "prompt"),
    reply: bigText(600, "reply"),
    current_attempt: {
      n: 1,
      status: "succeeded",
      summary: bigText(900, "summary"),
      reply: bigText(4000, "attempt-reply"),
      output: bigText(4000, "attempt-output"),
    },
  };
}

function task(id, overrides = {}) {
  const { steps, ...rest } = overrides;
  return {
    id,
    bead_id: null,
    title: `Task ${id}`,
    status: "done",
    formula_name: "worker-inplace",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    body: bigText(4000, "task-body"),
    steps: steps || [slimStep()],
    ...rest,
  };
}

function issue(id, overrides = {}) {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    issue_type: "task",
    priority: 2,
    labels: [],
    created_at: "2026-01-01T00:00:00Z",
    description: bigText(2000, "issue-description"),
    ...overrides,
  };
}

function terminalTask(item) {
  return item?.status === "done" || item?.status === "failed" || item?.status === "cancelled";
}

/**
 * Builds a snapshot shaped like the bug report: 200 closed beads each with a
 * terminal task and megabytes of step detail, 300 standalone terminal tasks,
 * plus a handful of active cards and two `roscaelifer-review` closed beads that
 * are stored after the regular closed ones. The two `Needs Action` cards that
 * must survive any trimming (`t-action-old` on an open bead and
 * `t-standalone-failed-old` without a bead) are deliberately the OLDEST tasks, so
 * a naive "newest N terminal tasks" budget would drop them.
 */
function bigSnapshot() {
  const issues = [];
  const tasks = [];
  tasks.push(
    task("t-action-old", {
      bead_id: "rsc-action-old",
      status: "failed",
      updated_at: "2025-11-01T00:00:00Z",
      steps: [slimStep("failed")],
    }),
    task("t-standalone-failed-old", {
      status: "failed",
      updated_at: "2025-11-02T00:00:00Z",
      steps: [slimStep("failed")],
    }),
  );
  for (let i = 1; i <= 200; i += 1) {
    const id = `rsc-c${i}`;
    const status = i % 3 === 0 ? "done" : i % 3 === 1 ? "failed" : "cancelled";
    issues.push(issue(id, { status: "closed", closed_at: "2026-01-02T00:00:00Z" }));
    tasks.push(
      task(`t-c${i}`, {
        bead_id: id,
        status,
        updated_at: `2026-01-02T${String(i % 24).padStart(2, "0")}:00:00Z`,
      }),
    );
  }
  for (let i = 1; i <= 300; i += 1) {
    tasks.push(
      task(`t-standalone-${i}`, {
        status: i % 2 === 0 ? "done" : "cancelled",
        updated_at: `2026-01-03T00:${String(i % 60).padStart(2, "0")}:00Z`,
      }),
    );
  }
  issues.push(
    issue("rsc-ready"),
    issue("rsc-queue", { labels: ["roscaelifer"] }),
    issue("rsc-running", { status: "in_progress" }),
    issue("rsc-action"),
    issue("rsc-action-old"),
    issue("rsc-review-1", { status: "closed", labels: ["roscaelifer-review"] }),
    issue("rsc-review-2", { status: "closed", labels: ["roscaelifer-review", "roscaelifer"] }),
  );
  tasks.push(
    task("t-queue", {
      bead_id: "rsc-queue",
      status: "active",
      steps: [slimStep("pending")],
    }),
    task("t-running", {
      bead_id: "rsc-running",
      status: "active",
      steps: [slimStep("running")],
    }),
    task("t-action", {
      bead_id: "rsc-action",
      status: "failed",
      steps: [slimStep("failed")],
    }),
  );
  return {
    schema_version: 1,
    generated_at: "2026-01-04T00:00:00Z",
    config: { default_env: "local", envs: [{ name: "local", kind: "local", max_running: 2 }] },
    bd: {
      available: true,
      ready_ids: ["rsc-ready"],
      issues,
      intake_preview: [],
    },
    tasks,
    events: [],
    sidecars: [],
  };
}

const ACTIVE_COLUMNS = ["ready", "queue", "running", "action", "review"];

test("saveCachedSnapshot trims tasks + closed issues and keeps the active board identical", () => {
  const storage = withStorage();
  const snapshot = bigSnapshot();
  const live = store.normalizeQueue(snapshot);
  assert.ok(JSON.stringify(snapshot).length > MAX_CACHED_SNAPSHOT_CHARS * 3);

  store.saveCachedSnapshot(CTX, snapshot);

  const raw = storage.getItem(cacheKey());
  assert.ok(raw, "snapshot should be cached");
  assert.ok(
    raw.length < MAX_CACHED_SNAPSHOT_CHARS,
    `cached snapshot should be far below the cap, got ${raw.length}`,
  );

  const loaded = store.loadCachedSnapshot(CTX);
  assert.ok(loaded);
  assert.equal(typeof loaded.cachedAt, "number");
  const cached = store.normalizeQueue(loaded.snapshot);

  for (const column of ACTIVE_COLUMNS) {
    assert.deepEqual(
      cached.columns[column].map((item) => item.id),
      live.columns[column].map((item) => item.id),
      `column ${column} should match the untrimmed snapshot`,
    );
  }

  // Historical failed tasks of dropped closed beads must not leak into Needs Action.
  assert.deepEqual(cached.columns.action.map((item) => item.id), [
    "rsc-action",
    "rsc-action-old",
    "task:t-standalone-failed-old",
  ]);
  for (const item of cached.columns.action) {
    assert.ok(!/^rsc-c\d+$/.test(item.id), `closed bead ${item.id} must not appear in action`);
  }

  // Review cards stored after the closed-issue quota are still present.
  assert.deepEqual(
    cached.columns.review.map((item) => item.id).sort(),
    ["rsc-review-1", "rsc-review-2"],
  );
  const cachedIssueIds = loaded.snapshot.bd.issues.map((item) => item.id);
  assert.ok(cachedIssueIds.includes("rsc-review-1"));
  assert.ok(cachedIssueIds.includes("rsc-review-2"));

  // Standalone terminal tasks are capped, active tasks are all kept.
  const terminal = (item) =>
    item.status === "done" || item.status === "failed" || item.status === "cancelled";
  // The maxClosed budget only applies to Closed-column standalone tasks; a
  // standalone `failed` task is a Needs Action card and is never trimmed.
  const standaloneClosed = loaded.snapshot.tasks.filter(
    (item) => !item.bead_id && terminal(item) && item.status !== "failed",
  );
  assert.ok(standaloneClosed.length > 0 && standaloneClosed.length <= 20);
  assert.ok(loaded.snapshot.tasks.some((item) => item.id === "t-running"));
  assert.ok(loaded.snapshot.tasks.some((item) => item.id === "t-queue"));
  assert.ok(loaded.snapshot.tasks.some((item) => item.id === "t-action-old"));
  assert.ok(loaded.snapshot.tasks.some((item) => item.id === "t-standalone-failed-old"));

  // Long free text is gone from cached tasks.
  for (const cachedTask of loaded.snapshot.tasks) {
    assert.equal(cachedTask.body, undefined);
    for (const step of cachedTask.steps || []) {
      assert.equal(step.detail, undefined);
      assert.equal(step.prompt, undefined);
      assert.equal(step.reply, undefined);
      if (step.current_attempt) {
        assert.equal(step.current_attempt.reply, undefined);
        assert.equal(step.current_attempt.output, undefined);
        assert.ok(step.current_attempt.summary.length <= 240);
      }
    }
  }

  // The inspector still gets short-ish issue summaries because long fields are dropped.
  for (const cachedIssue of loaded.snapshot.bd.issues) {
    assert.equal(cachedIssue.description, undefined);
  }
});

test("slimSnapshotForCache keeps review-labelled closed issues beyond the closed quota", () => {
  const issues = [];
  for (let i = 1; i <= 30; i += 1) issues.push(issue(`rsc-c${i}`, { status: "closed" }));
  issues.push(issue("rsc-review-late", { status: "closed", labels: ["roscaelifer-review"] }));
  const slim = store.slimSnapshotForCache(
    { schema_version: 1, bd: { issues }, tasks: [] },
    { maxClosed: 5, maxEvents: 5 },
  );
  const ids = slim.bd.issues.map((item) => item.id);
  assert.deepEqual(ids, ["rsc-c1", "rsc-c2", "rsc-c3", "rsc-c4", "rsc-c5", "rsc-review-late"]);
});

test("slimSnapshotForCache keeps old Needs Action cards that a newest-N terminal budget would drop", () => {
  const snapshot = bigSnapshot();
  const live = store.normalizeQueue(snapshot);
  // The two Needs Action cards are older than the 30+ closed tasks appended later.
  const liveActionIds = live.columns.action.map((item) => item.id);
  assert.deepEqual(liveActionIds, ["rsc-action", "rsc-action-old", "task:t-standalone-failed-old"]);

  const slim = store.slimSnapshotForCache(snapshot, { maxClosed: 20, maxEvents: 0 });
  const slimmed = store.normalizeQueue(slim);

  // Old `failed` tasks anchored to an open bead, and the bead-less `failed` task,
  // must survive => same Needs Action column as the untrimmed snapshot.
  assert.deepEqual(slimmed.columns.action.map((item) => item.id), liveActionIds);
  assert.ok(slim.tasks.some((item) => item.id === "t-action-old"));
  assert.ok(slim.tasks.some((item) => item.id === "t-standalone-failed-old"));
  assert.ok(slim.bd.issues.some((item) => item.id === "rsc-action-old"));
  for (const column of ACTIVE_COLUMNS) {
    assert.deepEqual(
      slimmed.columns[column].map((item) => item.id),
      live.columns[column].map((item) => item.id),
      `column ${column} should match the untrimmed snapshot`,
    );
  }

  // The ceiling still applies to the Closed column.
  const closedTerminal = slim.tasks.filter((item) => terminalTask(item));
  const closedFromKeptIssues = closedTerminal.filter(
    (item) => item.bead_id && !item.bead_id.startsWith("rsc-review"),
  );
  assert.ok(closedTerminal.length > 0);
  assert.ok(closedFromKeptIssues.length <= 20, `got ${closedFromKeptIssues.length} closed tasks`);
});

test("slimSnapshotForCache with maxClosed 0 empties the Closed column but keeps Needs Action", () => {
  const snapshot = bigSnapshot();
  const live = store.normalizeQueue(snapshot);
  assert.ok(live.columns.closed.length > 0);

  const slim = store.slimSnapshotForCache(snapshot, { maxClosed: 0, maxEvents: 0 });
  const slimmed = store.normalizeQueue(slim);

  // maxClosed === 0 empties the budget instead of falling back to "keep everything".
  assert.deepEqual(slimmed.columns.closed, []);
  assert.deepEqual(
    slim.tasks.map((item) => item.id).sort(),
    ["t-action", "t-action-old", "t-queue", "t-running", "t-standalone-failed-old"],
  );
  assert.ok(slim.bd.issues.every((item) => item.status !== "closed" || item.labels?.includes("roscaelifer-review")));
  assert.equal(slim.events.length, 0);

  // Active cards are untouched, including the old Needs Action ones.
  for (const column of ACTIVE_COLUMNS) {
    assert.deepEqual(
      slimmed.columns[column].map((item) => item.id),
      live.columns[column].map((item) => item.id),
      `column ${column} should match the untrimmed snapshot`,
    );
  }
  assert.deepEqual(slimmed.columns.action.map((item) => item.id), [
    "rsc-action",
    "rsc-action-old",
    "task:t-standalone-failed-old",
  ]);
  assert.ok(slim.tasks.some((item) => item.id === "t-standalone-failed-old"));
  assert.ok(slim.tasks.some((item) => item.id === "t-action-old"));
  assert.ok(slim.tasks.some((item) => item.id === "t-running"));
  assert.ok(slim.tasks.some((item) => item.id === "t-queue"));
});

test("saveCachedSnapshot clears a previous entry when the payload still exceeds the cap", () => {
  const storage = withStorage();
  store.saveCachedSnapshot(CTX, { schema_version: 1, tasks: [], bd: { issues: [] } });
  assert.ok(storage.getItem(cacheKey()));
  assert.ok(store.loadCachedSnapshot(CTX));

  // 300 active tasks are never trimmed, and `title` is never dropped, so the
  // slimmed payload stays above 512 KB.
  const huge = {
    schema_version: 1,
    config: { default_env: "local", envs: [] },
    bd: { available: true, issues: [], intake_preview: [] },
    tasks: Array.from({ length: 300 }, (_, i) =>
      task(`t-active-${i}`, {
        status: "active",
        title: bigText(2000, `huge-${i}`),
        steps: [slimStep("pending")],
      }),
    ),
    events: [],
  };
  assert.ok(JSON.stringify(huge).length > MAX_CACHED_SNAPSHOT_CHARS);

  store.saveCachedSnapshot(CTX, huge);

  assert.equal(storage.getItem(cacheKey()), null, "oversized snapshot must not keep a stale entry");
  assert.equal(store.loadCachedSnapshot(CTX), null);
  const index = JSON.parse(storage.getItem(CACHE_INDEX_KEY) || "[]");
  assert.ok(!index.includes(store.repoIdentityKey(CTX)));
});

test("saveCachedSnapshot clears the entry when localStorage keeps rejecting the write", () => {
  const storage = withStorage();
  store.saveCachedSnapshot(CTX, { schema_version: 1, tasks: [], bd: { issues: [] } });
  assert.ok(storage.getItem(cacheKey()));

  const original = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (String(key).startsWith(CACHE_PREFIX)) {
      const error = new Error("QuotaExceededError");
      error.name = "QuotaExceededError";
      throw error;
    }
    return original(key, value);
  };

  store.saveCachedSnapshot(CTX, { schema_version: 1, tasks: [], bd: { issues: [] } });
  assert.equal(storage.getItem(cacheKey()), null);
  assert.equal(store.loadCachedSnapshot(CTX), null);
});

test("loadCachedSnapshot drops stale and legacy entries but keeps fresh ones", () => {
  const storage = withStorage();
  const key = cacheKey();
  const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;

  storage.setItem(
    key,
    JSON.stringify({ v: 1, cachedAt: fiveDaysAgo, snapshot: { schema_version: 1, tasks: [] } }),
  );
  storage.setItem(CACHE_INDEX_KEY, JSON.stringify([store.repoIdentityKey(CTX), "other"]));
  assert.equal(store.loadCachedSnapshot(CTX), null);
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(JSON.parse(storage.getItem(CACHE_INDEX_KEY)), ["other"]);

  // Legacy entries without a usable cachedAt are rejected and removed as well.
  storage.setItem(key, JSON.stringify({ schema_version: 1, tasks: [] }));
  assert.equal(store.loadCachedSnapshot(CTX), null);
  assert.equal(storage.getItem(key), null);

  storage.setItem(
    key,
    JSON.stringify({ v: 1, cachedAt: Date.now() - 1000, snapshot: { schema_version: 1, tasks: [] } }),
  );
  const loaded = store.loadCachedSnapshot(CTX);
  assert.ok(loaded);
  assert.equal(loaded.snapshot.schema_version, 1);
  assert.ok(loaded.cachedAt > 0);

  // Explicit maxAge/window overrides still work; `maxAgeMs <= 0` disables the TTL.
  assert.ok(store.loadCachedSnapshot(CTX, { maxAgeMs: 0 }));
  const fixedNow = loaded.cachedAt + 2 * 60 * 60 * 1000;
  assert.ok(store.loadCachedSnapshot(CTX, { maxAgeMs: 3 * 60 * 60 * 1000, now: fixedNow }));
  assert.equal(store.loadCachedSnapshot(CTX, { now: fixedNow + 24 * 60 * 60 * 1000 }), null);
  assert.equal(storage.getItem(key), null);
});
