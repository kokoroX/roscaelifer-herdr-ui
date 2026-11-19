import * as fs from "fs/promises";
import { exec, focused, home, panes, readTextFile, spaces, checking } from "herdr";

const HISTORY_KEY = "roscaelifer.repoHistory.v1";
const ACTIVE_REPO_KEY = "roscaelifer.activeRepo.v1";
const ACTIVE_PROJECT_KEY = "roscaelifer.activeProject.v1";
const PROJECTS_CONFIG_VERSION = 1;
const SNAPSHOT_CACHE_PREFIX = "roscaelifer.snapshotCache.v1:";
const SNAPSHOT_CACHE_INDEX_KEY = "roscaelifer.snapshotCacheIndex.v1";
const MAX_HISTORY = 10;
const MAX_CACHED_REPOS = 6;
const MAX_CACHED_SNAPSHOT_CHARS = 512 * 1024;
const BEADS_ARTIFACTS = [
  "metadata.json",
  "dolt",
  "beads.db",
  "issues.jsonl",
  "redirect",
  "config.yaml",
];

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

function normalizeMachine(machine) {
  return typeof machine === "string" ? machine.trim() : "";
}

function isBogusStoredContext(ctx) {
  if (!ctx || typeof ctx !== "object") return true;
  const rawRepo = typeof ctx.repo === "string" ? ctx.repo : "";
  if (!rawRepo) return !ctx.db && !ctx.bdDir;
  const repo = rawRepo.replace(/\/+$/, "") || "/";
  if (repo === "/") return true;
  if (!normalizeMachine(ctx.machine) && repo === normalizePath(home())) return true;
  return false;
}

function cleanRepoHistory(list) {
  const seen = new Set();
  return list
    .filter((item) => !isBogusStoredContext(item))
    .map((item) => ({ ...item, machine: normalizeMachine(item.machine) }))
    .filter((item) => {
      const key = repoIdentityKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function loadRepoHistory() {
  const raw = safeStorageGet(HISTORY_KEY, []);
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = cleanRepoHistory(list);
  if (JSON.stringify(cleaned) !== JSON.stringify(list)) safeStorageSet(HISTORY_KEY, cleaned);
  return cleaned;
}

export function loadActiveRepo() {
  const item = safeStorageGet(ACTIVE_REPO_KEY, null);
  if (!item || typeof item !== "object" || isBogusStoredContext(item)) {
    if (item) safeStorageSet(ACTIVE_REPO_KEY, null);
    return null;
  }
  return { ...item, machine: normalizeMachine(item.machine) };
}

export function clearActiveRepo() {
  safeStorageSet(ACTIVE_REPO_KEY, null);
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
    machine: normalizeMachine(ctx.machine),
    label: ctx.label || repoLabel(ctx),
    updatedAt: Date.now(),
  };
  safeStorageSet(ACTIVE_REPO_KEY, entry);
  const key = repoIdentityKey(entry);
  const next = [entry, ...loadRepoHistory().filter((x) => repoIdentityKey(x) !== key)].slice(0, MAX_HISTORY);
  safeStorageSet(HISTORY_KEY, next);
}

export function repoLabel(ctx) {
  if (!ctx) return "No project";
  if (ctx.name) return ctx.name;
  if (ctx.label) return ctx.label;
  const base = ctx.repo || ctx.bdDir || ctx.db || ctx.config || ctx.formulasDir || "";
  if (!base) return ctx.machine ? `Custom Project @${ctx.machine}` : "Custom Project";
  const parts = base.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || base;
}

export function contextKey(ctx) {
  if (!ctx) return "";
  return [
    normalizeMachine(ctx.machine),
    ctx.projectId || "",
    ctx.name || "",
    ctx.repo || "",
    ctx.db || "",
    ctx.bdDir || "",
    ctx.config || "",
    ctx.formulasDir || "",
    ctx.bin || "",
    ctx.env || "",
  ].join("|");
}

export function repoIdentityKey(ctx) {
  if (!ctx) return "";
  const machine = normalizeMachine(ctx.machine);
  const identity = ctx.repo || `${ctx.bdDir || ""}|${ctx.db || ""}|${ctx.config || ""}|${ctx.formulasDir || ""}`;
  return `${machine}|${identity}`;
}

function slimIssueForCache(issue) {
  if (!issue || typeof issue !== "object") return issue;
  const {
    description: _description,
    acceptance_criteria: _ac,
    notes: _notes,
    close_reason: _closeReason,
    ...rest
  } = issue;
  return rest;
}

function slimSnapshotForCache(snapshot, { maxEvents = null, maxClosed = null } = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const out = { ...snapshot };
  if (Array.isArray(snapshot.events) && maxEvents !== null && snapshot.events.length > maxEvents) {
    out.events = snapshot.events.slice(-maxEvents);
  }
  if (snapshot.bd && typeof snapshot.bd === "object") {
    const bd = { ...snapshot.bd };
    if (Array.isArray(snapshot.bd.issues)) {
      let closedCount = 0;
      const issues = [];
      for (const issue of snapshot.bd.issues) {
        if (maxClosed !== null && issue?.status === "closed") {
          if (closedCount >= maxClosed) continue;
          closedCount += 1;
        }
        issues.push(slimIssueForCache(issue));
      }
      bd.issues = issues;
    }
    out.bd = bd;
  }
  return out;
}

function isValidCachedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  return (
    typeof snapshot.schema_version === "number" ||
    Array.isArray(snapshot.tasks) ||
    (snapshot.config && typeof snapshot.config === "object")
  );
}

export function loadCachedSnapshot(ctx) {
  const key = repoIdentityKey(ctx);
  if (!key) return null;
  const entry = safeStorageGet(`${SNAPSHOT_CACHE_PREFIX}${key}`, null);
  if (!entry || typeof entry !== "object") return null;
  // Support both wrapped { v, cachedAt, snapshot } and legacy direct snapshot shapes.
  const snapshot = entry.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : entry;
  if (!isValidCachedSnapshot(snapshot)) return null;
  return {
    snapshot,
    cachedAt: typeof entry.cachedAt === "number" ? entry.cachedAt : 0,
  };
}

export function saveCachedSnapshot(ctx, snapshot) {
  const key = repoIdentityKey(ctx);
  if (!key || !isValidCachedSnapshot(snapshot)) return;
  try {
    const issues = snapshot?.bd?.issues;
    const closedCount = Array.isArray(issues)
      ? issues.reduce((count, issue) => count + (issue?.status === "closed" ? 1 : 0), 0)
      : 0;
    const shouldSlim = Array.isArray(issues) && (issues.length > 120 || closedCount > 20);
    const cachedAt = Date.now();
    let payload = {
      v: 1,
      cachedAt,
      snapshot: shouldSlim
        ? slimSnapshotForCache(snapshot, { maxEvents: 30, maxClosed: 20 })
        : slimSnapshotForCache(snapshot),
    };
    let serialized = JSON.stringify(payload);
    if (serialized.length > MAX_CACHED_SNAPSHOT_CHARS) {
      if (shouldSlim) return;
      payload = {
        v: 1,
        cachedAt,
        snapshot: slimSnapshotForCache(snapshot, { maxEvents: 30, maxClosed: 20 }),
      };
      serialized = JSON.stringify(payload);
      if (serialized.length > MAX_CACHED_SNAPSHOT_CHARS) {
        return;
      }
    }

    const rawIdx = safeStorageGet(SNAPSHOT_CACHE_INDEX_KEY, []);
    const index = Array.isArray(rawIdx) ? rawIdx.filter((k) => typeof k === "string" && k !== key) : [];
    index.unshift(key);
    while (index.length > MAX_CACHED_REPOS) {
      const evicted = index.pop();
      if (evicted) {
        try {
          localStorage.removeItem(`${SNAPSHOT_CACHE_PREFIX}${evicted}`);
        } catch {
          // Ignore storage eviction failures.
        }
      }
    }

    const cacheKey = `${SNAPSHOT_CACHE_PREFIX}${key}`;
    try {
      localStorage.setItem(cacheKey, serialized);
    } catch {
      // Evict oldest cached snapshots and retry once on quota pressure.
      while (index.length > 1) {
        const oldest = index.pop();
        if (oldest) {
          try {
            localStorage.removeItem(`${SNAPSHOT_CACHE_PREFIX}${oldest}`);
          } catch {
            // Ignore storage eviction failures.
          }
        }
        try {
          localStorage.setItem(cacheKey, serialized);
          safeStorageSet(SNAPSHOT_CACHE_INDEX_KEY, index);
          return;
        } catch {
          // Keep evicting.
        }
      }
      return;
    }
    safeStorageSet(SNAPSHOT_CACHE_INDEX_KEY, index);
  } catch {
    // Ignore storage failures during headless check or restricted contexts.
  }
}

function parentDir(dir) {
  const clean = dir.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return clean.slice(0, idx);
}

function normalizePath(p, machine = "") {
  if (!p) return "";
  if (!machine && p.startsWith("~/")) return `${home()}${p.slice(1)}`;
  return p.replace(/\/+$/, "") || "/";
}

export function projectsConfigPath() {
  return `${normalizePath(home())}/.config/roscaelifer/projects.json`;
}

function projectBasename(project) {
  const base = project?.repo || project?.bdDir || project?.db || project?.config || project?.formulasDir || "";
  const parts = String(base).replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "Project";
}

function projectIdBase(name) {
  const id = String(name || "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "project";
}

function normalizeProject(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const fields = {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `project-${index + 1}`,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : projectBasename(raw),
    repo: typeof raw.repo === "string" ? raw.repo.trim() : "",
    machine: normalizeMachine(raw.machine),
    db: typeof raw.db === "string" ? raw.db.trim() : "",
    bdDir: typeof raw.bdDir === "string" ? raw.bdDir.trim() : "",
    config: typeof raw.config === "string" ? raw.config.trim() : "",
    formulasDir: typeof raw.formulasDir === "string" ? raw.formulasDir.trim() : "",
    bin: typeof raw.bin === "string" ? raw.bin.trim() : "",
    env: typeof raw.env === "string" ? raw.env.trim() : "",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
  if (!fields.repo && !fields.db && !fields.bdDir && !fields.config && !fields.formulasDir) return null;
  return fields;
}

function projectFromLegacyContext(ctx, index = 0) {
  const normalized = normalizeProject({
    ...ctx,
    name: ctx?.name || ctx?.label || projectBasename(ctx),
    id: ctx?.id || projectIdBase(ctx?.name || ctx?.label || projectBasename(ctx)),
  }, index);
  return normalized;
}

function migrateLegacyProjects() {
  const history = loadRepoHistory();
  const active = loadActiveRepo();
  const entries = [];
  if (active) entries.push(active);
  entries.push(...history);
  const projects = [];
  const usedIds = new Set();
  for (const entry of entries) {
    const project = projectFromLegacyContext(entry, projects.length);
    if (!project) continue;
    const baseId = projectIdBase(project.name);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    project.id = id;
    usedIds.add(id);
    if (projects.some((item) => repoIdentityKey(item) === repoIdentityKey(project))) continue;
    projects.push(project);
  }
  const activeProject = active
    ? projects.find((project) => repoIdentityKey(project) === repoIdentityKey(active))?.id || ""
    : "";
  return { version: PROJECTS_CONFIG_VERSION, activeProject, projects };
}

function emptyProjectsConfig() {
  return { version: PROJECTS_CONFIG_VERSION, activeProject: "", projects: [] };
}

export async function loadGlobalProjectsConfig() {
  let raw;
  try {
    raw = await readTextFile(projectsConfigPath());
  } catch {
    raw = null;
  }
  if (raw === null || raw === undefined) {
    const migrated = migrateLegacyProjects();
    const active = migrated.projects.find((project) => project.id === migrated.activeProject);
    if (active) saveActiveProjectMirror(active);
    else clearActiveProjectMirror();
    return migrated;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== PROJECTS_CONFIG_VERSION || !Array.isArray(parsed.projects)) {
      clearActiveProjectMirror();
      return emptyProjectsConfig();
    }
    const projects = parsed.projects.map(normalizeProject).filter(Boolean);
    const activeProject = typeof parsed.activeProject === "string" && projects.some((project) => project.id === parsed.activeProject)
      ? parsed.activeProject
      : "";
    const config = { version: PROJECTS_CONFIG_VERSION, activeProject, projects };
    const active = projects.find((project) => project.id === activeProject);
    if (active) saveActiveProjectMirror(active);
    else clearActiveProjectMirror();
    return config;
  } catch {
    clearActiveProjectMirror();
    return emptyProjectsConfig();
  }
}

export async function saveGlobalProjectsConfig(config) {
  if (checking()) return config;
  const normalized = {
    version: PROJECTS_CONFIG_VERSION,
    activeProject: typeof config?.activeProject === "string" ? config.activeProject : "",
    projects: Array.isArray(config?.projects) ? config.projects.map(normalizeProject).filter(Boolean) : [],
  };
  const jsonText = JSON.stringify(normalized, null, 2);
  const script = 'mkdir -p "$(dirname "$1")" && tmp=$(mktemp "${1}.tmp.XXXXXX") && printf \'%s\\n\' "$2" > "$tmp" && mv -f "$tmp" "$1"';
  const result = await exec("sh", ["-c", script, "roscaelifer-save-projects", projectsConfigPath(), jsonText]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Unable to save projects.json").trim());
  return normalized;
}

export function saveActiveProjectMirror(project) {
  if (!project) {
    safeStorageSet(ACTIVE_PROJECT_KEY, null);
    return;
  }
  safeStorageSet(ACTIVE_PROJECT_KEY, { ...project, projectId: project.id });
}

export function loadActiveProjectMirror() {
  const mirror = safeStorageGet(ACTIVE_PROJECT_KEY, null);
  return mirror && typeof mirror === "object" ? mirror : null;
}

export function clearActiveProjectMirror() {
  safeStorageSet(ACTIVE_PROJECT_KEY, null);
}

export async function upsertGlobalProject(projectInput, editingProjectId = null) {
  const config = await loadGlobalProjectsConfig();
  const project = normalizeProject({ ...projectInput, id: editingProjectId || projectInput?.id || "project" });
  if (!project) throw new Error("Project Name is required, and at least one project path is required.");
  const existingIndex = editingProjectId ? config.projects.findIndex((item) => item.id === editingProjectId) : -1;
  if (existingIndex >= 0) {
    project.id = editingProjectId;
    config.projects[existingIndex] = project;
  } else {
    const usedIds = new Set(config.projects.map((item) => item.id));
    const baseId = projectIdBase(project.name);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    project.id = id;
    config.projects.unshift(project);
  }
  config.activeProject = project.id;
  const saved = await saveGlobalProjectsConfig(config);
  saveActiveProjectMirror(project);
  return { config: saved, project };
}

export async function deleteGlobalProject(projectId) {
  const config = await loadGlobalProjectsConfig();
  const removed = config.projects.find((project) => project.id === projectId) || null;
  const wasActive = config.activeProject === projectId;
  config.projects = config.projects.filter((project) => project.id !== projectId);
  if (wasActive) config.activeProject = "";
  const saved = await saveGlobalProjectsConfig(config);
  if (saved.activeProject) {
    saveActiveProjectMirror(saved.projects.find((project) => project.id === saved.activeProject));
  } else {
    clearActiveProjectMirror();
  }
  return { config: saved, removed, wasActive };
}

export async function detectCurrentWorkspaceProject({ focusedInfo = focused(), spaceList = spaces(), paneList = panes() } = {}) {
  const activeSpace = (spaceList || []).find((space) => space.active);
  const candidates = [];
  if (focusedInfo?.cwd) candidates.push({ cwd: focusedInfo.cwd, machine: normalizeMachine(activeSpace?.machine) });
  if (activeSpace?.folder) candidates.push({ cwd: activeSpace.folder, machine: normalizeMachine(activeSpace.machine) });
  const tabToMachine = new Map();
  for (const space of spaceList || []) {
    const tabs = Array.isArray(space?.tabs) ? space.tabs : space?.tab ? [space.tab] : [];
    for (const tab of tabs) {
      const id = typeof tab === "object" ? tab?.id || tab?.tab : tab;
      if (id !== undefined && id !== null) tabToMachine.set(String(id), normalizeMachine(space.machine));
    }
  }
  for (const pane of paneList || []) {
    if (pane?.cwd) candidates.push({ cwd: pane.cwd, machine: normalizeMachine(pane.machine) || tabToMachine.get(String(pane.tab)) || "" });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const clean = normalizePath(candidate.cwd, candidate.machine);
    const key = `${candidate.machine}|${clean}`;
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    const found = await detectRepoFromPath(clean, candidate.machine);
    if (found) return found;
  }
  return null;
}

async function pathExists(p) {
  try {
    return await fs.exists(p);
  } catch {
    return false;
  }
}

async function probeBeadsDirArtifacts(beadsDir) {
  if (!beadsDir) return false;
  const clean = String(beadsDir).replace(/\/+$/, "");
  if (!clean) return false;
  const checks = await Promise.all(BEADS_ARTIFACTS.map((name) => pathExists(`${clean}/${name}`)));
  return checks.some(Boolean);
}

async function probeBeadsArtifacts(dir) {
  return probeBeadsDirArtifacts(`${dir}/.beads`);
}

export async function hasLiveBeadsDir(ctx) {
  const bdDir = typeof ctx?.bdDir === "string" ? ctx.bdDir.trim() : "";
  if (!bdDir) return false;
  if (normalizeMachine(ctx?.machine)) return true;
  return probeBeadsDirArtifacts(bdDir);
}

function parseRemoteProbe(stdout) {
  const lines = String(stdout || "").trim().split("\n");
  if (lines.length < 7) return null;
  return {
    clean: lines[0],
    hasRosc: lines[1] === "1",
    hasDb: lines[2] === "1",
    hasBeads: lines[3] === "1",
    hasToml: lines[4] === "1",
    hasFormulas: lines[5] === "1",
    source: lines[6] || "detected",
  };
}

function buildDetectedRepo(probe, machine = "") {
  if (!probe) return null;
  const { clean: repo, hasRosc, hasDb, hasBeads, hasToml, hasFormulas, source } = probe;
  if (!hasRosc && !hasDb && !hasBeads && !hasToml) return null;
  return {
    repo,
    db: hasDb || hasRosc ? `${repo}/.roscaelifer/roscaelifer.db` : "",
    bdDir: hasBeads ? `${repo}/.beads` : "",
    config: hasToml ? `${repo}/roscaelifer.toml` : "",
    formulasDir: hasFormulas ? `${repo}/formulas` : "",
    machine: normalizeMachine(machine),
    hasBeads,
    label: repo.split("/").filter(Boolean).pop() || repo,
    source: source || "detected",
  };
}

async function probeLocalRepoRoot(dir) {
  const clean = normalizePath(dir, "");
  if (!clean) return null;
  const userHome = normalizePath(home());
  if (clean === "/" || clean === userHome) return null;
  const [hasRosc, hasDb, hasBeads, hasToml, hasFormulas] = await Promise.all([
    pathExists(`${clean}/.roscaelifer`),
    pathExists(`${clean}/.roscaelifer/roscaelifer.db`),
    probeBeadsArtifacts(clean),
    pathExists(`${clean}/roscaelifer.toml`),
    pathExists(`${clean}/formulas`),
  ]);
  return buildDetectedRepo({ clean, hasRosc, hasDb, hasBeads, hasToml, hasFormulas, source: "detected" }, "");
}

const REMOTE_DETECT_SCRIPT = `
start=$1
case "$start" in
  "~") start="$HOME" ;;
  "~"/*) start="$HOME/\${start#"~/"}" ;;
esac
start=\${start%/}
[ -z "$start" ] && start="/"
home_clean=\${HOME%/}

probe_dir() {
  d=$1
  src=$2
  [ -z "$d" ] && return 1
  if [ "$d" = "/" ] || { [ -n "$home_clean" ] && [ "$d" = "$home_clean" ]; }; then
    return 1
  fi
  has_rosc=0; [ -e "$d/.roscaelifer" ] && has_rosc=1
  has_db=0; [ -e "$d/.roscaelifer/roscaelifer.db" ] && has_db=1
  has_beads=0
  for marker in ${BEADS_ARTIFACTS.map((name) => `"$d/.beads/${name}"`).join(" ")}; do
    if [ -e "$marker" ]; then has_beads=1; break; fi
  done
  has_toml=0; [ -e "$d/roscaelifer.toml" ] && has_toml=1
  has_formulas=0; [ -e "$d/formulas" ] && has_formulas=1
  if [ "$has_rosc" = "1" ] || [ "$has_db" = "1" ] || [ "$has_beads" = "1" ] || [ "$has_toml" = "1" ]; then
    printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "$d" "$has_rosc" "$has_db" "$has_beads" "$has_toml" "$has_formulas" "$src"
    return 0
  fi
  return 1
}

cur=$start
i=0
while [ "$i" -lt 12 ] && [ -n "$cur" ]; do
  if [ "$cur" = "/" ] || { [ -n "$home_clean" ] && [ "$cur" = "$home_clean" ]; }; then
    break
  fi
  if probe_dir "$cur" "detected"; then
    exit 0
  fi
  next=\${cur%/*}
  [ -z "$next" ] && next="/"
  if [ "$next" = "$cur" ]; then
    break
  fi
  cur=$next
  i=$((i + 1))
done

if [ -d "$start" ] && command -v git >/dev/null 2>&1; then
  common=$(cd "$start" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  case "$common" in
    */.git)
      main_repo=\${common%/.git}
      if [ -n "$main_repo" ] && probe_dir "$main_repo" "git-common-dir"; then
        exit 0
      fi
      ;;
  esac
fi
exit 1
`;

export async function detectRepoFromPath(startPath, machine = "") {
  const owner = normalizeMachine(machine);
  let cur = normalizePath(startPath, owner);
  if (!cur) return null;

  if (owner) {
    try {
      const res = await exec("sh", ["-c", REMOTE_DETECT_SCRIPT, "roscaelifer-detect", cur], {
        on: owner,
        timeout: 6000,
      });
      if (res.code !== 0) return null;
      return buildDetectedRepo(parseRemoteProbe(res.stdout), owner);
    } catch {
      return null;
    }
  }

  const userHome = normalizePath(home());
  for (let i = 0; i < 12 && cur; i++) {
    if (cur === "/" || cur === userHome) break;
    const found = await probeLocalRepoRoot(cur);
    if (found) return found;
    const next = parentDir(cur);
    if (!next || next === cur) break;
    cur = next;
  }

  // Linked git worktrees store .beads / .roscaelifer in the main checkout.
  try {
    const res = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: normalizePath(startPath, ""),
      timeout: 3000,
    });
    if (res.code === 0) {
      const common = res.stdout.trim();
      const mainRepo = common.endsWith("/.git") ? common.slice(0, -5) : "";
      if (mainRepo) {
        const found = await probeLocalRepoRoot(mainRepo);
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
  const machine = normalizeMachine(src.machine ?? rawProps?.machine);
  const repo = normalizePath(src.repo || "", machine);
  const db = src.db ? normalizePath(src.db, machine) : repo ? `${repo}/.roscaelifer/roscaelifer.db` : "";
  const bdDir = src.bdDir ? normalizePath(src.bdDir, machine) : repo ? `${repo}/.beads` : "";
  const config = src.config ? normalizePath(src.config, machine) : repo ? `${repo}/roscaelifer.toml` : "";
  const formulasDir = src.formulasDir ? normalizePath(src.formulasDir, machine) : repo ? `${repo}/formulas` : "";
  if (!repo && !db && !bdDir && !config && !formulasDir) return null;
  const ctx = {
    repo,
    db,
    bdDir,
    config,
    formulasDir,
    machine,
    bin: src.bin ?? rawProps?.bin ?? "",
    env: src.env ?? rawProps?.env ?? "",
    name: src.name || "",
    projectId: src.projectId || src.id || "",
    label: src.label || "",
    source: src.source || (overrideCtx ? "override" : "props"),
  };
  ctx.label = repoLabel(ctx);
  return ctx;
}

export async function resolveContext(rawProps, { focusedInfo, spaceList, paneList, sharedOverride } = {}) {
  const isAutoDetectSignal = Boolean(sharedOverride && sharedOverride.__autoDetect);

  // projects.json is the authoritative source: an explicit activeProject wins over any
  // stale shared.json override left behind by a previous session.
  const projectsConfig = await loadGlobalProjectsConfig();
  const activeProject = projectsConfig.projects.find((project) => project.id === projectsConfig.activeProject);
  if (activeProject) {
    saveActiveProjectMirror(activeProject);
    return buildContextFromProps(rawProps, { ...activeProject, source: "project", projectId: activeProject.id });
  }

  if (!isAutoDetectSignal) {
    const fromOverride = buildContextFromProps(rawProps, sharedOverride);
    if (fromOverride) return fromOverride;
  }

  const fromProps = buildContextFromProps(rawProps, null);
  if (fromProps) return fromProps;

  const detected = await detectCurrentWorkspaceProject({ focusedInfo, spaceList, paneList });
  if (detected) {
    if (rawProps?.bin) detected.bin = rawProps.bin;
    if (rawProps?.env) detected.env = rawProps.env;
    detected.name = repoLabel(detected);
    return detected;
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellPart(value) {
  const text = String(value);
  if (text.startsWith("$HOME/")) {
    const suffix = text.slice("$HOME".length).replace(/["\\$`]/g, "\\$&");
    return `"$HOME${suffix}"`;
  }
  if (text === "~" || text.startsWith("~/")) {
    const suffix = text.slice(1).replace(/["\\$`]/g, "\\$&");
    return `"$HOME${suffix}"`;
  }
  return shellQuote(text);
}

const BINARY_CACHE = new Map();
const BINARY_INFLIGHT = new Map();

const REMOTE_BINARY_PROBE_SCRIPT = `
for cand in "$@"; do
  resolved=$cand
  case "$resolved" in
    "\\$HOME/"*) resolved="$HOME/\${resolved#\\$HOME/}" ;;
    "~/") resolved="$HOME/" ;;
    "~/"*) resolved="$HOME/\${resolved#~/}" ;;
  esac
  if out=$("$resolved" snapshot --help 2>&1); then
    printf '__ROSCAELIFER_BIN__=%s\\n%s\\n' "$cand" "$out"
    exit 0
  fi
done
exit 1
`;

function detectSnapshotFlags(stdout, stderr) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  return {
    supportsCompact: /(?:^|[\s\[,|])--?compact(?:[\s\]=,|]|$)/m.test(text),
    supportsBrief: /(?:^|[\s\[,|])--?brief(?:[\s\]=,|]|$)/m.test(text),
    supportsIncludeEphemeral: /(?:^|[\s\[,|])--?include-ephemeral(?:[\s\]=,|]|$)/m.test(text),
    supportsAllClosed: /(?:^|[\s\[,|])--?all-closed(?:[\s\]=,|]|$)/m.test(text),
  };
}

function binaryCacheKey(ctx) {
  const machine = normalizeMachine(ctx?.machine);
  const rawBin = typeof ctx?.bin === "string" ? ctx.bin.trim() : "";
  const binHint = rawBin ? (machine ? rawBin : normalizePath(rawBin)) : "";
  return `${machine}|${binHint}`;
}

export function invalidateBinaryCache(ctx) {
  BINARY_CACHE.delete(binaryCacheKey(ctx));
}

function isCommandNotFoundFailure(errOrRes) {
  if (!errOrRes) return false;
  if (typeof errOrRes === "object" && "code" in errOrRes && errOrRes.code === 127) {
    return true;
  }
  const msg = String(
    errOrRes?.message || errOrRes?.stderr || errOrRes?.stdout || errOrRes || "",
  ).toLowerCase();
  return (
    msg.includes("enoent") ||
    msg.includes("command not found") ||
    msg.includes("no such file or directory") ||
    msg.includes("exited 127")
  );
}

async function probeBinary(ctx) {
  const machine = normalizeMachine(ctx?.machine);
  if (machine) {
    const candidates = [
      ctx?.bin,
      "roscaelifer",
      "$HOME/.local/bin/roscaelifer",
      "$HOME/go/bin/roscaelifer",
      "/opt/homebrew/bin/roscaelifer",
      "/usr/local/bin/roscaelifer",
    ].filter(Boolean);
    try {
      const res = await exec(
        "sh",
        ["-lc", REMOTE_BINARY_PROBE_SCRIPT, "roscaelifer-bin-probe", ...candidates],
        { on: machine, timeout: 6000 },
      );
      if (res.code === 0) {
        const text = String(res.stdout || "");
        const nl = text.indexOf("\n");
        const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
        const helpText = nl >= 0 ? text.slice(nl + 1) : "";
        if (firstLine.startsWith("__ROSCAELIFER_BIN__=")) {
          const bin = firstLine.slice("__ROSCAELIFER_BIN__=".length);
          const shellHomeRel = bin.startsWith("$HOME/") ? bin.slice("$HOME/".length) : "";
          return {
            cmd: bin,
            prefixArgs: [],
            shellHomeRel,
            label: bin,
            ...detectSnapshotFlags(helpText, res.stderr),
          };
        }
      }
    } catch {
      // Fall through to not found error.
    }
    throw new Error(`roscaelifer binary not found on machine ${machine}`);
  }

  const userHome = normalizePath(home());
  const candidates = [
    ctx?.bin ? normalizePath(ctx.bin) : "",
    "roscaelifer",
    `${userHome}/.local/bin/roscaelifer`,
    `${userHome}/go/bin/roscaelifer`,
    "/opt/homebrew/bin/roscaelifer",
    "/usr/local/bin/roscaelifer",
  ];

  for (const bin of candidates) {
    if (!bin) continue;
    try {
      // Probe with the snapshot subcommand so legacy roscaelifer builds that
      // lack it are not selected, and inspect --help for --compact / --brief.
      const res = await exec(bin, ["snapshot", "--help"], { timeout: 4000 });
      if (res.code === 0) {
        return {
          cmd: bin,
          prefixArgs: [],
          label: bin,
          ...detectSnapshotFlags(res.stdout, res.stderr),
        };
      }
    } catch {
      // Try next candidate.
    }
  }

  if (ctx?.repo && (await pathExists(`${ctx.repo}/cmd/roscaelifer/main.go`))) {
    try {
      const goCheck = await exec("go", ["version"], { timeout: 3000 });
      if (goCheck.code === 0) {
        let flags = { supportsCompact: false, supportsBrief: false };
        try {
          const helpRes = await exec("go", ["run", "./cmd/roscaelifer", "snapshot", "--help"], {
            cwd: ctx.repo,
            timeout: 8000,
          });
          if (helpRes.code === 0) {
            flags = detectSnapshotFlags(helpRes.stdout, helpRes.stderr);
          }
        } catch {
          // Keep default false flags if help probe fails.
        }
        return {
          cmd: "go",
          prefixArgs: ["run", "./cmd/roscaelifer"],
          label: "go run ./cmd/roscaelifer",
          isGoFallback: true,
          repo: ctx.repo,
          ...flags,
        };
      }
    } catch {
      // No go fallback available.
    }
  }

  throw new Error(
    "roscaelifer binary not found in props().bin, PATH, ~/.local/bin/roscaelifer, or ~/go/bin/roscaelifer",
  );
}

export async function resolveBinary(ctx, { force = false } = {}) {
  const key = binaryCacheKey(ctx);
  if (!force && BINARY_CACHE.has(key)) {
    const cached = BINARY_CACHE.get(key);
    if (!cached.isGoFallback || cached.repo === (ctx?.repo || "")) {
      return cached;
    }
  }

  if (!force && BINARY_INFLIGHT.has(key)) {
    return BINARY_INFLIGHT.get(key);
  }

  const promise = probeBinary(ctx)
    .then((runner) => {
      BINARY_CACHE.set(key, runner);
      return runner;
    })
    .finally(() => {
      if (BINARY_INFLIGHT.get(key) === promise) {
        BINARY_INFLIGHT.delete(key);
      }
    });

  BINARY_INFLIGHT.set(key, promise);
  return promise;
}

export async function execRoscaelifer(ctx, runner, args, opts = {}) {
  const resolved = runner || (await resolveBinary(ctx));
  const fullArgs = [...(resolved.prefixArgs || []), ...args];
  const cwd = ctx?.repo || undefined;
  const timeout = opts.timeout ?? 30000;
  const machine = normalizeMachine(ctx?.machine);
  try {
    let res;
    if (machine) {
      const command = resolved.shellHomeRel ? `$HOME/${resolved.shellHomeRel}` : resolved.cmd;
      const commandLine = [command, ...fullArgs].map(shellPart).join(" ");
      const remoteCwd = cwd?.startsWith("~");
      const remoteCommand = remoteCwd ? `cd ${shellPart(cwd)} && ${commandLine}` : commandLine;
      res = await exec("sh", ["-lc", remoteCommand], {
        ...(!remoteCwd && cwd ? { cwd } : {}),
        on: machine,
        timeout,
      });
    } else {
      res = await exec(resolved.cmd, fullArgs, { ...(cwd ? { cwd } : {}), timeout });
    }
    if (res && isCommandNotFoundFailure(res)) {
      invalidateBinaryCache(ctx);
    }
    return res;
  } catch (err) {
    if (isCommandNotFoundFailure(err)) {
      invalidateBinaryCache(ctx);
    }
    throw err;
  }
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
  const resolved = runner || (await resolveBinary(ctx));
  const bdActive =
    opts.bd === true ? true : opts.bd === false ? false : await hasLiveBeadsDir(ctx);
  const args = ["snapshot", "--json"];
  if (resolved?.supportsCompact) args.push("--compact");
  if (resolved?.supportsBrief) args.push("--brief");
  if (
    bdActive &&
    (opts.includeEphemeral || opts.includeWip !== false) &&
    resolved?.supportsIncludeEphemeral
  ) {
    args.push("--include-ephemeral");
  }
  if (ctx?.db) args.push("--db", ctx.db);
  if (ctx?.config) args.push("--config", ctx.config);
  if (ctx?.formulasDir) args.push("--formulas-dir", ctx.formulasDir);
  if (bdActive) {
    args.push("--bd");
    if (ctx?.bdDir) args.push("--bd-dir", ctx.bdDir);
  }
  if (opts.eventsLimit) args.push("--events-limit", String(opts.eventsLimit));
  if (opts.closedLimit === "all") {
    if (resolved?.supportsAllClosed) {
      args.push("--all-closed");
    } else {
      args.push("--closed-limit", "50000");
    }
  } else if (Number.isInteger(opts.closedLimit) && opts.closedLimit > 0) {
    args.push("--closed-limit", String(opts.closedLimit));
  }

  let res;
  try {
    res = await execRoscaelifer(ctx, resolved, args, { timeout: opts.timeout ?? 25000 });
  } catch (err) {
    if (!opts._retried && isCommandNotFoundFailure(err)) {
      invalidateBinaryCache(ctx);
      const freshRunner = await resolveBinary(ctx, { force: true });
      opts.onRunnerResolved?.(freshRunner);
      return fetchSnapshot(ctx, freshRunner, { ...opts, _retried: true });
    }
    throw err;
  }
  if (res.code !== 0) {
    const errText = (res.stderr || res.stdout || `snapshot exited ${res.code}`).trim();
    const flagRejected =
      (resolved?.supportsCompact || resolved?.supportsBrief || resolved?.supportsIncludeEphemeral || resolved?.supportsAllClosed) &&
      /flag provided but not defined/i.test(errText);
    if (flagRejected) {
      if (resolved?.supportsCompact) resolved.supportsCompact = false;
      if (resolved?.supportsBrief) resolved.supportsBrief = false;
      if (resolved?.supportsIncludeEphemeral) resolved.supportsIncludeEphemeral = false;
      if (resolved?.supportsAllClosed) resolved.supportsAllClosed = false;
    }
    if (!opts._retried && (isCommandNotFoundFailure(res) || flagRejected)) {
      invalidateBinaryCache(ctx);
      const freshRunner = await resolveBinary(ctx, { force: true });
      opts.onRunnerResolved?.(freshRunner);
      return fetchSnapshot(ctx, freshRunner, { ...opts, _retried: true });
    }
    throw new Error(errText);
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

function parseBdJsonOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  const parse = (text) => {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] || null : parsed;
  };
  try {
    return parse(trimmed);
  } catch {
    const arrStart = trimmed.indexOf("[");
    const objStart = trimmed.indexOf("{");
    const start =
      arrStart >= 0 && objStart >= 0
        ? Math.min(arrStart, objStart)
        : Math.max(arrStart, objStart);
    if (start > 0) {
      const end = trimmed[start] === "[" ? trimmed.lastIndexOf("]") : trimmed.lastIndexOf("}");
      if (end > start) {
        return parse(trimmed.slice(start, end + 1));
      }
    }
    throw new Error("Unexpected bd show --json output format");
  }
}

function isBdShowUnsupported(errOrRes) {
  const text = [errOrRes?.message, errOrRes?.stderr, errOrRes?.stdout, errOrRes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /unknown command[：: ]+["']?bd-show\b/.test(text) ||
    /unknown command.*\bbd-show\b/.test(text);
}

export async function fetchBeadDetail(ctx, runner, beadId, opts = {}) {
  if (!beadId) return null;
  const resolved = runner || (await resolveBinary(ctx));
  const bdFlags = [];
  if (ctx?.bdDir) bdFlags.push("--bd-dir", ctx.bdDir);
  if (ctx?.bdActor) bdFlags.push("--bd-actor", ctx.bdActor);

  let res;
  if (resolved?.supportsBdShow !== false) {
    const args = ["bd-show", "--json", ...bdFlags];
    if (opts.includeEphemeral && resolved?.supportsBdShowIncludeEphemeral !== false) {
      args.push("--include-ephemeral");
    }
    args.push(String(beadId));
    try {
      res = await execRoscaelifer(ctx, resolved, args, { timeout: 15000 });
    } catch (err) {
      const flagRejected =
        opts.includeEphemeral && /flag provided but not defined/i.test(String(err?.message || err));
      if (!isBdShowUnsupported(err) && !flagRejected) throw err;
      if (flagRejected) resolved.supportsBdShowIncludeEphemeral = false;
      if (isBdShowUnsupported(err)) resolved.supportsBdShow = false;
    }
    if (res && res.code !== 0) {
      const flagRejected =
        opts.includeEphemeral && /flag provided but not defined/i.test(res.stderr || res.stdout || "");
      if (!isBdShowUnsupported(res) && !flagRejected) {
        throw new Error((res.stderr || res.stdout || `bd-show ${beadId} exited ${res.code}`).trim());
      }
      if (flagRejected) resolved.supportsBdShowIncludeEphemeral = false;
      if (isBdShowUnsupported(res)) resolved.supportsBdShow = false;
    }
  }

  if (!res || res.code !== 0) {
    const args = ["bd-exec", ...bdFlags, "--", "show", "--json", String(beadId)];
    res = await execRoscaelifer(ctx, resolved, args, { timeout: 15000 });
    if (res.code !== 0) {
      throw new Error((res.stderr || res.stdout || `bd show ${beadId} exited ${res.code}`).trim());
    }
  }
  try {
    return parseBdJsonOutput(res.stdout);
  } catch (err) {
    throw new Error(`Invalid bd show JSON: ${err}`);
  }
}

function stripTaskMetaPrefix(val) {
  if (!val) return "";
  const s = String(val).trim();
  return s.startsWith("task:") ? s.slice(5) : s;
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

// A real Herdr terminal address never starts with "worktree-"; those values are
// worktree placeholders written into pane_id/hc_address and must not be treated
// as attachable terminals.
function isTerminalAddress(addr) {
  if (typeof addr !== "string") return false;
  const value = addr.trim();
  return value.length > 0 && !value.startsWith("worktree-");
}

function normalizeAddress(addr, envObj) {
  if (!addr) return [];
  const value = String(addr);
  const out = [value];
  const machine = envObj?.machine;
  if (machine && !value.includes("/")) out.push(`${machine}/${value}`);
  if (value.includes("/")) out.push(value.split("/").slice(1).join("/"));
  return [...new Set(out.filter(Boolean))];
}

function addAddressIndex(index, address, value, machine = "") {
  for (const candidate of normalizeAddress(address, { machine })) {
    if (!index.has(candidate)) index.set(candidate, value);
  }
}

function spaceTabInfo(spaces, tabId) {
  if (tabId === undefined || tabId === null) return null;
  const wanted = String(tabId);
  for (const space of spaces || []) {
    const tabs = Array.isArray(space?.tabs) ? space.tabs : space?.tab ? [space.tab] : [];
    for (const rawTab of tabs) {
      const tab = rawTab && typeof rawTab === "object" ? rawTab : { id: rawTab };
      if (String(tab.id ?? tab.tab ?? "") !== wanted) continue;
      return { space, tab };
    }
  }
  return null;
}

function buildHerdrLookup(agents = [], terminals = [], spaces = [], panes = []) {
  const agentByAddr = new Map();
  for (const agent of agents || []) {
    if (agent?.address) addAddressIndex(agentByAddr, agent.address, agent, agent.machine);
  }
  const termByAddr = new Map();
  for (const terminal of terminals || []) {
    if (terminal?.address) addAddressIndex(termByAddr, terminal.address, terminal, terminal.machine);
  }
  const paneByAddr = new Map();
  for (const pane of panes || []) {
    const address = pane?.terminal || pane?.address || pane?.hc_address;
    if (address) addAddressIndex(paneByAddr, address, pane, pane.machine);
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
    findPane(hcAddress, envObj) {
      for (const candidate of normalizeAddress(hcAddress, envObj)) {
        if (paneByAddr.has(candidate)) return paneByAddr.get(candidate);
      }
      return null;
    },
    findSpaceTab(tabId) {
      return spaceTabInfo(spaces, tabId);
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
    const attemptAddress = attempt?.hc_address;
    const threadAddress = parseHcAddressFromThread(attempt?.thread_id);
    const hcAddress =
      (isTerminalAddress(attemptAddress) ? String(attemptAddress).trim() : null) ||
      (isTerminalAddress(threadAddress) ? String(threadAddress).trim() : null) ||
      null;
    const liveAgent = hcAddress ? lookup.findAgent(hcAddress, envObj) : null;
    const liveTerminal = hcAddress ? lookup.findTerminal(hcAddress, envObj) : null;
    const livePane = hcAddress ? lookup.findPane(hcAddress, envObj) : null;
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
      livePane,
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

export function normalizeQueue(snapshot, { agents = [], terminals = [], spaces = [], panes = [] } = {}) {
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
  if (defaultEnv !== "auto" && !envsByName.has(defaultEnv)) {
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
  const lookup = buildHerdrLookup(agents, terminals, spaces, panes);

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
    const labels = Array.isArray(issue?.labels) ? issue.labels : [];
    let envLabel = null;
    let formulaLabel = null;
    let isOptedIn = false;
    let hasWipLabel = false;
    let needsReview = false;
    let hasFailedLabel = false;
    let isCancelledLabel = false;
    let isInvalidLabel = false;
    for (const label of labels) {
      if (typeof label !== "string") continue;
      if (label.startsWith("env:") && envLabel === null) envLabel = label.slice(4);
      if (label.startsWith("formula:") && formulaLabel === null) formulaLabel = label.slice(8);
      if (label === "roscaelifer") isOptedIn = true;
      if (label === "wip") hasWipLabel = true;
      if (label === "roscaelifer-review") needsReview = true;
      if (label === "roscaelifer-failed") hasFailedLabel = true;
      if (label === "roscaelifer-cancelled") {
        hasFailedLabel = true;
        isCancelledLabel = true;
      }
      if (label === "roscaelifer-invalid") {
        hasFailedLabel = true;
        isInvalidLabel = true;
      }
    }
    const intakePlan = beadId ? intakeByBead.get(beadId) || null : null;

    const rawEnv =
      task?.resolved_env ||
      intakePlan?.env ||
      envLabel ||
      defaultEnv;
    // `auto` means "no concrete env yet": either the config leaves placement to the
    // scheduler, or the task has not been locked to a resolved_env. Such items must
    // not claim an env chip or an env that does not exist in config.envs.
    const envPendingAuto = rawEnv === "auto";
    const envName = envPendingAuto ? null : rawEnv;
    const envObj = envName ? envsByName.get(envName) || null : null;
    const formula =
      task?.formula_name ||
      intakePlan?.formula ||
      formulaLabel ||
      null;
    const isWip =
      hasWipLabel ||
      (!issue && typeof formula === "string" && formula.startsWith("worker-"));
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

    const liveStep = steps.find((step) => step.liveAgent || step.liveTerminal || step.livePane) || null;
    const sessionStep = liveStep || currentStep || [...steps].reverse().find((step) => step.hcAddress) || null;
    let hcAddress = sessionStep?.hcAddress || null;
    if (!hcAddress && taskPendingCleanups.length > 0) {
      const candidate = taskPendingCleanups[0].hc_address || taskPendingCleanups[0].pane_id || null;
      hcAddress = isTerminalAddress(candidate) ? String(candidate).trim() : null;
    }
    if (!hcAddress && sidecars.length > 0) {
      const candidate = sidecars[0].pane_id || null;
      hcAddress = isTerminalAddress(candidate) ? String(candidate).trim() : null;
    }

    const liveAgent =
      sessionStep?.liveAgent ||
      (hcAddress ? lookup.findAgent(hcAddress, envObj) : null);
    const liveTerminal =
      sessionStep?.liveTerminal ||
      (hcAddress ? lookup.findTerminal(hcAddress, envObj) : null);
    const livePane =
      sessionStep?.livePane ||
      (hcAddress ? lookup.findPane(hcAddress, envObj) : null);
    const canonicalAddress = liveAgent?.address || liveTerminal?.address || livePane?.terminal || hcAddress || null;
    const tabInfo = lookup.findSpaceTab(liveAgent?.tab || livePane?.tab);
    const sessionInfo = canonicalAddress
      ? {
          terminal: canonicalAddress,
          spaceId: liveAgent?.space || tabInfo?.space?.id || null,
          spaceName: tabInfo?.space?.name || tabInfo?.space?.label || null,
          tabId: liveAgent?.tab || livePane?.tab || tabInfo?.tab?.id || null,
          tabName: tabInfo?.tab?.name || tabInfo?.tab?.title || tabInfo?.tab?.label || null,
          paneId: livePane?.pane || livePane?.id || null,
          hasAgent: Boolean(liveAgent),
          hasPane: Boolean(livePane || liveAgent?.pane),
          isLive: Boolean(liveAgent || liveTerminal || livePane),
          machine: envObj?.machine || null,
          envSpace: envObj?.space || null,
        }
      : null;
    const agentStatus =
      sessionStep?.agentStatus || resolveLiveStatus(liveAgent, liveTerminal);

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
    const isReady = beadId ? readySet.has(beadId) : false;

    const blockedBy = [];
    for (const dep of issue?.dependencies || []) {
      if (parseDepType(dep) !== "blocks") continue;
      const target = parseDepTarget(dep);
      if (target) blockedBy.push(target);
    }
    const isBlocked =
      bdStatus === "closed"
        ? false
        : blockedBy.some((depId) => {
            const target = issueMap.get(depId);
            return target ? target.status !== "closed" : true;
          });
    const beadColumn =
      !beadId
        ? null
        : bdStatus === "closed"
          ? "closed"
          : bdStatus === "deferred" || bdStatus === "backlog"
            ? "backlog"
            : bdStatus === "in_progress"
              ? "in_progress"
              : bdStatus === "blocked" || isBlocked
                ? "blocked"
                : "ready";

    const waitingApprovalStep = steps.find((s) => s.status === "waiting_approval");
    const needsHumanStep = steps.find((s) => s.status === "needs_human");
    const failedStep = steps.find((s) => s.status === "failed");
    // Only a roscaelifer task whose step is actually executing counts as running.
    const hasRunningStep = steps.some((s) => s.status === "running");
    const isRunningTask = taskStatus === "active" && hasRunningStep;

    let column = "ready";
    let actionReason = null;

    if (bdStatus === "closed") {
      if (needsReview) {
        column = "review";
      } else if (taskStatus === "active") {
        column = waitingApprovalStep || needsHumanStep
          ? "action"
          : hasRunningStep
            ? "running"
            : "closed";
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
      actionReason = isInvalidLabel ? "invalid" : isCancelledLabel ? "cancelled" : "failed";
    } else if (
      (taskStatus === "failed" || taskStatus === "cancelled") &&
      !(isOptedIn && isReady && intakePlan?.action === "create")
    ) {
      column = "action";
      actionReason = taskStatus;
    } else if (isRunningTask) {
      // Only an active task with a step actually executing is running.
      column = "running";
    } else if (taskStatus === "active" || isOptedIn) {
      // Already queued for work: an active task whose steps are all pending is
      // waiting for a concurrency slot, and an opted-in (`roscaelifer` label)
      // bead is waiting for intake/dependencies/a tick.
      column = "queue";
    } else {
      // A plain bead nobody has queued yet.
      column = "ready";
    }

    // Also pick up live blocked agent status as informational badge (stays in running unless step paused).
    const item = {
      id,
      beadId,
      taskId,
      title: issue?.title || task?.title || id,
      ephemeral: Boolean(issue?.ephemeral),
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
      beadColumn,
      actionReason,
      labels,
      formula,
      env: envName,
      envPendingAuto,
      maxRunning: envObj?.maxRunning ?? null,
      machine: envObj?.machine || null,
      project,
      assignee: issue?.assignee || "",
      parent: issue?.parent || null,
      blockedBy,
      blocks: blocksOut.get(id) || [],
      steps,
      currentStep,
      waitingStep: waitingApprovalStep || needsHumanStep || failedStep || null,
      hcAddress: canonicalAddress,
      sessionInfo,
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
      isWip,
      needsReview,
      hasFailedLabel,
      hasRunningStep,
      isRunningTask,
      isBlocked,
      createdAt: issue?.created_at || task?.created_at || null,
      updatedAt: task?.updated_at || issue?.created_at || null,
      issue,
      task,
    };
    item._searchText = [
      item.id,
      item.beadId,
      item.taskId,
      item.title,
      item.env,
      item.branch,
      ...item.labels,
      item.isWip ? "wip" : "",
      item.formula,
      item.project,
      item.assignee,
      item.parent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return item;
  }

  const seenWorkBeadIds = new Set();
  for (const issue of workIssues) {
    seenWorkBeadIds.add(issue.id);
    const metaTaskId = stripTaskMetaPrefix(issue?.metadata?.["roscaelifer.task"]);
    const matchingTasks = tasksByBead.get(issue.id) || [];
    const task = pickBestTaskForBead(matchingTasks, metaTaskId);
    const item = buildItem({ issue, task });
    items.push(item);
    itemsById.set(item.id, item);
  }

  for (const [beadIdKey, matchingTasks] of tasksByBead.entries()) {
    if (seenWorkBeadIds.has(beadIdKey)) continue;
    const task = pickBestTaskForBead(matchingTasks, null);
    if (!task) continue;
    const item = buildItem({ issue: null, task });
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
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const columns = {
    ready: sortItems(items.filter((i) => i.column === "ready")),
    queue: sortItems(items.filter((i) => i.column === "queue")),
    running: sortItems(items.filter((i) => i.column === "running")),
    action: sortItems(items.filter((i) => i.column === "action")),
    review: sortItems(items.filter((i) => i.column === "review")),
    closed: sortItems(items.filter((i) => i.column === "closed")),
  };
  const beadItems = items.filter((item) => Boolean(item.beadId));
  const beadColumns = {
    backlog: sortItems(beadItems.filter((item) => item.beadColumn === "backlog")),
    ready: sortItems(beadItems.filter((item) => item.beadColumn === "ready")),
    in_progress: sortItems(beadItems.filter((item) => item.beadColumn === "in_progress")),
    blocked: sortItems(beadItems.filter((item) => item.beadColumn === "blocked")),
    closed: sortItems(beadItems.filter((item) => item.beadColumn === "closed")),
  };

  // Build epic summaries (plus expose epics in itemsById for dependency lookup if referenced).
  // Index each item under matching epic IDs once, instead of scanning all items for every epic.
  const epicIdSet = new Set(epicsRaw.map((epic) => epic.id));
  const childrenByEpic = new Map();
  for (const item of items) {
    const matched = new Set();
    if (item.parent && epicIdSet.has(item.parent)) matched.add(item.parent);
    if (item.beadId) {
      const parts = String(item.beadId).split(".");
      let prefix = parts[0];
      for (let i = 1; i < parts.length; i += 1) {
        if (epicIdSet.has(prefix)) matched.add(prefix);
        prefix += `.${parts[i]}`;
      }
    }
    for (const epicId of matched) {
      if (!childrenByEpic.has(epicId)) childrenByEpic.set(epicId, []);
      childrenByEpic.get(epicId).push(item);
    }
  }
  const epics = epicsRaw.map((epic) => {
    const children = childrenByEpic.get(epic.id) || [];
    const counts = { ready: 0, queue: 0, running: 0, action: 0, review: 0, closed: 0, total: children.length };
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
    beadColumns,
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
    runner: snap.runner || { lock_path: "", lock_held: false, active: false },
    paths: snap.paths || {},
    generatedAt: snap.generated_at || null,
    spacesCount: (spaces || []).length,
    panesCount: (panes || []).length,
  };
}
