import * as fs from "fs/promises";
import { agents, exec, home, notify, panes, run, spaces, terminals } from "herdr";
import { execRoscaelifer, hasLiveBeadsDir, resolveBinary } from "./store.js";

const BUILTIN_WORKER_FORMULAS = {
  "worker-inplace": `name = "worker-inplace"

[vars]
cwd = ""
provider = "pi-worker"
model = "group/cheap"

[[step]]
id = "work"
kind = "work"
worktree = "cwd"
provider = "{{.Vars.provider}}"
model = "{{.Vars.model}}"
prompt = """
任务：{{.Task.Title}}
{{if .Vars.cwd}}工作目录：{{.Vars.cwd}}
{{end}}
{{.Task.Body}}

要求：
- 在当前工作目录原地完成任务。
- 完成后运行必要的验证命令，简述改动路径、命令结果与未完成项。
"""
`,
  "worker-isolated": `name = "worker-isolated"

[vars]
base = "main"
cwd = ""
provider = "pi-worker"
model = "group/cheap"

[[step]]
id = "work"
kind = "work"
worktree = "new"
provider = "{{.Vars.provider}}"
model = "{{.Vars.model}}"
prompt = """
任务：{{.Task.Title}}
{{if .Vars.cwd}}源目录：{{.Vars.cwd}}
{{end}}
{{.Task.Body}}

要求：
- 在当前隔离 git worktree（基线 {{.Vars.base}}）内完成任务，不要修改原主工作区。
- 完成后运行必要的验证命令，简述改动路径、分支/worktree 与命令结果。
"""
`,
  "worker-verify": `name = "worker-verify"

[vars]
cwd = ""
provider = "pi-worker"
model = "group/cheap"

[[step]]
id = "work"
kind = "work"
worktree = "cwd"
provider = "{{.Vars.provider}}"
model = "{{.Vars.model}}"
prompt = """
只读验收任务：{{.Task.Title}}
{{if .Vars.cwd}}工作目录：{{.Vars.cwd}}
{{end}}
{{.Task.Body}}

要求（严格只读验收）：
- 严禁修改任何代码、配置或工作区文件（不得创建、编辑或提交改动）。
- 核查相关 diff（如 \`git status\` / \`git diff\`）与最终文件状态，并实际运行任务指定的检查与测试命令。
- 如实回报验收结论：包含检查命令、退出码、关键输出、发现的问题或阻塞项；未经实跑不得宣称通过。
"""
`,
  "worker-git": `name = "worker-git"

[vars]
cwd = ""
provider = "pi-worker"
model = "group/cheap"

[[step]]
id = "work"
kind = "work"
worktree = "cwd"
provider = "{{.Vars.provider}}"
model = "{{.Vars.model}}"
prompt = """
Git/PR 执行任务：{{.Task.Title}}
{{if .Vars.cwd}}工作目录：{{.Vars.cwd}}
{{end}}
{{.Task.Body}}

要求：
- 仅执行任务明确授权的 Git/PR 操作（不要擅自扩展范围、强制推送或推送未授权分支）。
- 若指定了提交信息文件，必须严格使用 \`git commit -F <文件>\` 原样提交，不得修改或删减其中任何一行（包括 \`Co-Authored-By\` 等尾部行）。
- 先核对 \`git status\` 与待提交文件范围；完成后回报执行的命令、退出码、commit SHA / PR URL（如有）及最终 \`git status\`。
"""
`,
  "worker-browser": `name = "worker-browser"

[vars]
cwd = ""
provider = "pi-worker"
model = "group/cheap"

[[step]]
id = "work"
kind = "work"
worktree = "cwd"
timeout = "15m"
provider = "{{.Vars.provider}}"
model = "{{.Vars.model}}"
prompt = """
浏览器/UI 验证任务：{{.Task.Title}}
{{if .Vars.cwd}}工作目录：{{.Vars.cwd}}
{{end}}
{{.Task.Body}}

要求：
- 严禁截图（除非任务正文明确要求且确有必要），优先通过页面文本、DOM/脚本断言、控制台与网络日志核对状态。
- 严格控制交互轮次（单次任务交互轮次不超过合理上限，默认 <= 10 轮），避免无限重试或循环操作。
- 仅在受控范围内操作目标页面；遇到 CAPTCHA、登录凭证缺失或环境阻塞时立即停止并如实回报。
- 回报时同时给出核验结论与观测到的关键页面原文/日志原文，不要翻译或改写页面原文文字。
"""
`,
};

function isWipUnsupported(errOrRes) {
  const text = [errOrRes?.message, errOrRes?.stderr, errOrRes?.stdout, errOrRes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /unknown command[：: ]+["']?wip\b/.test(text) || /unknown command.*\bwip\b/.test(text);
}

function encodeVarList(values) {
  const cleaned = (Array.isArray(values) ? values : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1 && !cleaned[0].includes(",") && !cleaned[0].startsWith("[")) {
    return cleaned[0];
  }
  return JSON.stringify(cleaned);
}

async function localFileExists(p) {
  try {
    return await fs.exists(p);
  } catch {
    return false;
  }
}

async function ensureWorkerFormulaPath(ctx, formulaName) {
  const cleanName = String(formulaName || "worker-inplace").replace(/\.toml$/, "");
  const candidates = [
    ctx?.formulasDir ? `${ctx.formulasDir.replace(/\/+$/, "")}/${cleanName}.toml` : "",
    ctx?.repo ? `${ctx.repo.replace(/\/+$/, "")}/formulas/${cleanName}.toml` : "",
    `${String(home() || "").replace(/\/+$/, "")}/.roscaelifer/formulas/${cleanName}.toml`,
  ].filter(Boolean);

  if (ctx?.machine) {
    return candidates[0] || `${cleanName}.toml`;
  }

  for (const cand of candidates) {
    if (await localFileExists(cand)) return cand;
  }

  const template = BUILTIN_WORKER_FORMULAS[cleanName];
  if (!template) {
    throw new Error(`Formula ${cleanName}.toml not found in ${ctx?.formulasDir || "formulas"}`);
  }
  const targetDir = (ctx?.formulasDir || `${String(home() || "").replace(/\/+$/, "")}/.roscaelifer/formulas`).replace(/\/+$/, "");
  const targetPath = `${targetDir}/${cleanName}.toml`;
  const script = 'mkdir -p "$(dirname "$1")" && if [ ! -e "$1" ]; then printf "%s" "$2" > "$1"; fi';
  const res = await exec("sh", ["-c", script, "roscaelifer-init-formula", targetPath, template]);
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || `Unable to write ${targetPath}`).trim());
  }
  return targetPath;
}

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

  async function runCli(args, { timeout = 30000, label = "roscaelifer", ctx: ctxOverride = null } = {}) {
    const ctx = ctxOverride || getCtx?.();
    if (!ctx) throw new Error("No project context selected");
    const runner = await resolveBinary(ctx);
    const res = await execRoscaelifer(ctx, runner, args, { timeout });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || `${label} exited with code ${res.code}`).trim();
      throw new Error(msg);
    }
    return res;
  }

  async function runBdExec(bdArgs, { timeout = 30000, ctx: ctxOverride = null } = {}) {
    const ctx = ctxOverride || getCtx?.();
    if (!ctx) throw new Error("No project context selected");
    const args = ["bd-exec"];
    if (ctx.bdDir) args.push("--bd-dir", ctx.bdDir);
    if (ctx.bdActor) args.push("--bd-actor", ctx.bdActor);
    args.push("--", ...bdArgs);
    return runCli(args, { timeout, label: `bd ${bdArgs[0] || ""}`.trim(), ctx });
  }

  function tickArgs(ctx, { env = null, maxRunning = null, bdActive = true } = {}) {
    const args = ["tick"];
    if (ctx?.db) args.push("--db", ctx.db);
    if (ctx?.config) args.push("--config", ctx.config);
    if (ctx?.formulasDir) args.push("--formulas-dir", ctx.formulasDir);
    if (bdActive) {
      args.push("--bd");
      if (ctx?.bdDir) args.push("--bd-dir", ctx.bdDir);
    } else {
      args.push("--bd=false");
    }
    if (env || ctx?.env) args.push("--env", env || ctx.env);
    if (Number(maxRunning) > 0) args.push("--max-running", String(maxRunning));
    return args;
  }

  function ensureArgs(ctx, { maxRunning = null, bdActive = true } = {}) {
    const args = ["ensure", "--json"];
    if (ctx?.db) args.push("--db", ctx.db);
    if (ctx?.config) args.push("--config", ctx.config);
    if (ctx?.formulasDir) args.push("--formulas-dir", ctx.formulasDir);
    if (bdActive) {
      args.push("--bd");
      if (ctx?.bdDir) args.push("--bd-dir", ctx.bdDir);
    } else {
      args.push("--bd=false");
    }
    if (ctx?.env) args.push("--env", ctx.env);
    if (Number(maxRunning) > 0) args.push("--max-running", String(maxRunning));
    return args;
  }

  async function parseJsonTolerant(res) {
    try {
      return JSON.parse(res?.stdout || "{}");
    } catch {
      return {};
    }
  }

  async function ensureRunner(ctx, { env = null, maxRunning = null, allowTickFallback = false, bdActive = null } = {}) {
    const resolvedBdActive =
      bdActive === null || bdActive === undefined ? await hasLiveBeadsDir(ctx) : Boolean(bdActive);
    try {
      const res = await runCli(ensureArgs(ctx, { maxRunning, bdActive: resolvedBdActive }), { timeout: 15000, label: "ensure", ctx });
      return parseJsonTolerant(res);
    } catch (err) {
      const msg = formatError(err);
      if (allowTickFallback && /unknown command[：: ]+["']?ensure\b/i.test(msg)) {
        await runCli(tickArgs(ctx, { env, maxRunning, bdActive: resolvedBdActive }), { timeout: 60000, label: "tick", ctx });
        return {};
      }
      throw err;
    }
  }

  function runnerStatusSuffix(result) {
    const status = result?.status;
    if (!status) return "";
    const pid = result?.pid ? ` (pid ${result.pid})` : "";
    if (status === "started") return ` — runner started${pid}`;
    if (status === "reused") return ` — reused active runner${pid}`;
    return ` — runner ${status}${pid}`;
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
      const ctx = opts.ctx || getCtx?.();
      return enqueueSerialized(
        "tick",
        "Tick",
        async () => {
          const bdActive = await hasLiveBeadsDir(ctx);
          return runCli(tickArgs(ctx, { env: opts.env || null, maxRunning: opts.maxRunning ?? null, bdActive }), { timeout: 60000, label: "tick", ctx });
        },
        { successBody: "Reconcile pass completed.", cx: opts?.cx || cx },
      );
    },

    /**
     * Ticks every project concurrently in multi-project mode. One failing
     * project never blocks the others; the notification summarises both.
     */
    tickProjects(ctxs = [], cx = null) {
      const list = (Array.isArray(ctxs) ? ctxs : []).filter(Boolean);
      if (list.length === 0) return Promise.reject(new Error("No project context selected"));
      if (list.length === 1) return this.tick({ ctx: list[0] }, cx);
      return enqueueSerialized(
        "tick",
        `Tick ${list.length} projects`,
        async () => {
          const settled = await Promise.allSettled(
            list.map(async (ctx) => {
              const bdActive = await hasLiveBeadsDir(ctx);
              return runCli(
                tickArgs(ctx, { bdActive }),
                { timeout: 60000, label: "tick", ctx },
              );
            }),
          );
          const failures = settled
            .map((entry, index) => (entry.status === "rejected" ? `${list[index]?.label || index}: ${formatError(entry.reason)}` : null))
            .filter(Boolean);
          if (failures.length > 0) {
            throw new Error(`${failures.length}/${list.length} projects failed · ${failures.join(" | ")}`);
          }
          return { count: list.length };
        },
        {
          successBody: (r) => `Tick completed for ${r?.count ?? list.length} projects.`,
          cx,
        },
      );
    },

    approveGate(taskId, stepId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `approve:${taskId}:${stepId}`,
        `Approve ${taskId}`,
        async () => {
          const args = ["approve"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId), String(stepId));
          const res = await runCli(args, { timeout: 45000, label: "approve", ctx });
          await ensureRunner(ctx, { allowTickFallback: false });
          return res;
        },
        { successBody: `Approved step ${stepId}`, cx },
      );
    },

    retryTask(taskId, stepId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `retry:${taskId}:${stepId}`,
        `Retry ${taskId}`,
        async () => {
          const args = ["retry"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId), String(stepId));
          const res = await runCli(args, { timeout: 45000, label: "retry", ctx });
          await ensureRunner(ctx, { allowTickFallback: false });
          return res;
        },
        { successBody: `Reset step ${stepId} for retry`, cx },
      );
    },

    cancelTask(taskId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `cancel:${taskId}`,
        `Cancel ${taskId}`,
        async () => {
          const args = ["cancel"];
          if (ctx?.db) args.push("--db", ctx.db);
          if (ctx?.config) args.push("--config", ctx.config);
          args.push(String(taskId));
          return runCli(args, { timeout: 45000, label: "cancel", ctx });
        },
        { successBody: `Cancelled task ${taskId}`, cx },
      );
    },

    async cleanPreview({ taskId, stepId, ctx: ctxOverride } = {}) {
      const ctx = ctxOverride || getCtx?.();
      const args = ["clean", "--dry-run", "--json"];
      if (ctx?.db) args.push("--db", ctx.db);
      if (ctx?.config) args.push("--config", ctx.config);
      if (taskId) {
        args.push(String(taskId));
        if (stepId) args.push(String(stepId));
      } else {
        args.push("--all-pending");
      }
      const res = await runCli(args, { timeout: 30000, label: "clean --dry-run", ctx });
      try {
        return JSON.parse(res.stdout);
      } catch (err) {
        throw new Error(`Invalid clean preview JSON: ${err}`);
      }
    },

    executeClean({ taskId, stepId, cx: optCx, ctx: ctxOverride } = {}, cx = null) {
      const ctx = ctxOverride || getCtx?.();
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
          return runCli(args, { timeout: 60000, label: "clean", ctx });
        },
        { successBody: taskId ? `Cleaned resources for ${taskId}` : "Cleaned pending resources", cx: optCx || cx },
      );
    },

    enqueueBead(
      beadId,
      { formula, env, currentLabels = [], bdStatus = null, wakeDeferred = false, cx: optCx, ctx: ctxOverride } = {},
      cx = null,
    ) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `enqueue:${beadId}`,
        `Enqueue ${beadId}`,
        async () => {
          await runBdExec(beadUpdateArgs(beadId, { formula, env, currentLabels, bdStatus, wakeDeferred }), { ctx });
          const runnerResult = await ensureRunner(ctx, { allowTickFallback: false });
          return { runner: runnerResult };
        },
        {
          successBody: (r) => `Queued ${beadId} for roscaelifer${runnerStatusSuffix(r?.runner)}`,
          cx: optCx || cx,
        },
      );
    },

    dispatchBead(
      beadId,
      { formula, env, currentLabels = [], bdStatus = null, wakeDeferred = true, maxRunning, cx: optCx, ctx: ctxOverride } = {},
      cx = null,
    ) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `dispatch:${beadId}`,
        `Dispatch ${beadId}`,
        async () => {
          await runBdExec(beadUpdateArgs(beadId, { formula, env, currentLabels, bdStatus, wakeDeferred }), { ctx });
          const runnerResult = await ensureRunner(ctx, { env, maxRunning, allowTickFallback: true });
          return { runner: runnerResult };
        },
        {
          successBody: (r) => `Dispatched ${beadId}${runnerStatusSuffix(r?.runner)}`,
          cx: optCx || cx,
        },
      );
    },

    dequeueBead(beadId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `dequeue:${beadId}`,
        `Dequeue ${beadId}`,
        async () => runBdExec(["update", beadId, "--remove-label", "roscaelifer"], { ctx }),
        { successBody: `Dequeued ${beadId}`, cx },
      );
    },

    requeueBead(beadId, currentLabels = [], cx = null, ctxOverride = null) {
      return this.enqueueBead(beadId, { currentLabels, ctx: ctxOverride }, cx);
    },

    createBead({ title, description, priority = 2, issueType = "task", formula, env, blocks, enqueue = false, cx: optCx, ctx: ctxOverride } = {}, cx = null) {
      if (!title || !String(title).trim()) {
        return Promise.reject(new Error("Title is required"));
      }
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        "create-bead",
        "Create Bead",
        async () => {
          if (!(await hasLiveBeadsDir(ctx))) {
            throw new Error("No .beads directory in this project. Use New WIP Card for standalone tasks, or initialize .beads first.");
          }
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
          const res = await runBdExec(bdArgs, { ctx });
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
              await runBdExec(["dep", "add", targetId, createdId, "--type", "blocks"], { ctx });
            }
          }
          const runnerResult = enqueue ? await ensureRunner(ctx, { allowTickFallback: false, bdActive: true }) : null;
          return { id: createdId, runner: runnerResult };
        },
        {
          successBody: (r) =>
            `${r?.id ? `Created ${r.id}` : "Created bead"}${r?.runner ? runnerStatusSuffix(r.runner) : ""}`,
          cx: optCx || cx,
        },
      );
    },

    createWipCard(
      {
        title,
        description = "",
        formula = "worker-inplace",
        cwd = "",
        model = "group/cheap",
        mcpProfile = "",
        env = "",
        priority = 2,
        cx: optCx,
        ctx: ctxOverride,
      } = {},
      cx = null,
    ) {
      const trimmedTitle = String(title || "").trim();
      if (!trimmedTitle) {
        return Promise.reject(new Error("Title is required"));
      }
      const ctx = ctxOverride || getCtx?.();
      const trimmedDesc = String(description || "").trim();
      const formulaName = String(formula || "worker-inplace").trim() || "worker-inplace";
      const cwdVal = String(cwd || "").trim() || ctx?.repo || "";
      const projectVal = ctx?.repo || cwdVal || String(home() || "");
      const modelVal = String(model || "").trim() || "group/cheap";
      const envVal = String(env || "").trim();
      const mcpList = (Array.isArray(mcpProfile) ? mcpProfile : String(mcpProfile || "").split(","))
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      const mcpEncoded = encodeVarList(mcpList);

      return enqueueSerialized(
        "create-wip",
        "New WIP Card",
        async () => {
          const bdActive = await hasLiveBeadsDir(ctx);
          if (bdActive) {
            const labels = ["roscaelifer", "wip", `formula:${formulaName}`];
            if (envVal) labels.push(`env:${envVal}`);
            const metadata = {};
            if (projectVal) metadata["roscaelifer.project"] = projectVal;
            if (cwdVal) metadata["roscaelifer.var.cwd"] = cwdVal;
            metadata["roscaelifer.var.provider"] = "pi-worker";
            if (modelVal) metadata["roscaelifer.var.model"] = modelVal;
            if (envVal) metadata["roscaelifer.var.env"] = envVal;
            if (mcpEncoded) metadata["roscaelifer.var.mcp_profile"] = mcpEncoded;

            const bdArgs = [
              "create",
              "--ephemeral",
              "--type",
              "task",
              "--title",
              trimmedTitle,
              "--labels",
              labels.join(","),
              "--priority",
              String(priority ?? 2),
              "--json",
            ];
            if (trimmedDesc) bdArgs.push("--description", trimmedDesc);
            if (Object.keys(metadata).length > 0) {
              bdArgs.push("--metadata", JSON.stringify(metadata));
            }
            const res = await runBdExec(bdArgs, { ctx });
            let createdId = null;
            try {
              const parsed = JSON.parse(res.stdout);
              createdId = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
            } catch {
              // Non-fatal if bd create stdout format varies.
            }
            const runnerResult = await ensureRunner(ctx, {
              env: envVal || null,
              allowTickFallback: true,
              bdActive: true,
            });
            return { id: createdId, mode: "bd", runner: runnerResult };
          }

          const runner = await resolveBinary(ctx);
          if (runner?.supportsWip !== false) {
            const wipArgs = ["wip", "--json", "--bd=false"];
            if (ctx?.db) wipArgs.push("--db", ctx.db);
            if (ctx?.config) wipArgs.push("--config", ctx.config);
            if (ctx?.formulasDir) wipArgs.push("--formulas-dir", ctx.formulasDir);
            wipArgs.push("--formula", formulaName);
            if (cwdVal) wipArgs.push("--cwd", cwdVal);
            wipArgs.push("--provider", "pi-worker");
            wipArgs.push("--model", modelVal);
            if (envVal) wipArgs.push("--env", envVal);
            for (const profile of mcpList) {
              wipArgs.push("--mcp-profile", profile);
            }
            wipArgs.push("--title", trimmedTitle);
            if (trimmedDesc) wipArgs.push("--body", trimmedDesc);

            try {
              const res = await runCli(wipArgs, { timeout: 30000, label: "wip", ctx });
              const parsed = await parseJsonTolerant(res);
              return {
                id: parsed.task_id || parsed.bead_id || null,
                mode: parsed.mode || "standalone",
                runner: parsed.runner || null,
              };
            } catch (err) {
              if (!isWipUnsupported(err)) throw err;
              if (runner) runner.supportsWip = false;
            }
          }

          const formulaPath = await ensureWorkerFormulaPath(ctx, formulaName);
          const addArgs = ["add"];
          if (ctx?.db) addArgs.push("--db", ctx.db);
          if (ctx?.config) addArgs.push("--config", ctx.config);
          if (envVal) addArgs.push("--env", envVal);
          addArgs.push("--formula", formulaPath);
          addArgs.push("--project", projectVal);
          addArgs.push("--title", trimmedTitle);
          if (trimmedDesc) addArgs.push("--body", trimmedDesc);
          if (cwdVal) addArgs.push("--var", `cwd=${cwdVal}`);
          addArgs.push("--var", "provider=pi-worker");
          if (modelVal) addArgs.push("--var", `model=${modelVal}`);
          if (envVal) addArgs.push("--var", `env=${envVal}`);
          if (mcpEncoded) addArgs.push("--var", `mcp_profile=${mcpEncoded}`);

          const addRes = await runCli(addArgs, { timeout: 30000, label: "add", ctx });
          const taskId = String(addRes.stdout || "").trim() || null;
          const runnerResult = await ensureRunner(ctx, {
            env: envVal || null,
            allowTickFallback: true,
            bdActive: false,
          });
          return { id: taskId, mode: "standalone", runner: runnerResult };
        },
        {
          successBody: (r) =>
            `${r?.id ? `Created WIP ${r.id}` : "Created WIP card"}${r?.runner ? runnerStatusSuffix(r.runner) : ""}`,
          cx: optCx || cx,
        },
      );
    },

    approveReview(beadId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `approve-review:${beadId}`,
        `Approve Review ${beadId}`,
        async () => runBdExec(["update", beadId, "--remove-label", "roscaelifer-review"], { ctx }),
        { successBody: `Approved ${beadId}`, cx },
      );
    },

    closeBead(beadId, reason = "", cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `close:${beadId}`,
        `Close ${beadId}`,
        async () => {
          const bdArgs = ["close", beadId];
          if (reason && String(reason).trim()) bdArgs.push("--reason", String(reason).trim());
          return runBdExec(bdArgs, { ctx });
        },
        { successBody: `Closed ${beadId}`, cx },
      );
    },

    rejectReview(beadId, feedback, cx = null, ctxOverride = null) {
      const text = String(feedback || "").trim();
      if (!text) return Promise.reject(new Error("Review feedback is required"));
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `reject:${beadId}`,
        `Reject Review ${beadId}`,
        async () => {
          await runBdExec(["update", beadId, "--append-notes", text], { ctx });
          return runBdExec(["reopen", beadId], { ctx });
        },
        { successBody: `Reopened ${beadId} with review feedback`, cx },
      );
    },

    reopenBead(beadId, cx = null, ctxOverride = null) {
      const ctx = ctxOverride || getCtx?.();
      return enqueueSerialized(
        `reopen:${beadId}`,
        `Reopen ${beadId}`,
        async () => runBdExec(["reopen", beadId], { ctx }),
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
