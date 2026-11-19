/**
 * Pure detection helpers for roscaelifer projects and live runners.
 * No Node built-ins and no herdr imports: this module is directly importable
 * from `node --test` as well as from the gpui-shell mod runtime.
 */

/**
 * @typedef {Object} TomlBdSection
 * @property {string} dir
 * @property {string} formulasDir
 */

/**
 * @typedef {Object} RunningRunner
 * @property {number} pid
 * @property {string} db
 * @property {string} config
 * @property {string} bdDir
 * @property {string} formulasDir
 * @property {string} project
 * @property {string} env
 */

/**
 * @typedef {Object} RunnerMatchContext
 * @property {string} [repo]
 * @property {string} [bdDir]
 * @property {string} [config]
 * @property {string} [formulasDir]
 * @property {string} [userHome]
 * @property {boolean} [excludeWip]
 */

/**
 * @typedef {Object} DetectionFlags
 * @property {string} [repo]
 * @property {boolean} [hasRosc]
 * @property {boolean} [hasDb]
 * @property {boolean} [hasBeads]
 * @property {boolean} [hasToml]
 * @property {boolean} [hasFormulas]
 * @property {boolean} [hasRoscFormulas]
 * @property {string} [stateDb]
 * @property {TomlBdSection} [tomlBd]
 * @property {string} [tomlDb]
 * @property {RunningRunner} [activeRunner]
 * @property {string} [userHome]
 */

/**
 * @typedef {Object} DetectedPaths
 * @property {string} db
 * @property {string} bdDir
 * @property {string} config
 * @property {string} formulasDir
 * @property {string} env
 */

/** @param {*} value @returns {string} */
function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Collapse redundant `/` and `./` segments and strip trailing slashes.
 * @param {*} value
 * @returns {string}
 */
function cleanPath(value) {
  const text = asText(value).trim();
  if (!text) return "";
  const absolute = text.startsWith("/");
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  const cleaned = parts.join("/");
  if (absolute) return cleaned ? `/${cleaned}` : "/";
  return cleaned;
}

/**
 * @param {*} rawPath
 * @param {*} userHome
 * @returns {{ text: string, expanded: boolean }}
 */
function expandHome(rawPath, userHome) {
  const text = asText(rawPath).trim();
  const userHomeClean = cleanPath(userHome);
  if (!text || !userHomeClean) return { text, expanded: false };
  if (text === "~" || text === "$HOME") return { text: userHomeClean, expanded: true };
  if (text.startsWith("~/")) return { text: `${userHomeClean}/${text.slice(2)}`, expanded: true };
  if (text.startsWith("$HOME/")) {
    return { text: `${userHomeClean}/${text.slice("$HOME/".length)}`, expanded: true };
  }
  return { text, expanded: false };
}

/**
 * Strip an inline TOML comment while respecting quoted strings.
 * @param {string} line
 * @returns {string}
 */
function stripTomlComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && quote) {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Parse only the `[bd]` section of a roscaelifer.toml.
 * @param {*} tomlText
 * @returns {TomlBdSection}
 */
export function parseTomlBdSection(tomlText) {
  const result = { dir: "", formulasDir: "" };
  const lines = asText(tomlText).split(/\r?\n/);
  let inBd = false;
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (/^\[[^\]]*\]$/.test(line)) {
      inBd = /^\[\s*bd\s*\]$/i.test(line);
      continue;
    }
    if (!inBd) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (key === "dir") result.dir = value.trim();
    if (key === "formulas_dir") result.formulasDir = value.trim();
  }
  return result;
}

/**
 * Parse the top-level `db` key of a roscaelifer.toml. Only the lines before the
 * first [section] are considered, so a `db` key inside [bd] or [env.*] is
 * ignored. Single and double quotes plus `#` comments are supported.
 * @param {*} tomlText
 * @returns {string}
 */
export function parseTomlTopLevelDb(tomlText) {
  const lines = asText(tomlText).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (/^\[/.test(line)) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== "db") continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return "";
}

/**
 * Expand `~` / `$HOME` and resolve relative paths against the repo root.
 * @param {*} rawPath
 * @param {*} repoDir
 * @param {*} userHome
 * @returns {string}
 */
export function resolveRepoRelativePath(rawPath, repoDir, userHome) {
  const expanded = expandHome(rawPath, userHome);
  if (!expanded.text) return "";
  if (expanded.text.startsWith("/") || expanded.expanded) return cleanPath(expanded.text);
  const repo = cleanPath(repoDir);
  return cleanPath(repo ? `${repo}/${expanded.text}` : expanded.text);
}

/**
 * State DB names derived from a repo directory name.
 * @param {*} repoDir
 * @param {*} stateBaseDir
 * @returns {string[]}
 */
export function stateDbCandidates(repoDir, stateBaseDir) {
  const repo = cleanPath(repoDir);
  const base = cleanPath(stateBaseDir);
  if (!repo || !base) return [];
  const parts = repo.split("/");
  const basename = parts[parts.length - 1] || "";
  if (!basename) return [];
  const lower = basename.toLowerCase();
  const slug = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const candidates = [`${base}/${lower}.db`, `${base}/${basename}.db`];
  if (slug) candidates.push(`${base}/${slug}.db`);
  return [...new Set(candidates)];
}

/**
 * Split a `ps -eo pid=,args=` command line into arguments.
 * @param {*} cmdLine
 * @returns {string[]}
 */
export function tokenizeCommandArgs(cmdLine) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote = "";
  const text = asText(cmdLine);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const VALUE_FLAGS = new Set([
  "--db",
  "--config",
  "--bd-dir",
  "--formulas-dir",
  "--project",
  "--env",
  "--backend",
  "--bin",
  "--repo",
  "--log-file",
  "--session",
  "--space",
]);

const RUNNER_FLAG_FIELDS = new Map([
  ["--db", "db"],
  ["--config", "config"],
  ["--bd-dir", "bdDir"],
  ["--formulas-dir", "formulasDir"],
  ["--project", "project"],
  ["--env", "env"],
]);

/**
 * @param {*} value
 * @param {*} userHome
 * @returns {string}
 */
function normalizeProcessPath(value, userHome) {
  const expanded = expandHome(value, userHome);
  const text = cleanPath(expanded.text);
  if (!text || (!text.startsWith("/") && !expanded.expanded)) return "";
  return text;
}

/**
 * Parse running `roscaelifer run` processes from `ps -eo pid=,args=`.
 * @param {*} psStdout
 * @param {*} userHome
 * @returns {RunningRunner[]}
 */
export function parseRunningRoscaeliferProcesses(psStdout, userHome) {
  const out = [];
  const lines = asText(psStdout).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = tokenizeCommandArgs(line);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const exe = parts[1].split("/").pop() || "";
    if (exe !== "roscaelifer") continue;

    let runIndex = -1;
    let expectValue = false;
    for (let i = 1; i < parts.length; i += 1) {
      const token = parts[i];
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (token === "run") {
        runIndex = i;
        break;
      }
      if (token.startsWith("--") && !token.includes("=") && VALUE_FLAGS.has(token)) {
        expectValue = true;
      }
    }
    if (runIndex < 0) continue;

    /** @type {RunningRunner} */
    const runner = { pid, db: "", config: "", bdDir: "", formulasDir: "", project: "", env: "" };
    for (let i = 1; i < parts.length; i += 1) {
      const token = parts[i];
      if (i === runIndex || !token.startsWith("--")) continue;
      let flag = token;
      let value = "";
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flag = token.slice(0, eq);
        value = token.slice(eq + 1);
      }
      const field = RUNNER_FLAG_FIELDS.get(flag);
      if (!field) continue;
      if (eq < 0) {
        i += 1;
        value = parts[i] || "";
      }
      if (!value) continue;
      if (field === "env") {
        runner.env = value.trim();
      } else if (field === "project") {
        const normalized = normalizeProcessPath(value, userHome);
        if (normalized) runner.project = normalized;
      } else {
        const normalized = normalizeProcessPath(value, userHome);
        if (normalized) runner[field] = normalized;
      }
    }
    out.push(runner);
  }
  return out;
}

/**
 * @param {*} left
 * @param {*} right
 * @returns {boolean}
 */
function samePath(left, right) {
  const a = cleanPath(left);
  const b = cleanPath(right);
  return Boolean(a && b && a === b);
}

/**
 * @param {*} child
 * @param {*} parent
 * @returns {boolean}
 */
function pathUnder(child, parent) {
  const a = cleanPath(child);
  const b = cleanPath(parent);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b === "/") return a.startsWith("/");
  return a.startsWith(`${b}/`);
}

/**
 * @param {*} db
 * @returns {number}
 */
function dbRank(db) {
  const path = cleanPath(db);
  if (!path) return 1;
  const basename = path.split("/").pop() || "";
  return /^(wip-|.*-wip(\b|-|\.))/i.test(basename) ? 0 : 2;
}

/**
 * Recognize a temporary `roscaelifer wip` runner that must not be treated as
 * the project's configured runner.
 * @param {RunningRunner | null | undefined} proc
 * @param {{ repo?: string, userHome?: string }} [options]
 * @returns {boolean}
 */
export function isWipRunner(proc, { repo, userHome } = {}) {
  if (!proc) return false;
  const db = cleanPath(proc.db);
  const dbName = db ? db.split("/").pop() || "" : "";
  if (/^(wip-|.*-wip(\b|-|\.))/i.test(dbName)) return true;
  const home = cleanPath(userHome);
  const globalFormulas = home ? `${home}/.roscaelifer/formulas` : "";
  const repoPath = cleanPath(repo);
  return Boolean(
    home &&
      globalFormulas &&
      samePath(proc.formulasDir, globalFormulas) &&
      repoPath &&
      repoPath !== `${home}/.roscaelifer`
  );
}

/**
 * Pick the live runner that belongs to the target repo.
 * @param {RunningRunner[]} processes
 * @param {RunnerMatchContext} target
 * @returns {RunningRunner | null}
 */
export function matchActiveRunner(processes, target) {
  const opts = target || {};
  const repo = cleanPath(opts.repo);
  const userHome = cleanPath(opts.userHome);
  const wantedBdDir = cleanPath(opts.bdDir) || (repo ? `${repo}/.beads` : "");
  const wantedConfig = cleanPath(opts.config);
  const wantedFormulasDir = cleanPath(opts.formulasDir);
  let best = null;
  /** @type {number[]} */
  let bestScore = [];

  for (const proc of processes || []) {
    if (!proc || !Number.isInteger(proc.pid)) continue;
    const wip = isWipRunner(proc, { repo, userHome });
    if (opts.excludeWip && wip) continue;
    const bdMatch = samePath(proc.bdDir, wantedBdDir);
    const configMatch = Boolean(wantedConfig && samePath(proc.config, wantedConfig)) || pathUnder(proc.config, repo);
    const formulasMatch =
      Boolean(wantedFormulasDir && samePath(proc.formulasDir, wantedFormulasDir)) ||
      pathUnder(proc.formulasDir, repo);
    const projectMatch = pathUnder(proc.project, repo);
    if (!bdMatch && !configMatch && !formulasMatch && !projectMatch) continue;

    const score = [
      wip ? 0 : dbRank(proc.db),
      bdMatch ? 1 : 0,
      Boolean(wantedConfig && samePath(proc.config, wantedConfig)) ? 1 : 0,
      proc.pid,
    ];
    let better = !best;
    if (!better) {
      for (let i = 0; i < score.length; i += 1) {
        if (score[i] > bestScore[i]) {
          better = true;
          break;
        }
        if (score[i] < bestScore[i]) break;
      }
    }
    if (better) {
      best = proc;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Merge filesystem probes, TOML settings and a live runner into final paths.
 * @param {DetectionFlags} flags
 * @returns {DetectedPaths}
 */
export function selectDetectedPaths(flags) {
  const f = flags || {};
  const repo = cleanPath(f.repo);
  const userHome = f.userHome || "";
  const activeRunner = f.activeRunner || null;
  const tomlBd = f.tomlBd || { dir: "", formulasDir: "" };
  const defaultDb = repo && (f.hasDb || f.hasRosc) ? `${repo}/.roscaelifer/roscaelifer.db` : "";
  const defaultFormulas = repo
    ? f.hasFormulas
      ? `${repo}/formulas`
      : f.hasRoscFormulas
        ? `${repo}/.roscaelifer/formulas`
        : ""
    : "";
  return {
    db:
      activeRunner?.db ||
      resolveRepoRelativePath(f.tomlDb, repo, userHome) ||
      cleanPath(f.stateDb) ||
      defaultDb,
    bdDir: activeRunner?.bdDir || (f.hasBeads && repo ? `${repo}/.beads` : "") || resolveRepoRelativePath(tomlBd.dir, repo, userHome),
    config: activeRunner?.config || (f.hasToml && repo ? `${repo}/roscaelifer.toml` : ""),
    formulasDir:
      activeRunner?.formulasDir ||
      resolveRepoRelativePath(tomlBd.formulasDir, repo, userHome) ||
      defaultFormulas,
    env: activeRunner?.env || "",
  };
}
