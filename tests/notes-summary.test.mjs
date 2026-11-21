import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr") return { url: "herdr:mock", shortCircuit: true };
    if (specifier === "gpui-kit") return { url: "gpui-kit:mock", shortCircuit: true };
    if (specifier === "gpui-base") return { url: "gpui-base:mock", shortCircuit: true };
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
          export const hc = (...args) => mock().hc?.(...args) ?? { code: 0, stdout: "", stderr: "" };
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
          export const TextView = stub;
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const store = await import("../mods/roscaelifer-queue/store.js");
const inspector = await import("../mods/roscaelifer-queue/inspector.js");

test("formatBeadNotesForDisplay returns empty output for empty or non-string notes", () => {
  assert.equal(inspector.formatBeadNotesForDisplay(""), "");
  assert.equal(inspector.formatBeadNotesForDisplay("   \n  "), "");
  assert.equal(inspector.formatBeadNotesForDisplay(null), "");
  assert.equal(inspector.formatBeadNotesForDisplay(undefined), "");
  assert.equal(inspector.formatBeadNotesForDisplay({ notes: "x" }), "");
});

test("formatBeadNotesForDisplay drops a trailing auto-note end marker", () => {
  assert.equal(inspector.formatBeadNotesForDisplay("roscaelifer: ---- 自动 note 结束 ----"), "");
  const notes = [
    "roscaelifer: 已接手 rsc-1",
    "actor: pi-worker",
    "roscaelifer: task abc running",
    "step work: running",
    "  detail: doing",
    "",
    "**处理简介**",
    "实现完成，测试通过",
    "",
    "roscaelifer: ---- 自动 note 结束 ----",
  ].join("\n");
  const out = inspector.formatBeadNotesForDisplay(notes);
  assert.equal(out.includes("自动 note 结束"), false);
  assert.ok(out.endsWith("实现完成，测试通过"));
});

test("formatBeadNotesForDisplay turns a marker with appended review notes into ---", () => {
  const notes = [
    "**处理简介**",
    "第一轮实现完成",
    "",
    "roscaelifer: ---- 自动 note 结束 ----",
    "",
    "审查意见：请补充边界测试",
  ].join("\n");
  const out = inspector.formatBeadNotesForDisplay(notes);
  assert.equal(out.includes("自动 note 结束"), false);
  assert.ok(out.includes("\n\n---\n\n审查意见：请补充边界测试"));
});

test("formatBeadNotesForDisplay adds hard breaks to adjacent machine header lines", () => {
  const notes = [
    "roscaelifer: task abc running",
    "actor: pi-worker",
    "",
    "step work: running",
    "  detail: ok",
  ].join("\n");
  const lines = inspector.formatBeadNotesForDisplay(notes).split("\n");
  assert.equal(lines[0], "roscaelifer: task abc running  ");
  assert.equal(lines[1], "actor: pi-worker");
  assert.equal(lines[3], "step work: running  ");
  assert.equal(lines[4], "  detail: ok");
});

test("normalizeQueue preserves task summary and step current_attempt summary/has_summary", () => {
  const queue = store.normalizeQueue({
    config: { default_env: "local", envs: [{ name: "local", kind: "local" }] },
    tasks: [
      {
        id: "t-summary",
        bead_id: "rsc-summary",
        title: "Summary task",
        status: "active",
        summary: "任务级聚合简介",
        steps: [
          {
            step_id: "work",
            status: "running",
            current_attempt: {
              n: 1,
              status: "running",
              has_summary: true,
              summary: "attempt 级简介",
            },
          },
        ],
      },
    ],
    bd: {
      available: true,
      ready_ids: [],
      issues: [{ id: "rsc-summary", title: "Summary bead", status: "in_progress", issue_type: "task" }],
    },
  });

  const item = queue.itemsById.get("rsc-summary");
  assert.equal(item.summary, "任务级聚合简介");
  assert.equal(item.steps[0].currentAttempt.summary, "attempt 级简介");
  assert.equal(item.steps[0].currentAttempt.hasSummary, true);
});

test("normalizeQueue falls back to attempt summary when the task has no aggregate summary", () => {
  const queue = store.normalizeQueue({
    config: { default_env: "local", envs: [{ name: "local", kind: "local" }] },
    tasks: [
      {
        id: "t-fallback",
        title: "Standalone summary",
        status: "done",
        steps: [
          { step_id: "work", status: "done", current_attempt: { n: 1, status: "done", summary: "fallback 简介" } },
        ],
      },
    ],
    bd: { available: true, ready_ids: [], issues: [] },
  });
  const item = queue.itemsById.get("task:t-fallback");
  assert.equal(item.summary, "fallback 简介");
});

test("mergeNormalizedQueues keeps summary on merged project items", () => {
  const merged = store.mergeNormalizedQueues([
    {
      projectId: "p1",
      projectName: "P1",
      queue: store.normalizeQueue({
        config: { default_env: "local", envs: [{ name: "local", kind: "local" }] },
        tasks: [
          {
            id: "t-merge",
            bead_id: "rsc-merge",
            title: "Merged",
            status: "active",
            summary: "merged summary",
            steps: [],
          },
        ],
        bd: {
          available: true,
          ready_ids: [],
          issues: [{ id: "rsc-merge", title: "Merged bead", status: "in_progress", issue_type: "task" }],
        },
      }),
    },
  ]);
  const item = merged.items.find((entry) => entry.rawId === "rsc-merge");
  assert.equal(item.summary, "merged summary");
});
