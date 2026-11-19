import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  isWipRunner,
  matchActiveRunner,
  parseRunningRoscaeliferProcesses,
  parseTomlBdSection,
  parseTomlTopLevelDb,
  resolveRepoRelativePath,
  selectDetectedPaths,
  stateDbCandidates,
  tokenizeCommandArgs,
} from "../mods/roscaelifer-queue/detect.js";

// store.js imports `herdr`, which is provided by the UI runtime. Mock it so the
// remote runner probe can be exercised under plain `node --test`.
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
          export const exec = (...args) => mock().exec(...args);
          export const checking = () => mock().checking?.() ?? true;
          export const home = () => mock().home?.() ?? "";
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

test("parseTomlBdSection reads only [bd] dir and formulas_dir", () => {
  const toml = `
# top level comment
[env.roommate]
kind = "local"
dir = "/wrong/env"

[bd] # section comment
dir = ".beads"
formulas_dir = 'custom/formulas' # inline comment
unknown = "ignored"
# formulas_dir = "commented-out"

[other]
dir = "/wrong/other"
formulas_dir = "/wrong/formulas"
`;
  assert.deepEqual(parseTomlBdSection(toml), { dir: ".beads", formulasDir: "custom/formulas" });
  assert.deepEqual(parseTomlBdSection('[bd]\nformulas_dir = "#hash/path" # trailing'), {
    dir: "",
    formulasDir: "#hash/path",
  });
  assert.deepEqual(parseTomlBdSection(""), { dir: "", formulasDir: "" });
});

test("resolveRepoRelativePath expands home and cleans paths", () => {
  assert.equal(resolveRepoRelativePath("./.beads/", "/repos/JikeRental/", "/home/me"), "/repos/JikeRental/.beads");
  assert.equal(resolveRepoRelativePath("formulas/custom", "/repos/JikeRental", "/home/me"), "/repos/JikeRental/formulas/custom");
  assert.equal(resolveRepoRelativePath("~/state/roscaelifer/jikerental.db", "/repos/JikeRental", "/home/me"), "/home/me/state/roscaelifer/jikerental.db");
  assert.equal(resolveRepoRelativePath("$HOME/.config/roscaelifer.toml", "/repos/JikeRental", "/home/me"), "/home/me/.config/roscaelifer.toml");
  assert.equal(resolveRepoRelativePath("~", "/repos/JikeRental", "/home/me"), "/home/me");
  assert.equal(resolveRepoRelativePath("/opt/formulas/", "/repos/JikeRental", "/home/me"), "/opt/formulas");
});

test("stateDbCandidates covers case, camel case, underscores and duplicates", () => {
  assert.deepEqual(stateDbCandidates("/repos/JikeRental", "/state/roscaelifer"), [
    "/state/roscaelifer/jikerental.db",
    "/state/roscaelifer/JikeRental.db",
  ]);
  assert.deepEqual(stateDbCandidates("/repos/My_Repo/", "/state/roscaelifer/"), [
    "/state/roscaelifer/my_repo.db",
    "/state/roscaelifer/My_Repo.db",
    "/state/roscaelifer/my-repo.db",
  ]);
  assert.deepEqual(stateDbCandidates("/repos/lowercase", "/state"), ["/state/lowercase.db"]);
});

test("tokenizeCommandArgs handles quotes and escapes", () => {
  assert.deepEqual(
    tokenizeCommandArgs(`  87889 roscaelifer run --db "/tmp/my db/jikerental.db" --env 'room mate' --flag=a\\ b`),
    ["87889", "roscaelifer", "run", "--db", "/tmp/my db/jikerental.db", "--env", "room mate", "--flag=a b"],
  );
});

test("parseRunningRoscaeliferProcesses extracts real run commands", () => {
  const ps = String.raw`  87889 /usr/local/bin/roscaelifer run --backend herdr --env roommate --config /repos/JikeRental/roscaelifer.toml --bd-dir /repos/JikeRental/.beads --formulas-dir /repos/JikeRental/.roscaelifer/formulas --db $HOME/.local/state/roscaelifer/jikerental.db
  87900 /usr/local/bin/roscaelifer --db=/tmp/global.db run --project /repos/JikeRental --env local
  87901 /usr/local/bin/roscaelifer wait --db /tmp/ignored.db
  87902 /usr/local/bin/other run --db /tmp/ignored.db
`;
  const runners = parseRunningRoscaeliferProcesses(ps, "/home/me");
  assert.equal(runners.length, 2);
  assert.deepEqual(runners[0], {
    pid: 87889,
    db: "/home/me/.local/state/roscaelifer/jikerental.db",
    config: "/repos/JikeRental/roscaelifer.toml",
    bdDir: "/repos/JikeRental/.beads",
    formulasDir: "/repos/JikeRental/.roscaelifer/formulas",
    project: "",
    env: "roommate",
  });
  assert.deepEqual(runners[1], {
    pid: 87900,
    db: "/tmp/global.db",
    config: "",
    bdDir: "",
    formulasDir: "",
    project: "/repos/JikeRental",
    env: "local",
  });
});

test("parseRunningRoscaeliferProcesses skips relative paths but keeps quoted ones", () => {
  const ps = [
    ' 10 roscaelifer run --db "./local.db" --config ../roscaelifer.toml --env local',
    ' 11 roscaelifer run --db="/tmp/with space.db" --formulas-dir \'/repos/My Project/formulas\'',
  ].join("\n");
  const runners = parseRunningRoscaeliferProcesses(ps, "/home/me");
  assert.equal(runners.length, 2);
  assert.equal(runners[0].db, "");
  assert.equal(runners[0].config, "");
  assert.equal(runners[0].env, "local");
  assert.equal(runners[1].db, "/tmp/with space.db");
  assert.equal(runners[1].formulasDir, "/repos/My Project/formulas");
});

test("parseRunningRoscaeliferProcesses keeps the next flag after --db=", () => {
  const ps = String.raw` 20 roscaelifer run --db= --project /repos/JikeRental --env local`;
  const runners = parseRunningRoscaeliferProcesses(ps, "/home/me");
  assert.equal(runners.length, 1);
  assert.deepEqual(runners[0], {
    pid: 20,
    db: "",
    config: "",
    bdDir: "",
    formulasDir: "",
    project: "/repos/JikeRental",
    env: "local",
  });
});

test("parseRunningRoscaeliferProcesses expands --project and matches the target repo", () => {
  const ps = String.raw` 21 roscaelifer run --project ~/work/repo --db /state/repo.db`;
  const [runner] = parseRunningRoscaeliferProcesses(ps, "/home/me");
  assert.equal(runner?.project, "/home/me/work/repo");
  assert.equal(matchActiveRunner([runner], { repo: "/home/me/work/repo" }), runner);
});

test("matchActiveRunner matches a single runner and rejects unrelated repos", () => {
  const target = {
    repo: "/repos/JikeRental",
    bdDir: "/repos/JikeRental/.beads",
    config: "/repos/JikeRental/roscaelifer.toml",
    formulasDir: "/repos/JikeRental/formulas",
  };
  const runner = {
    pid: 100,
    db: "/state/jikerental.db",
    config: "/repos/JikeRental/roscaelifer.toml",
    bdDir: "",
    formulasDir: "",
    project: "",
    env: "roommate",
  };
  assert.equal(matchActiveRunner([runner], target), runner);
  assert.equal(matchActiveRunner([{ ...runner, config: "/other/roscaelifer.toml", project: "/other" }], target), null);
});

test("matchActiveRunner prefers a non-wip DB over a wip DB", () => {
  const target = { repo: "/repos/JikeRental", config: "/repos/JikeRental/roscaelifer.toml" };
  const wip = {
    pid: 200,
    db: "/state/wip-jikerental.db",
    config: target.config,
    bdDir: "",
    formulasDir: "",
    project: "",
    env: "",
  };
  const stable = {
    pid: 100,
    db: "/state/jikerental.db",
    config: target.config,
    bdDir: "",
    formulasDir: "",
    project: "",
    env: "",
  };
  assert.equal(matchActiveRunner([wip, stable], target), stable);
  assert.equal(matchActiveRunner([stable, wip], target), stable);
});

test("isWipRunner recognizes temporary WIP runners but not configured ones", () => {
  const userHome = "/Users/kokoro";
  const repo = `${userHome}/work/chenlei/JikeRental`;
  const fields = { config: "", bdDir: "", formulasDir: "", project: "", env: "" };

  assert.equal(isWipRunner(null), false);
  assert.equal(isWipRunner({ pid: 1, db: `${userHome}/state/wip-jikerental.db`, ...fields }), true);
  assert.equal(isWipRunner({ pid: 2, db: `${userHome}/state/jikerental-wip.db`, ...fields }), true);

  // PID 16997: `roscaelifer wip` launched from JikeRental with the global fallback formulas.
  const ps = String.raw` 16997 /usr/local/bin/roscaelifer run --backend herdr --env local --db ~/work/chenlei/JikeRental/.roscaelifer/roscaelifer.db --bd-dir ~/work/chenlei/JikeRental/.beads --formulas-dir ~/.roscaelifer/formulas`;
  const [wip] = parseRunningRoscaeliferProcesses(ps, userHome);
  assert.deepEqual(wip, {
    pid: 16997,
    db: `${repo}/.roscaelifer/roscaelifer.db`,
    config: "",
    bdDir: `${repo}/.beads`,
    formulasDir: `${userHome}/.roscaelifer/formulas`,
    project: "",
    env: "local",
  });
  assert.equal(isWipRunner(wip, { repo, userHome }), true);
  assert.equal(isWipRunner(wip, { repo: "", userHome }), false);
  assert.equal(isWipRunner(wip, { repo: `${userHome}/.roscaelifer`, userHome }), false);

  const formal = {
    pid: 16998,
    db: `${userHome}/.local/state/roscaelifer/jikerental.db`,
    config: `${repo}/roscaelifer.toml`,
    bdDir: `${repo}/.beads`,
    formulasDir: `${repo}/.roscaelifer/formulas`,
    project: "",
    env: "local",
  };
  assert.equal(isWipRunner(formal, { repo, userHome }), false);
});

test("matchActiveRunner skips and downranks temporary WIP runners", () => {
  const userHome = "/Users/kokoro";
  const repo = `${userHome}/work/chenlei/JikeRental`;
  const target = { repo, bdDir: `${repo}/.beads`, userHome };
  const wip = {
    pid: 999,
    db: `${repo}/.roscaelifer/roscaelifer.db`,
    config: "",
    bdDir: `${repo}/.beads`,
    formulasDir: `${userHome}/.roscaelifer/formulas`,
    project: "",
    env: "",
  };
  const formal = {
    pid: 100,
    db: `${userHome}/.local/state/roscaelifer/jikerental.db`,
    config: `${repo}/roscaelifer.toml`,
    bdDir: `${repo}/.beads`,
    formulasDir: `${repo}/.roscaelifer/formulas`,
    project: "",
    env: "",
  };

  assert.equal(matchActiveRunner([wip], { ...target, excludeWip: true }), null);
  assert.equal(matchActiveRunner([wip, formal], { ...target, excludeWip: true }), formal);
  assert.equal(matchActiveRunner([formal, wip], { ...target, excludeWip: true }), formal);
  assert.equal(matchActiveRunner([wip, formal], target), formal);
});

test("parseTomlTopLevelDb reads only the top-level db", () => {
  const toml = `# shared db for formal run + wip
db = "~/.local/state/roscaelifer/jikerental.db"

[env.local]
kind = "local"

[bd]
db = "/ignored/inside-section.db"
`;
  assert.equal(parseTomlTopLevelDb(toml), "~/.local/state/roscaelifer/jikerental.db");
  assert.equal(parseTomlTopLevelDb("db = './state/queue.db' # relative\n[bd]\n"), "./state/queue.db");
  assert.equal(parseTomlTopLevelDb("[bd]\ndb = './ignored.db'\n"), "");
  assert.equal(parseTomlTopLevelDb('db = ""\n'), "");
  assert.equal(parseTomlTopLevelDb(""), "");
  assert.equal(parseTomlTopLevelDb(null), "");
});

test("selectDetectedPaths applies db/formulas/bd/config priority", () => {
  const repo = "/repos/JikeRental";
  const base = { repo, hasRosc: true, hasDb: false, hasBeads: true, hasToml: true, hasFormulas: false, hasRoscFormulas: false };
  const live = {
    pid: 1,
    db: "/live/live.db",
    config: "/live/other.toml",
    bdDir: "/live/other-beads",
    formulasDir: "/live/other-formulas",
    project: "",
    env: "roommate",
  };

  assert.equal(selectDetectedPaths(base).db, `${repo}/.roscaelifer/roscaelifer.db`);
  assert.equal(selectDetectedPaths({ ...base, stateDb: "/state/jikerental.db" }).db, "/state/jikerental.db");
  assert.equal(selectDetectedPaths({ ...base, stateDb: "/state/jikerental.db", activeRunner: live }).db, "/live/live.db");
  assert.equal(selectDetectedPaths({ ...base, hasDb: true }).db, `${repo}/.roscaelifer/roscaelifer.db`);

  // Top-level `db` beats the state-db guess but loses to a live runner.
  assert.equal(selectDetectedPaths({ ...base, tomlDb: "/shared/jikerental.db" }).db, "/shared/jikerental.db");
  assert.equal(
    selectDetectedPaths({ ...base, tomlDb: "./state/shared.db", stateDb: "/state/jikerental.db" }).db,
    `${repo}/state/shared.db`,
  );
  assert.equal(
    selectDetectedPaths({ ...base, tomlDb: "~/state/shared.db", userHome: "/home/me", stateDb: "/state/jikerental.db" }).db,
    "/home/me/state/shared.db",
  );
  assert.equal(selectDetectedPaths({ ...base, tomlDb: "/shared/jikerental.db", activeRunner: live }).db, "/live/live.db");

  assert.equal(selectDetectedPaths({ ...base, hasRoscFormulas: true }).formulasDir, `${repo}/.roscaelifer/formulas`);
  assert.equal(selectDetectedPaths({ ...base, hasFormulas: true }).formulasDir, `${repo}/formulas`);
  assert.equal(selectDetectedPaths({ ...base, tomlBd: { dir: "", formulasDir: "./toml/formulas" } }).formulasDir, `${repo}/toml/formulas`);
  assert.equal(selectDetectedPaths({ ...base, activeRunner: live }).formulasDir, "/live/other-formulas");

  assert.equal(selectDetectedPaths(base).bdDir, `${repo}/.beads`);
  assert.equal(selectDetectedPaths({ ...base, hasBeads: false, tomlBd: { dir: "./custom/beads", formulasDir: "" } }).bdDir, `${repo}/custom/beads`);
  assert.equal(selectDetectedPaths({ ...base, activeRunner: live }).bdDir, "/live/other-beads");

  assert.equal(selectDetectedPaths(base).config, `${repo}/roscaelifer.toml`);
  assert.equal(selectDetectedPaths({ ...base, activeRunner: live }).config, "/live/other.toml");
  assert.equal(selectDetectedPaths(base).env, "");
  assert.equal(selectDetectedPaths({ ...base, activeRunner: live }).env, "roommate");
});

test("detectActiveRunnerMismatch ignores a WIP runner but reports a formal one", async () => {
  const store = await import("../mods/roscaelifer-queue/store.js");
  const userHome = "/Users/kokoro";
  const repo = `${userHome}/work/chenlei/JikeRental`;
  const ctx = { repo, db: `${userHome}/.local/state/roscaelifer/jikerental.db` };
  const wipPs = String.raw` 16997 roscaelifer run --db ${repo}/.roscaelifer/roscaelifer.db --bd-dir ${repo}/.beads --formulas-dir ${userHome}/.roscaelifer/formulas`;
  const formalPs = String.raw` 16998 roscaelifer run --db ${userHome}/.local/state/roscaelifer/other.db --bd-dir ${repo}/.beads --formulas-dir ${repo}/.roscaelifer/formulas`;

  async function probe(stdout) {
    globalThis.__roscaeliferHerdrMock = {
      checking: () => false,
      home: () => userHome,
      exec: async () => ({ code: 0, stdout }),
    };
    return store.detectActiveRunnerMismatch(ctx);
  }

  try {
    assert.equal(await probe(wipPs), null);
    const mismatch = await probe([wipPs, formalPs].join("\n"));
    assert.equal(mismatch?.pid, 16998);
    assert.equal(mismatch?.db, `${userHome}/.local/state/roscaelifer/other.db`);
  } finally {
    delete globalThis.__roscaeliferHerdrMock;
  }
});

test("detectActiveRunnerMismatch expands remote HOME from a single ps probe", async () => {
  const store = await import("../mods/roscaelifer-queue/store.js");
  const ctx = {
    machine: "remote",
    repo: "/repos/demo",
    db: "/repos/demo/.roscaelifer/roscaelifer.db",
  };
  const calls = [];

  async function probe(dbFlag, remoteHome) {
    globalThis.__roscaeliferHerdrMock = {
      checking: () => false,
      exec: async (...args) => {
        calls.push(args);
        return {
          code: 0,
          stdout: [
            remoteHome,
            ` 77 roscaelifer run --db ${dbFlag} --bd-dir /repos/demo/.beads`,
            "",
          ].join("\n"),
        };
      },
    };
    return store.detectActiveRunnerMismatch(ctx);
  }

  try {
    const tilde = await probe("~/state/demo.db", "/remote/home");
    const dollar = await probe("$HOME/state/demo.db", "/remote/other");

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.slice(0, 2), [
        "sh",
        ["-c", 'printf "%s\\n" "$HOME"; ps -eo pid=,args='],
      ]);
      assert.deepEqual(call[2], { on: "remote", timeout: 3000 });
    }
    assert.equal(tilde?.pid, 77);
    assert.equal(tilde?.db, "/remote/home/state/demo.db");
    assert.equal(dollar?.pid, 77);
    assert.equal(dollar?.db, "/remote/other/state/demo.db");
  } finally {
    delete globalThis.__roscaeliferHerdrMock;
  }
});
