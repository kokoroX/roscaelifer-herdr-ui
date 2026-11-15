import * as fs from "fs/promises";
import { exec, home } from "herdr";

const HISTORY_KEY = "roscaelifer.repoHistory.v1";
const ACTIVE_REPO_KEY = "roscaelifer.activeRepo.v1";
const MAX_HISTORY = 10;

const AGENT_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

export function safeStorageGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Ignore storage failures during headless check or restricted contexts.
  }
}

export function loadRepoHistory() {
  const list = safeStorageGet(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function loadActiveRepo() {
  const item = safeStorageGet(ACTIVE_REPO_KEY, null);
  return item && typeof item === "object" ? item : null;
}

export function saveRepoContext(ctx) {
  if (!ctx || (!ctx.repo && !ctx.db && !ctx.bdDir)) return;
  const entry = {
    repo: ctx.repo || "",
    db: ctx.db || "",
    bdDir: ctx.bdDir || "",
    config: ctx.config || "",
    formulasDir: ctx.formulasDir || "",
    bin: ctx.bin || "",
    env: ctx.env || "",
    label: ctx.label || repoLabel(ctx),
    updatedAt: Date.now(),
  };
  safeStorageSet(ACTIVE_REPO_KEY, entry);
  const key = contextKey(entry);
  const next = [entry, ...loadRepoHistory().filter((x) => contextKey(x) !== key)].slice(0, MAX_HISTORY);
  safeStorageSet(HISTORY_KEY, next);
}

export function repoLabel(ctx) {
  if (!ctx) return "No repository";
  if (ctx.label) return ctx.label;
  const base = ctx.repo || ctx.bdDir || ctx.db || "";
  if (!base) return "Custom DB";
  const parts = base.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || base;
}

export function contextKey(ctx) {
  if (!ctx) return "";
  return [
    ctx.repo || "",
    ctx.db || "",
    ctx.bdDir || "",
    ctx.config || "",
    ctx.formulasDir || "",
    ctx.bin || "",
  ].join("|");
}

function parentDir(dir) {
  const clean = dir.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return clean.slice(0, idx);
}

function normalizePath(p) {
  if (!p) return "";
  if (p.startsWith("~/")) return `${home()}${p.slice(1)}`;
  return p.replace(/\/+$/, "") || "/";
}

async function pathExists(p) {
  try {
    return await fs.exists(p);
  } catch {
    return false;
  }
}

async function probeRepoRoot(dir) {
  const clean = normalizePath(dir);
  if (!clean) return null;
  const [hasRosc, hasDb, hasBeads, hasToml, hasFormulas] = await Promise.all([
    pathExists(`${clean}/.roscaelifer`),
    pathExists(`${clean}/.roscaelifer/roscaelifer.db`),
    pathExists(`${clean}/.beads`),
    pathExists(`${clean}/roscaelifer.toml`),
    pathExists(`${clean}/formulas`),
  ]);
  if (!hasRosc && !hasDb && !hasBeads && !hasToml) return null;
  return {
    repo: clean,
    db: hasDb || hasRosc ? `${clean}/.roscaelifer/roscaelifer.db` : "",
    bdDir: hasBeads ? `${clean}/.beads` : "",
    config: hasToml ? `${clean}/roscaelifer.toml` : "",
    formulasDir: hasFormulas ? `${clean}/formulas` : "",
    hasBeads,
    label: clean.split("/").filter(Boolean).pop() || clean,
    source: "detected",
  };
}

export async function detectRepoFromPath(startPath) {
  let cur = normalizePath(startPath);
  if (!cur) return null;
  const userHome = normalizePath(home());

  for (let i = 0; i < 12 && cur; i++) {
    const found = await probeRepoRoot(cur);
    if (found) return found;
    if (cur === "/" || cur === userHome) break;
    const next = parentDir(cur);
    if (!next || next === cur) break;
    cur = next;
  }

  // Linked git worktrees store .beads / .roscaelifer in the main checkout.
  try {
    const res = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: normalizePath(startPath),
      timeout: 3000,
    });
    if (res.code === 0) {
      const common = res.stdout.trim();
      const mainRepo = common.endsWith("/.git") ? common.slice(0, -5) : "";
      if (mainRepo) {
        const found = await probeRepoRoot(mainRepo);
        if (found) {
          found.source = "git-common-dir";
          return found;
        }
      }
    }
  } catch {
    // Ignore git detection errors.
  }
  return null;
}

export function buildContextFromProps(rawProps, overrideCtx = null) {
  const src = overrideCtx || rawProps || {};
  const repo = normalizePath(src.repo || "");
  const db = src.db ? normalizePath(src.db) : repo ? `${repo}/.roscaelifer/roscaelifer.db` : "";
  const bdDir = src.bdDir ? normalizePath(src.bdDir) : repo ? `${repo}/.beads` : "";
  const config = src.config ? normalizePath(src.config) : repo ? `${repo}/roscaelifer.toml` : "";
  const formulasDir = src.formulasDir ? normalizePath(src.formulasDir) : repo ? `${repo}/formulas` : "";
  if (!repo && !db && !bdDir && !config && !formulasDir) return null;
  const ctx = {
    repo,
    db,
    bdDir,
    config,
    formulasDir,
    bin: src.bin || rawProps?.bin || "",
    env: src.env || rawProps?.env || "",
    label: src.label || "",
    source: overrideCtx ? "override" : "props",
  };
  ctx.label = repoLabel(ctx);
  return ctx;
}

export async function resolveContext(rawProps, { focusedInfo, spaceList, paneList, sharedOverride } = {}) {
  const fromOverride = buildContextFromProps(rawProps, sharedOverride);
  if (fromOverride) return fromOverride;

  const fromProps = buildContextFromProps(rawProps, null);
  if (fromProps) return fromProps;

  const candidates = [];
  if (focusedInfo?.cwd) candidates.push(focusedInfo.cwd);
  const activeSpace = (spaceList || []).find((s) => s.active);
  if (activeSpace?.folder) candidates.push(activeSpace.folder);
  for (const p of paneList || []) {
    if (p?.cwd) candidates.push(p.cwd);
  }

  const seen = new Set();
  for (const dir of candidates) {
    const clean = normalizePath(dir);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const detected = await detectRepoFromPath(clean);
    if (detected) {
      if (rawProps?.bin) detected.bin = rawProps.bin;
      if (rawProps?.env) detected.env = rawProps.env;
      return detected;
    }
  }

  const activeSaved = loadActiveRepo();
  if (activeSaved) {
    return {
      ...activeSaved,
      bin: activeSaved.bin || rawProps?.bin || "",
      source: "history",
    };
  }
  const history = loadRepoHistory();
  if (history.length > 0) {
    return {
      ...history[0],
      bin: history[0].bin || rawProps?.bin || "",
      source: "history",
    };
  }
  return null;
}

export async function resolveBinary(ctx) {
  const userHome = normalizePath(home());
  const candidates = [];
  if (ctx?.bin) candidates.push(normalizePath(ctx.bin));
  candidates.push(
    "roscaelifer-herdr",
    `${userHome}/.local/bin/roscaelifer-herdr`,
    `${userHome}/go/bin/roscaelifer-herdr`,
    "/opt/homebrew/bin/roscaelifer-herdr",
    "/usr/local/bin/roscaelifer-herdr",
    "roscaelifer",
    `${userHome}/.local/bin/roscaelifer`,
    `${userHome}/go/bin/roscaelifer`,
    "/opt/homebrew/bin/roscaelifer",
    "/usr/local/bin/roscaelifer",
  );

  for (const bin of candidates) {
    if (!bin) continue;
    try {
      // Probe with the snapshot subcommand so legacy roscaelifer builds that
      // lack it are not selected.
      const res = await exec(bin, ["snapshot", "--help"], { timeout: 4000 });
      if (res.code === 0) {
        return { cmd: bin, prefixArgs: [], label: bin };
      }
    } catch {
      // Try next candidate.
    }
  }

  if (ctx?.repo && (await pathExists(`${ctx.repo}/cmd/roscaelifer/main.go`))) {
    try {
      const goCheck = await exec("go", ["version"], { timeout: 3000 });
      if (goCheck.code === 0) {
        return {
          cmd: "go",
          prefixArgs: ["run", "./cmd/roscaelifer"],
          label: "go run ./cmd/roscaelifer",
        };
      }
    } catch {
      // No go fallback available.
    }
  }

  throw new Error(
    "roscaelifer binary not found in props().bin, PATH, ~/.local/bin/roscaelifer-herdr, ~/go/bin/roscaelifer-herdr, ~/.local/bin/roscaelifer, or ~/go/bin/roscaelifer",
  );
}

export async function execRoscaelifer(ctx, runner, args, opts = {}) {
  const resolved = runner || (await resolveBinary(ctx));
  const fullArgs = [...(resolved.prefixArgs || []), ...args];
  const cwd = ctx?.repo || undefined;
  const timeout = opts.timeout ?? 30000;
  return exec(resolved.cmd, fullArgs, { ...(cwd ? { cwd } : {}), timeout });
}

export function appendDbAndConfigFlags(args, ctx, { includeConfig = true, includeBd = false, includeFormulas = false } = {}) {
  const out = [...args];
  if (ctx?.db) out.push("--db", ctx.db);
  if (includeConfig && ctx?.config) out.push("--config", ctx.config);
  if (includeFormulas && ctx?.formulasDir) out.push("--formulas-dir", ctx.formulasDir);
  if (includeBd && ctx?.bdDir) {
    out.push("--bd", "--bd-dir", ctx.bdDir);
  }
  return out;
}

export async function fetchSnapshot(ctx, runner, opts = {}) {
  const args = ["snapshot", "--json"];
  if (ctx?.db) args.push("--db", ctx.db);
  if (ctx?.config) args.push("--config", ctx.config);
  if (ctx?.formulasDir) args.push("--formulas-dir", ctx.formulasDir);
  if (ctx?.bdDir || opts.bd !== false) {
    args.push("--bd");
    if (ctx?.bdDir) args.push("--bd-dir", ctx.bdDir);
  }
  if (opts.eventsLimit) args.push("--events-limit", String(opts.eventsLimit));
  if (opts.closedLimit) args.push("--closed-limit", String(opts.closedLimit));

  const res = await execRoscaelifer(ctx, runner, args, { timeout: opts.timeout ?? 25000 });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || `snapshot exited ${res.code}`).trim());
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`Invalid snapshot JSON: ${err}`);
  }
}

export async function fetchTaskDetail(ctx, runner, taskId) {
  if (!taskId) return null;
  const args = ["show", "--json", String(taskId)];
  if (ctx?.db) args.push("--db", ctx.db);
  const res = await execRoscaelifer(ctx, runner, args, { timeout: 15000 });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || `show ${taskId} exited ${res.code}`).trim());
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`Invalid show JSON: ${err}`);
  }
}

function stripTaskMetaPrefix(val) {
  if (!val) return "";
  const s = String(val).trim();
  return s.startsWith("task:") ? s.slice(5) : s;
}

function labelValue(labels, prefix) {
  for (const l of labels || []) {
    if (typeof l === "string" && l.startsWith(prefix)) {
      return l.slice(prefix.length);
    }
  }
  return null;
}

function hasLabel(labels, name) {
  return Array.isArray(labels) && labels.includes(name);
}

function parseDepTarget(dep) {
  if (!dep) return "";
  if (dep.depends_on_id) return String(dep.depends_on_id);
  if (dep.issue_id && !dep.id) return String(dep.issue_id);
  return dep.id ? String(dep.id) : "";
}

function parseDepType(dep) {
  return dep?.dependency_type || dep?.type || "blocks";
}

function parseHcAddressFromThread(threadId) {
  if (!threadId || typeof threadId !== "string") return "";
  if (!threadId.startsWith("herdr:")) return "";
  const rest = threadId.slice("herdr:".length);
  const idx = rest.indexOf(":");
  return idx >= 0 ? rest.slice(idx + 1) : "";
}

function normalizeAddress(addr, envObj) {
  if (!addr) return [];
  const out = [addr];
  const machine = envObj?.machine;
  if (machine && !addr.includes("/")) {
    out.push(`${machine}/${addr}`);
  }
  if (addr.includes("/")) {
    out.push(addr.split("/").slice(1).join("/"));
  }
  return out;
}

function buildHerdrLookup(agents = [], terminals = []) {
  const agentByAddr = new Map();
  for (const a of agents || []) {
    if (!a?.address) continue;
    agentByAddr.set(a.address, a);
  }
  const termByAddr = new Map();
  for (const t of terminals || []) {
    if (!t?.address) continue;
    termByAddr.set(t.address, t);
  }
  return {
    findAgent(hcAddress, envObj) {
      for (const candidate of normalizeAddress(hcAddress, envObj)) {
        if (agentByAddr.has(candidate)) return agentByAddr.get(candidate);
      }
      return null;
    },
    findTerminal(hcAddress, envObj) {
      for (const candidate of normalizeAddress(hcAddress, envObj)) {
        if (termByAddr.has(candidate)) return termByAddr.get(candidate);
      }
      return null;
    },
  };
}

function resolveLiveStatus(agent, terminal) {
  if (agent?.status) return agent.status;
  if (terminal?.state === "live" && terminal?.status) {
    if (terminal.status === "error") return "blocked";
    if (["working", "blocked", "done", "idle"].includes(terminal.status)) {
      return terminal.status;
    }
  }
  return null;
}

function normalizeSteps(rawSteps, envObj, lookup) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  return steps.map((s) => {
    const attempt = s.current_attempt || s.attempt || null;
    const hcAddress =
      attempt?.hc_address ||
      parseHcAddressFromThread(attempt?.thread_id) ||
      null;
    const liveAgent = hcAddress ? lookup.findAgent(hcAddress, envObj) : null;
    const liveTerminal = hcAddress ? lookup.findTerminal(hcAddress, envObj) : null;
    return {
      stepId: s.step_id || s.id || "",
      ordinal: s.ordinal ?? 0,
      kind: s.kind || "work",
      status: s.status || "pending",
      maxAttempts: s.max_attempts ?? 1,
      maxRounds: s.max_rounds ?? 1,
      rounds: s.rounds ?? 0,
      retryGen: s.retry_gen ?? 0,
      dispatchFailures: s.dispatch_failures ?? 0,
      detail: s.detail || "",
      runningSince: s.running_since || null,
      createdAt: s.created_at || null,
      updatedAt: s.updated_at || null,
      currentAttempt: attempt
        ? {
            n: attempt.n ?? 1,
            status: attempt.status || "",
            threadId: attempt.thread_id || "",
            hcEnv: attempt.hc_env || "",
            hcAddress,
            marker: attempt.marker || "",
            worktree: attempt.worktree || "",
            branch: attempt.branch || "",
            link: attempt.effective_link || attempt.link || "",
            lastAgentStatus: attempt.last_agent_status || "",
            hasReply: Boolean(attempt.has_reply),
          }
        : null,
      hcAddress,
      liveAgent,
      liveTerminal,
      agentStatus: resolveLiveStatus(liveAgent, liveTerminal),
    };
  });
}

function pickCurrentStep(steps) {
  if (!steps.length) return null;
  return (
    steps.find((s) => s.status === "waiting_approval" || s.status === "needs_human") ||
    steps.find((s) => s.status === "running") ||
    steps.find((s) => s.status === "failed") ||
    steps.find((s) => s.status === "pending") ||
    steps[steps.length - 1]
  );
}

function pickBestTaskForBead(tasks, metaTaskId) {
  if (!tasks || !tasks.length) return null;
  if (metaTaskId) {
    const matched = tasks.find((t) => String(t.id) === metaTaskId);
    if (matched) return matched;
  }
  const active = tasks.find((t) => t.status === "active");
  if (active) return active;
  return [...tasks].sort((a, b) => {
    const ta = Date.parse(a.updated_at || a.created_at || "") || 0;
    const tb = Date.parse(b.updated_at || b.created_at || "") || 0;
    return tb - ta;
  })[0];
}

export function normalizeQueue(snapshot, { agents = [], terminals = [], spaces = [] } = {}) {
  const snap = snapshot || {};
  const cfg = snap.config || {};
  const defaultEnv = cfg.default_env || "local";
  const rawEnvs = Array.isArray(cfg.envs) ? cfg.envs : [];
  const envsByName = new Map();
  const envs = rawEnvs.map((e) => {
    const obj = {
      name: e.name,
      kind: e.kind || "local",
      session: e.session || "",
      machine: e.machine || null,
      space: e.space || null,
      maxRunning: e.max_running ?? 0,
      runningWorkSteps: e.running_work_steps ?? 0,
      projects: e.projects || {},
    };
    envsByName.set(obj.name, obj);
    return obj;
  });
  if (!envsByName.has(defaultEnv)) {
    const fallback = {
      name: defaultEnv,
      kind: "local",
      session: "",
      machine: null,
      space: null,
      maxRunning: 0,
      runningWorkSteps: 0,
      projects: {},
    };
    envs.unshift(fallback);
    envsByName.set(defaultEnv, fallback);
  }

  const formulas = Array.isArray(cfg.formulas) ? cfg.formulas : [];
  const lookup = buildHerdrLookup(agents, terminals);

  const rawTasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  const tasksById = new Map();
  const tasksByBead = new Map();
  const standaloneTasks = [];
  for (const t of rawTasks) {
    tasksById.set(String(t.id), t);
    if (t.bead_id) {
      if (!tasksByBead.has(t.bead_id)) tasksByBead.set(t.bead_id, []);
      tasksByBead.get(t.bead_id).push(t);
    } else {
      standaloneTasks.push(t);
    }
  }

  const rawSidecars = Array.isArray(snap.sidecars) ? snap.sidecars : [];
  const sidecarsByTaskPrefix = new Map();
  for (const sc of rawSidecars) {
    const marker = sc.marker || "";
    const match = /\[(?:[^:\]]+:)?([^\]#/:]+)/.exec(marker);
    const tid = match ? match[1] : "";
    if (tid) {
      if (!sidecarsByTaskPrefix.has(tid)) sidecarsByTaskPrefix.set(tid, []);
      sidecarsByTaskPrefix.get(tid).push(sc);
    }
  }

  const bd = snap.bd || {};
  const bdAvailable = Boolean(bd.available);
  const bdError = bd.error || null;
  const readySet = new Set(Array.isArray(bd.ready_ids) ? bd.ready_ids : []);
  const intakeList = Array.isArray(bd.intake_preview) ? bd.intake_preview : [];
  const intakeByBead = new Map();
  for (const plan of intakeList) {
    if (plan?.bead_id) intakeByBead.set(plan.bead_id, plan);
  }

  const rawIssues = Array.isArray(bd.issues) ? bd.issues : [];
  const issueMap = new Map();
  const epicsRaw = [];
  const workIssues = [];
  for (const issue of rawIssues) {
    issueMap.set(issue.id, issue);
    if (issue.issue_type === "epic") {
      epicsRaw.push(issue);
    } else {
      workIssues.push(issue);
    }
  }

  const blocksOut = new Map();
  for (const issue of rawIssues) {
    for (const dep of issue.dependencies || []) {
      if (parseDepType(dep) !== "blocks") continue;
      const target = parseDepTarget(dep);
      if (!target) continue;
      if (!blocksOut.has(target)) blocksOut.set(target, []);
      blocksOut.get(target).push(issue.id);
    }
  }

  const items = [];
  const itemsById = new Map();

  function buildItem({ issue = null, task = null }) {
    const beadId = issue ? issue.id : task?.bead_id || null;
    const taskId = task ? String(task.id) : null;
    const id = beadId || `task:${taskId}`;
    const labels = Array.isArray(issue?.labels) ? [...issue.labels] : [];
    const intakePlan = beadId ? intakeByBead.get(beadId) || null : null;

    const envName =
      task?.resolved_env ||
      intakePlan?.env ||
      labelValue(labels, "env:") ||
      defaultEnv;
    const envObj = envsByName.get(envName) || null;
    const formula =
      task?.formula_name ||
      intakePlan?.formula ||
      labelValue(labels, "formula:") ||
      null;
    const project =
      task?.project ||
      intakePlan?.project ||
      issue?.metadata?.["roscaelifer.project"] ||
      null;

    const steps = normalizeSteps(task?.steps, envObj, lookup);
    const currentStep = pickCurrentStep(steps);
    const sidecars = taskId ? sidecarsByTaskPrefix.get(taskId) || [] : [];
    const pendingSidecarCount = sidecars.filter((s) => s.pending_cleanup).length;
    const taskPendingCleanups = Array.isArray(task?.pending_cleanups)
      ? task.pending_cleanups
      : [];
    const pendingCleanupCount = Math.max(
      taskPendingCleanups.length,
      pendingSidecarCount,
    );
    const pendingCleanup = pendingCleanupCount > 0;

    let hcAddress = currentStep?.hcAddress || null;
    if (!hcAddress) {
      const withAddr = [...steps].reverse().find((s) => s.hcAddress);
      hcAddress = withAddr?.hcAddress || null;
    }
    if (!hcAddress && taskPendingCleanups.length > 0) {
      hcAddress = taskPendingCleanups[0].hc_address || taskPendingCleanups[0].pane_id || null;
    }
    if (!hcAddress && sidecars.length > 0) {
      hcAddress = sidecars[0].pane_id || null;
    }

    const liveAgent =
      currentStep?.liveAgent ||
      (hcAddress ? lookup.findAgent(hcAddress, envObj) : null);
    const liveTerminal =
      currentStep?.liveTerminal ||
      (hcAddress ? lookup.findTerminal(hcAddress, envObj) : null);
    const agentStatus =
      currentStep?.agentStatus || resolveLiveStatus(liveAgent, liveTerminal);

    const attempt = currentStep?.currentAttempt || null;
    const worktree =
      attempt?.worktree ||
      taskPendingCleanups[0]?.worktree ||
      sidecars[0]?.worktree ||
      null;
    const branch =
      attempt?.branch ||
      taskPendingCleanups[0]?.branch ||
      sidecars[0]?.branch ||
      null;
    const link = attempt?.link || null;

    const bdStatus = issue?.status || null;
    const taskStatus = task?.status || null;
    const isOptedIn = hasLabel(labels, "roscaelifer");
    const needsReview = hasLabel(labels, "roscaelifer-review");
    const hasFailedLabel =
      hasLabel(labels, "roscaelifer-failed") ||
      hasLabel(labels, "roscaelifer-cancelled") ||
      hasLabel(labels, "roscaelifer-invalid");
    const isReady = beadId ? readySet.has(beadId) : false;

    const blockedBy = [];
    for (const dep of issue?.dependencies || []) {
      if (parseDepType(dep) !== "blocks") continue;
      const target = parseDepTarget(dep);
      if (target) blockedBy.push(target);
    }
    const isBlocked = blockedBy.some((depId) => {
      const target = issueMap.get(depId);
      return target ? target.status !== "closed" : true;
    });

    const waitingApprovalStep = steps.find((s) => s.status === "waiting_approval");
    const needsHumanStep = steps.find((s) => s.status === "needs_human");
    const failedStep = steps.find((s) => s.status === "failed");

    let column = "ready";
    let actionReason = null;

    if (bdStatus === "closed") {
      if (needsReview) {
        column = "review";
      } else if (taskStatus === "active") {
        column = waitingApprovalStep || needsHumanStep ? "action" : "running";
      } else {
        column = "closed";
      }
    } else if (!beadId && (taskStatus === "done" || taskStatus === "cancelled")) {
      column = taskStatus === "cancelled" ? "action" : "closed";
      if (taskStatus === "cancelled") actionReason = "cancelled";
    } else if (waitingApprovalStep) {
      column = "action";
      actionReason = "waiting_approval";
    } else if (needsHumanStep) {
      column = "action";
      actionReason = "needs_human";
    } else if (hasFailedLabel) {
      column = "action";
      actionReason = hasLabel(labels, "roscaelifer-invalid")
        ? "invalid"
        : hasLabel(labels, "roscaelifer-cancelled")
          ? "cancelled"
          : "failed";
    } else if (
      (taskStatus === "failed" || taskStatus === "cancelled") &&
      !(isOptedIn && isReady && intakePlan?.action === "create")
    ) {
      column = "action";
      actionReason = taskStatus;
    } else if (taskStatus === "active" || bdStatus === "in_progress") {
      column = "running";
    } else {
      column = "ready";
    }

    // Also pick up live blocked agent status as informational badge (stays in running unless step paused).
    const item = {
      id,
      beadId,
      taskId,
      title: issue?.title || task?.title || id,
      body: issue?.description || task?.body || "",
      description: issue?.description || "",
      acceptanceCriteria: issue?.acceptance_criteria || "",
      notes: issue?.notes || "",
      closeReason: issue?.close_reason || "",
      priority: issue ? issue.priority ?? 2 : null,
      issueType: issue?.issue_type || "task",
      status: bdStatus || taskStatus || "open",
      bdStatus,
      taskStatus,
      column,
      actionReason,
      labels,
      formula,
      env: envName,
      machine: envObj?.machine || null,
      project,
      assignee: issue?.assignee || "",
      parent: issue?.parent || null,
      blockedBy,
      blocks: blocksOut.get(id) || [],
      steps,
      currentStep,
      waitingStep: waitingApprovalStep || needsHumanStep || failedStep || null,
      hcAddress,
      worktree,
      branch,
      link,
      liveAgent,
      liveTerminal,
      agentStatus,
      pendingCleanup,
      pendingCleanupCount,
      pendingCleanups: taskPendingCleanups,
      sidecars,
      intakePlan,
      isReady,
      isOptedIn,
      needsReview,
      hasFailedLabel,
      isBlocked,
      createdAt: issue?.created_at || task?.created_at || null,
      updatedAt: task?.updated_at || issue?.created_at || null,
      issue,
      task,
    };
    return item;
  }

  for (const issue of workIssues) {
    const metaTaskId = stripTaskMetaPrefix(issue?.metadata?.["roscaelifer.task"]);
    const matchingTasks = tasksByBead.get(issue.id) || [];
    const task = pickBestTaskForBead(matchingTasks, metaTaskId);
    const item = buildItem({ issue, task });
    items.push(item);
    itemsById.set(item.id, item);
  }

  for (const task of standaloneTasks) {
    const item = buildItem({ issue: null, task });
    items.push(item);
    itemsById.set(item.id, item);
  }

  // Sort items deterministically: higher priority (P0=0) first, ready/opted-in next, then newest/id.
  const sortItems = (list) =>
    [...list].sort((a, b) => {
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.isOptedIn !== b.isOptedIn) return a.isOptedIn ? -1 : 1;
      if (a.isReady !== b.isReady) return a.isReady ? -1 : 1;
      const ar = a.agentStatus ? AGENT_RANK[a.agentStatus] ?? 0 : 0;
      const br = b.agentStatus ? AGENT_RANK[b.agentStatus] ?? 0 : 0;
      if (ar !== br) return br - ar;
      return a.id.localeCompare(b.id);
    });

  const columns = {
    ready: sortItems(items.filter((i) => i.column === "ready")),
    running: sortItems(items.filter((i) => i.column === "running")),
    action: sortItems(items.filter((i) => i.column === "action")),
    review: sortItems(items.filter((i) => i.column === "review")),
    closed: sortItems(items.filter((i) => i.column === "closed")),
  };

  // Build epic summaries (plus expose epics in itemsById for dependency lookup if referenced).
  const epics = epicsRaw.map((epic) => {
    const children = items.filter(
      (i) => i.parent === epic.id || (i.beadId && i.beadId.startsWith(`${epic.id}.`)),
    );
    const counts = { ready: 0, running: 0, action: 0, review: 0, closed: 0, total: children.length };
    for (const c of children) counts[c.column] = (counts[c.column] || 0) + 1;
    const doneCount = counts.closed + counts.review;
    const progress = counts.total > 0 ? doneCount / counts.total : epic.status === "closed" ? 1 : 0;
    return {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      priority: epic.priority ?? 2,
      description: epic.description || "",
      acceptanceCriteria: epic.acceptance_criteria || "",
      labels: epic.labels || [],
      children: sortItems(children),
      counts,
      progress,
      issue: epic,
    };
  });

  // Also include epics in itemsById so deps graph lookups never miss an epic reference.
  for (const e of epics) {
    if (!itemsById.has(e.id)) {
      itemsById.set(e.id, {
        id: e.id,
        beadId: e.id,
        taskId: null,
        title: e.title,
        priority: e.priority,
        issueType: "epic",
        status: e.status,
        bdStatus: e.status,
        column: e.status === "closed" ? "closed" : "ready",
        labels: e.labels,
        blockedBy: [],
        blocks: blocksOut.get(e.id) || [],
        issue: e.issue,
      });
    }
  }

  return {
    items,
    itemsById,
    columns,
    epics,
    envs,
    envsByName,
    defaultEnv,
    formulas,
    mirror: cfg.mirror || {},
    mirrorIntegrations: Array.isArray(snap.mirror_integrations) ? snap.mirror_integrations : [],
    events: Array.isArray(snap.events) ? snap.events : [],
    intakePreview: intakeList,
    bdAvailable,
    bdError,
    runner: snap.runner || { lock_path: "", lock_held: false },
    paths: snap.paths || {},
    generatedAt: snap.generated_at || null,
    spacesCount: (spaces || []).length,
  };
}
