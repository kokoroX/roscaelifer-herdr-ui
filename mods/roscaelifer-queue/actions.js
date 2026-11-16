import { agents, notify, panes, run, spaces, terminals } from "herdr";
import { execRoscaelifer, resolveBinary } from "./store.js";

function formatError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

export function createActions({ getCtx, getRunner, onBusyChange, onRefresh } = {}) {
  let chain = Promise.resolve();
  const busyKeys = new Set();

  function setBusy(key, active, cx = null) {
    if (!key) return;
    if (active) busyKeys.add(key);
    else busyKeys.delete(key);
    onBusyChange?.(busyKeys.size > 0, busyKeys, cx);
  }

  function isBusy(key) {
    if (!key) return busyKeys.size > 0;
    return busyKeys.has(key);
  }

  async function runCli(args, { timeout = 30000, label = "roscaelifer" } = {}) {
    const ctx = getCtx?.();
    if (!ctx) throw new Error("No project context selected");
    const runner = (await getRunner?.()) || (await resolveBinary(ctx));
    const res = await execRoscaelifer(ctx, runner, args, { timeout });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || `${label} exited with code ${res.code}`).trim();
      throw new Error(msg);
    }
    return res;
  }

  async function runBdExec(bdArgs, { timeout = 30000 } = {}) {
    const ctx = getCtx?.();
    if (!ctx) throw new Error("No project context selected");
    const args = ["bd-exec"];
    if (ctx.bdDir) args.push("--bd-dir", ctx.bdDir);
    if (ctx.bdActor) args.push("--bd-actor", ctx.bdActor);
    args.push("--", ...bdArgs);
    return runCli(args, { timeout, label: `bd ${bdArgs[0] || ""}`.trim() });
  }

  function tickArgs(ctx, { env = null, maxRunning = null } = {}) {
    const args = ["tick"];
    if (ctx?.db) args.push("--db", ctx.db);
    if (ctx?.config) args.push("--config", ctx.config);
    if (ctx?.formulasDir) args.push("--formulas-dir", ctx.formulasDir);
    args.push("--bd");
    if (ctx?.bdDir) args.push("--bd-dir", ctx.bdDir);
    if (env || ctx?.env) args.push("--env", env || ctx.env);
    if (Number(maxRunning) > 0) args.push("--max-running", String(maxRunning));
    return args;
  }

  function beadUpdateArgs(beadId, { formula, env, currentLabels = [], bdStatus = null, wakeDeferred = false } = {}) {
    const labels = Array.isArray(currentLabels) ? currentLabels : [];
    const args = ["update", beadId, "--add-label", "roscaelifer"];
    if (formula) {
      for (const label of labels) {
        if (typeof label === "string" && label.startsWith("formula:") && label !== `formula:${formula}`) {
          args.push("--remove-label", label);
        }
      }
      args.push("--add-label", `formula:${formula}`);
    }
    if (env) {
      for (const label of labels) {
        if (typeof label === "string" && label.startsWith("env:") && label !== `env:${env}`) {
          args.push("--remove-label", label);
        }
      }
      args.push("--add-label", `env:${env}`);
    }
    for (const bad of ["roscaelifer-failed", "roscaelifer-cancelled", "roscaelifer-invalid"]) {
      if (labels.includes(bad)) args.push("--remove-label", bad);
    }
    if (wakeDeferred && bdStatus === "deferred") args.push("--status", "open", "--defer", "");
    return args;
  }

  function enqueueSerialized(key, title, fn, { refresh = true, successBody = null, cx = null } = {}) {
    const runWithCx = (runCx) => {
      const task = chain.then(async () => {
        setBusy(key, true, runCx);
        try {
          const result = await fn();
          if (successBody) {
            notify({ title, body: typeof successBody === "function" ? successBody(result) : successBody, level: "success" });
          }
          if (refresh) await onRefresh?.(runCx);
          return result;
        } catch (err) {
          notify({ title: `${title} failed`, body: formatError(err), level: "error" });
          throw err;
        } finally {
          setBusy(key, false, runCx);
        }
      });
      chain = task.catch(() => {});
      return task;
    };

    if (cx && typeof cx.spawn === "function") {
      // Spawn synchronously on the caller's cx so the async task holds its own fresh AsyncContext
      // rather than retaining a callback Context across awaits.
      return new Promise((resolve, reject) => {
        cx.spawn(async (spawnCx) => {
          try {
            resolve(await runWithCx(spawnCx));
          } catch (err) {
            reject(err);
          }
        });
      });
    }
    return runWithCx(null);
  }

  return {
    isBusy,

    tick(opts = {}, cx = null) {
      const ctx = getCtx?.();
      return enqueueSerialized(
        "tick",
        "Tick",
        async () => runCli(tickArgs(ctx, { env: opts.env || null, maxRunning: opts.maxRunning ?? null }), { timeout: 60000, label: "tick" }),
        { successBody: "Reconcile pass completed.", cx: opts?.cx || cx },
      );
    },

    approveGate(taskId, stepId, cx = null) {
      const ctx = getCtx?.();
      return enqueueSerialized(
        `approve:${taskId}:${stepId}`,
        `Approve ${taskId}`,
        async () => {
          const args = ["approve"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId), String(stepId));
          return runCli(args, { timeout: 45000, label: "approve" });
        },
        { successBody: `Approved step ${stepId}`, cx },
      );
    },

    retryTask(taskId, stepId, cx = null) {
      const ctx = getCtx?.();
      return enqueueSerialized(
        `retry:${taskId}:${stepId}`,
        `Retry ${taskId}`,
        async () => {
          const args = ["retry"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId), String(stepId));
          return runCli(args, { timeout: 45000, label: "retry" });
        },
        { successBody: `Reset step ${stepId} for retry`, cx },
      );
    },

    cancelTask(taskId, cx = null) {
      const ctx = getCtx?.();
      return enqueueSerialized(
        `cancel:${taskId}`,
        `Cancel ${taskId}`,
        async () => {
          const args = ["cancel"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId));
          return runCli(args, { timeout: 45000, label: "cancel" });
        },
        { successBody: `Cancelled task ${taskId}`, cx },
      );
    },

    async cleanPreview({ taskId, stepId } = {}) {
      const ctx = getCtx?.();
      const args = ["clean", "--dry-run", "--json"];
      if (ctx?.db) args.push("--db", ctx.db);
      if (ctx?.config) args.push("--config", ctx.config);
      if (taskId) {
        args.push(String(taskId));
        if (stepId) args.push(String(stepId));
      } else {
        args.push("--all-pending");
      }
      const res = await runCli(args, { timeout: 30000, label: "clean --dry-run" });
      try {
        return JSON.parse(res.stdout);
      } catch (err) {
        throw new Error(`Invalid clean preview JSON: ${err}`);
      }
    },

    executeClean({ taskId, stepId, cx: optCx } = {}, cx = null) {
      const ctx = getCtx?.();
      const key = taskId ? `clean:${taskId}` : "clean:all";
      return enqueueSerialized(
        key,
        "Clean Resources",
        async () => {
          const args = ["clean"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          if (taskId) {
            args.push(String(taskId));
            if (stepId) args.push(String(stepId));
          } else {
            args.push("--all-pending");
          }
          return runCli(args, { timeout: 60000, label: "clean" });
        },
        { successBody: taskId ? `Cleaned resources for ${taskId}` : "Cleaned all pending resources", cx: optCx || cx },
      );
    },

    enqueueBead(
      beadId,
      { formula, env, currentLabels = [], bdStatus = null, wakeDeferred = false, cx: optCx } = {},
      cx = null,
    ) {
      return enqueueSerialized(
        `enqueue:${beadId}`,
        `Enqueue ${beadId}`,
        async () => runBdExec(beadUpdateArgs(beadId, { formula, env, currentLabels, bdStatus, wakeDeferred })),
        { successBody: `Queued ${beadId} for roscaelifer`, cx: optCx || cx },
      );
    },

    dispatchBead(
      beadId,
      { formula, env, currentLabels = [], bdStatus = null, wakeDeferred = true, maxRunning, cx: optCx } = {},
      cx = null,
    ) {
      const ctx = getCtx?.();
      return enqueueSerialized(
        `dispatch:${beadId}`,
        `Dispatch ${beadId}`,
        async () => {
          await runBdExec(beadUpdateArgs(beadId, { formula, env, currentLabels, bdStatus, wakeDeferred }));
          return runCli(tickArgs(ctx, { env, maxRunning }), { timeout: 60000, label: "tick" });
        },
        { successBody: `Dispatched ${beadId}`, cx: optCx || cx },
      );
    },

    dequeueBead(beadId, cx = null) {
      return enqueueSerialized(
        `dequeue:${beadId}`,
        `Dequeue ${beadId}`,
        async () => runBdExec(["update", beadId, "--remove-label", "roscaelifer"]),
        { successBody: `Dequeued ${beadId}`, cx },
      );
    },

    requeueBead(beadId, currentLabels = [], cx = null) {
      return this.enqueueBead(beadId, { currentLabels }, cx);
    },

    createBead({ title, description, priority = 2, issueType = "task", formula, env, blocks, enqueue = false, cx: optCx } = {}, cx = null) {
      if (!title || !String(title).trim()) {
        return Promise.reject(new Error("Title is required"));
      }
      return enqueueSerialized(
        "create-bead",
        "Create Bead",
        async () => {
          const bdArgs = [
            "create",
            "--title",
            String(title).trim(),
            "--type",
            issueType || "task",
            "--priority",
            String(priority ?? 2),
            "--json",
          ];
          if (description && String(description).trim()) {
            bdArgs.push("--description", String(description).trim());
          }
          const labels = [];
          if (enqueue) labels.push("roscaelifer");
          if (formula) labels.push(`formula:${formula}`);
          if (env) labels.push(`env:${env}`);
          if (labels.length > 0) {
            bdArgs.push("--labels", labels.join(","));
          }
          const res = await runBdExec(bdArgs);
          let createdId = null;
          try {
            const parsed = JSON.parse(res.stdout);
            createdId = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
          } catch {
            // Non-fatal if bd create stdout format varies; dep add only runs when id is known.
          }
          if (createdId && blocks && String(blocks).trim()) {
            const targets = String(blocks)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            for (const targetId of targets) {
              await runBdExec(["dep", "add", targetId, createdId, "--type", "blocks"]);
            }
          }
          return { id: createdId };
        },
        { successBody: (r) => (r?.id ? `Created ${r.id}` : "Created bead"), cx: optCx || cx },
      );
    },

    approveReview(beadId, cx = null) {
      return enqueueSerialized(
        `approve-review:${beadId}`,
        `Approve Review ${beadId}`,
        async () => runBdExec(["update", beadId, "--remove-label", "roscaelifer-review"]),
        { successBody: `Approved ${beadId}`, cx },
      );
    },

    closeBead(beadId, reason = "", cx = null) {
      return enqueueSerialized(
        `close:${beadId}`,
        `Close ${beadId}`,
        async () => {
          const bdArgs = ["close", beadId];
          if (reason && String(reason).trim()) bdArgs.push("--reason", String(reason).trim());
          return runBdExec(bdArgs);
        },
        { successBody: `Closed ${beadId}`, cx },
      );
    },

    rejectReview(beadId, feedback, cx = null) {
      const text = String(feedback || "").trim();
      if (!text) return Promise.reject(new Error("Review feedback is required"));
      return enqueueSerialized(
        `reject:${beadId}`,
        `Reject Review ${beadId}`,
        async () => {
          await runBdExec(["update", beadId, "--append-notes", text]);
          return runBdExec(["reopen", beadId]);
        },
        { successBody: `Reopened ${beadId} with review feedback`, cx },
      );
    },

    reopenBead(beadId, cx = null) {
      return enqueueSerialized(
        `reopen:${beadId}`,
        `Reopen ${beadId}`,
        async () => runBdExec(["reopen", beadId]),
        { successBody: `Reopened ${beadId}`, cx },
      );
    },

    peekTerminal(hcAddress) {
      if (!hcAddress) return;
      run("terminal.peek", { terminal: hcAddress });
    },

    switchToSession(itemOrTarget) {
      const target = typeof itemOrTarget === "string" ? { hcAddress: itemOrTarget } : itemOrTarget || {};
      const session = target.sessionInfo || {};
      const fallbackAddr = session.terminal || target.hcAddress || null;
      if (!fallbackAddr) {
        notify({ title: "Session unavailable", body: "This task has no Herdr terminal address.", level: "warning" });
        return;
      }
      const machine = session.machine || target.machine || null;
      const candidates = new Set([
        fallbackAddr,
        session.terminal,
        target.hcAddress,
        machine && !String(fallbackAddr).includes("/") ? `${machine}/${fallbackAddr}` : null,
        String(fallbackAddr).includes("/") ? String(fallbackAddr).split("/").slice(1).join("/") : null,
      ].filter(Boolean).map(String));
      const matches = (address) => address && [...candidates].includes(String(address));
      const liveAgents = agents() || [];
      const livePanes = panes() || [];
      const liveTerminals = terminals() || [];
      const liveSpaces = spaces() || [];
      const agent = liveAgents.find((entry) => matches(entry?.address));
      if (agent) {
        if (agent.space) run("space.select", { id: agent.space });
        if (agent.tab) run("tab.select", { id: agent.tab });
        run("agent.focus", { terminal: agent.address });
        return;
      }
      const pane = livePanes.find((entry) => matches(entry?.terminal || entry?.address || entry?.hc_address));
      if (pane) {
        const owner = liveSpaces.find((space) => {
          const tabs = Array.isArray(space?.tabs) ? space.tabs : space?.tab ? [space.tab] : [];
          return tabs.some((tab) => String(tab?.id ?? tab?.tab ?? tab) === String(pane.tab));
        });
        if (owner?.id) run("space.select", { id: owner.id });
        if (pane.tab) run("tab.select", { id: pane.tab });
        run("pane.focus", { pane: pane.pane || pane.id });
        return;
      }
      const terminal = liveTerminals.find((entry) => matches(entry?.address));
      if (terminal) {
        const envSpace = session.envSpace;
        const owner = liveSpaces.find((space) => space?.id === envSpace || space?.name === envSpace);
        if (owner?.id) run("space.select", { id: owner.id });
        run("terminal.keep", { terminal: terminal.address, place: "tab" });
        return;
      }
      run("agent.focus", { terminal: fallbackAddr });
      notify({
        title: "Session not in this Herdr window",
        body: `The session at ${fallbackAddr} is not live in this Herdr window. Tried to focus it directly.`,
        level: "warning",
      });
    },

    focusAgent(target) {
      return this.switchToSession(target);
    },

    keepTerminal(hcAddress) {
      if (!hcAddress) return;
      run("terminal.keep", { terminal: hcAddress });
    },

    openWorktree({ name, folder, machine } = {}) {
      if (!folder) return;
      const args = { folder };
      if (name) args.name = name;
      if (machine) args.machine = machine;
      run("space.new", args);
    },
  };
}
