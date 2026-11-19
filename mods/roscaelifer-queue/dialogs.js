import { div } from "gpui-kit";
import {
  v_flex,
  h_flex,
  Button,
  Checkbox,
  Input,
  InputState,
  Popup,
  ScrollHandle,
  Scrollbar,
  Select,
  Textarea,
  TextareaState,
} from "gpui-base";
import { closeOverlay, focused, home, panes, pickFolder, props, setShared, spaces, theme } from "herdr";
import { createActions } from "./actions.js";
import {
  clearActiveProjectMirror,
  deleteGlobalProject,
  detectCurrentWorkspaceProject,
  detectRepoFromPath,
  hasLiveBeadsDir,
  loadGlobalProjectsConfig,
  repoIdentityKey,
  saveActiveProjectMirror,
  saveGlobalProjectsConfig,
  upsertGlobalProject,
} from "./store.js";

const alpha = (c, aa) => (typeof c === "string" && c.length === 7 ? c + aa : c);
const normalizeMachine = (machine) => (typeof machine === "string" ? machine.trim() : "");

const PRIORITIES = [
  { value: 0, label: "P0 · Critical" },
  { value: 1, label: "P1 · High" },
  { value: 2, label: "P2 · Medium" },
  { value: 3, label: "P3 · Low" },
  { value: 4, label: "P4 · Backlog" },
];

const ISSUE_TYPES = [
  { value: "task", label: "task" },
  { value: "bug", label: "bug" },
  { value: "feature", label: "feature" },
  { value: "epic", label: "epic" },
  { value: "chore", label: "chore" },
];

const WORKER_FORMULAS = [
  "worker-inplace",
  "worker-isolated",
  "worker-verify",
  "worker-git",
  "worker-browser",
];

const WIP_MODELS = [
  { value: "group/cheap", label: "group/cheap (default)" },
  { value: "group/standard", label: "group/standard" },
  { value: "group/never-stuck", label: "group/never-stuck" },
];

const MCP_PROFILE_PRESETS = ["playwright", "chrome-devtools"];

function normalizeCleanPreview(raw) {
  if (!raw) return { actions: [], errors: [], empty: true };
  if (Array.isArray(raw)) {
    return { actions: raw, errors: [], empty: raw.length === 0 };
  }
  const actions = [];
  if (Array.isArray(raw.actions)) {
    actions.push(...raw.actions);
  } else {
    for (const term of raw.terminals ?? []) {
      actions.push({ kind: "kill_terminal", ...term });
    }
    for (const wt of raw.worktrees ?? []) {
      actions.push({ kind: "remove_worktree", ...wt });
    }
    for (const sc of raw.sidecars ?? []) {
      actions.push({ kind: "delete_sidecar", ...sc });
    }
  }
  const errors = Array.isArray(raw.errors) ? raw.errors : raw.error ? [raw.error] : [];
  return { actions, errors, empty: actions.length === 0 && errors.length === 0, raw };
}

export class DialogController {
  constructor(initialProps, cx) {
    const p = {
      ...(initialProps && typeof initialProps === "object" ? initialProps : {}),
      ...(props() ?? {}),
    };
    this.p = p;
    this.dialogType = p.dialogType ?? "enqueue";
    this.ctx = p.ctx ?? {};
    this.item = p.item ?? null;
    this.formulas = Array.isArray(p.formulas) ? p.formulas : [];
    this.envs = Array.isArray(p.envs) ? p.envs : [];
    this.items = Array.isArray(p.items) ? p.items : [];

    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.busy = false;
    this.error = null;

    this.actions = createActions({
      getCtx: () => this.ctx,
      onBusyChange: (busy) => {
        this.busy = Boolean(busy);
      },
      onRefresh: () => {
        setShared("roscaelifer.refresh", Date.now());
      },
    });

    // Dropdown state keyed by field name
    this.openSelect = null;
    // Guards the press sequence that dismisses a select: `on_mouse_down_out`
    // closes it before the following `on_click` on the trigger is delivered.
    this._selectDismissedAt = null;
    this.selectHighlight = 0;
    this.selectFocus = {};
    this.listFocus = {};
    for (const key of ["formula", "env", "priority", "type", "blocks", "model"]) {
      this.selectFocus[key] = cx.focus_handle();
      this.listFocus[key] = cx.focus_handle();
    }

    // Dialog-specific state
    const formulaDefault = this.item?.formula || this.formulas[0]?.name || this.formulas[0] || "";
    const envDefault = this.item?.env || "";
    this.hasBd = null;

    if (this.dialogType === "enqueue") {
      this.formula = typeof formulaDefault === "string" ? formulaDefault : "";
      this.env = typeof envDefault === "string" ? envDefault : "";
      this.wakeDeferred = this.item?.bdStatus === "deferred";
      this.handle.focus();
    } else if (this.dialogType === "create" || this.dialogType === "create-wip") {
      this.titleInput = InputState.new({
        placeholder: this.dialogType === "create-wip" ? "Short WIP task title" : "Short actionable bead title",
      });
      this.descInput = TextareaState.new({ placeholder: "Description, task instructions, acceptance criteria…", rows: 5 });
      this.blocksInput = InputState.new({ placeholder: "Optional bead ID(s), e.g. rsc-123" });
      const defaultCwd = this.defaultWipCwd();
      this.cwdInput = InputState.new({
        value: defaultCwd,
        placeholder: defaultCwd ? `${defaultCwd} (working directory)` : "/path/to/working/dir (optional)",
      });
      this.mcpInput = InputState.new({ placeholder: "Optional, e.g. playwright or chrome-devtools" });
      this.priority = 2;
      this.issueType = "task";
      this.formula = typeof formulaDefault === "string" ? formulaDefault : "";
      this.wipFormula = this.defaultWipFormula();
      this.model = "group/cheap";
      this.env = this.dialogType === "create-wip" ? (this.ctx?.env || "") : "";
      this.blocksSelected = [];
      this.enqueueNow = true;
      this.focusedField = null;

      for (const [name, st] of [
        ["title", this.titleInput],
        ["desc", this.descInput],
        ["blocks", this.blocksInput],
        ["cwd", this.cwdInput],
        ["mcp", this.mcpInput],
      ]) {
        st.on("focus", (_e, cx) => {
          this.focusedField = name;
          cx.notify();
        });
        st.on("blur", (_e, cx) => {
          if (this.focusedField === name) this.focusedField = null;
          cx.notify();
        });
      }
      this.titleInput.on("change", (_e, cx) => {
        this.error = null;
        cx.notify();
      });

      this.titleInput.focus();
      cx.timer.after(120, () => this.titleInput.focus());
      cx.spawn(async (probeCx) => {
        try {
          this.hasBd = await hasLiveBeadsDir(this.ctx);
        } catch {
          this.hasBd = false;
        }
        probeCx.notify();
      });
    } else if (this.dialogType === "reject") {
      this.feedbackInput = TextareaState.new({ placeholder: "Explain why this review is rejected and what needs fixing…", rows: 5 });
      this.feedbackFocused = true;
      this.feedbackInput.on("change", (_e, cx) => {
        this.error = null;
        cx.notify();
      });
      this.feedbackInput.on("focus", (_e, cx) => {
        this.feedbackFocused = true;
        cx.notify();
      });
      this.feedbackInput.on("blur", (_e, cx) => {
        this.feedbackFocused = false;
        cx.notify();
      });
      this.feedbackInput.focus();
      cx.timer.after(120, () => this.feedbackInput.focus());
    } else if (this.dialogType === "clean-preview") {
      this.preview = p.cleanPreview ? normalizeCleanPreview(p.cleanPreview) : null;
      this.loadingPreview = !this.preview;
      this.handle.focus();
      if (!this.preview) {
        this.loadCleanPreview(cx);
      }
    } else if (this.dialogType === "repo-config" || this.dialogType === "project-config") {
      this.projectsConfig = p.projectsConfig || { version: 1, activeProject: "", projects: [] };
      this.editingProjectId = null;
      this.projectFormTouched = false;
      this.autoProjectName = "";
      this.projectNameInput = InputState.new({ value: "", placeholder: "A name for this project" });
      this.repoInput = InputState.new({ value: "", placeholder: "/path/to/project (optional)" });
      this.machineInput = InputState.new({ value: "", placeholder: "remote machine (optional)" });
      this.dbInput = InputState.new({ value: "", placeholder: ".roscaelifer/roscaelifer.db" });
      this.bdDirInput = InputState.new({ value: "", placeholder: "/path/to/project/.beads" });
      this.configInput = InputState.new({ value: "", placeholder: "roscaelifer.toml" });
      this.formulasDirInput = InputState.new({ value: "", placeholder: "formulas" });
      this.binInput = InputState.new({ value: "", placeholder: "roscaelifer (optional override)" });
      this.envInput = InputState.new({ value: "", placeholder: "optional default environment" });
      this.focusedField = "name";
      for (const [name, st] of [
        ["name", this.projectNameInput],
        ["repo", this.repoInput],
        ["machine", this.machineInput],
        ["db", this.dbInput],
        ["bdDir", this.bdDirInput],
        ["config", this.configInput],
        ["formulasDir", this.formulasDirInput],
        ["bin", this.binInput],
        ["env", this.envInput],
      ]) {
        st.on("focus", (_e, cx) => {
          this.focusedField = name;
          cx.notify();
        });
        st.on("blur", (_e, cx) => {
          if (this.focusedField === name) this.focusedField = null;
          cx.notify();
        });
        st.on("change", (_e, cx) => {
          this.projectFormTouched = true;
          this.error = null;
          cx.notify();
        });
      }
      this.setProjectForm(this.resolveProjectForForm(), false);
      this.projectNameInput.focus();
      cx.timer.after(120, () => this.projectNameInput.focus());
      cx.spawn(async (loadCx) => {
        try {
          this.projectsConfig = await loadGlobalProjectsConfig();
          if (!this.projectFormTouched) this.setProjectForm(this.resolveProjectForForm(), false);
        } catch (err) {
          this.error = String(err?.message ?? err);
        } finally {
          loadCx.notify();
        }
      });
    }
  }

  close() {
    const overlayId = (props() ?? this.p)?.overlay;
    if (overlayId) closeOverlay(overlayId);
  }

  cleanTarget() {
    const t = this.p.target;
    if (!t) return {};
    if (typeof t === "string") return { taskId: t };
    return t;
  }

  loadCleanPreview(cx) {
    this.loadingPreview = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const res = await this.actions.cleanPreview(this.cleanTarget());
        this.preview = normalizeCleanPreview(res);
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.loadingPreview = false;
        cx.notify();
      }
    });
  }

  submit(cx, dispatchNow = false) {
    if (this.busy) return;
    if (this.dialogType === "enqueue") {
      const beadId = this.item?.beadId || this.item?.id;
      if (!beadId) {
        this.error = "Missing bead ID.";
        cx.notify();
        return;
      }
      const selectedEnv = this.envs.find((entry) => (typeof entry === "string" ? entry : entry?.name) === this.env);
      const maxRunning = typeof selectedEnv === "object" ? selectedEnv?.maxRunning : undefined;
      this.runMutation(cx, () =>
        dispatchNow
          ? this.actions.dispatchBead(beadId, {
              formula: this.formula || undefined,
              env: this.env || undefined,
              currentLabels: this.item?.labels || [],
              bdStatus: this.item?.bdStatus || null,
              wakeDeferred: this.wakeDeferred,
              maxRunning,
            })
          : this.actions.enqueueBead(beadId, {
              formula: this.formula || undefined,
              env: this.env || undefined,
              currentLabels: this.item?.labels || [],
              bdStatus: this.item?.bdStatus || null,
              wakeDeferred: this.wakeDeferred,
            }),
      );
      return;
    }

    if (this.dialogType === "create") {
      const title = this.titleInput.value().trim();
      if (!title) {
        this.error = "Title is required.";
        this.titleInput.focus();
        cx.notify();
        return;
      }
      const typedBlocks = this.blocksInput
        .value()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const blocks = [...new Set([...this.blocksSelected, ...typedBlocks])];
      this.runMutation(cx, () =>
        this.actions.createBead({
          title,
          description: this.descInput.value().trim(),
          priority: this.priority,
          issueType: this.issueType,
          formula: this.formula || undefined,
          env: this.env || undefined,
          blocks: blocks.join(","),
          enqueue: this.enqueueNow,
        }),
      );
      return;
    }

    if (this.dialogType === "create-wip") {
      const title = this.titleInput.value().trim();
      if (!title) {
        this.error = "Title is required.";
        this.titleInput.focus();
        cx.notify();
        return;
      }
      this.runMutation(cx, () =>
        this.actions.createWipCard({
          title,
          description: this.descInput.value().trim(),
          formula: this.wipFormula || "worker-inplace",
          cwd: this.cwdInput.value().trim(),
          model: this.model || "group/cheap",
          mcpProfile: this.mcpInput.value().trim(),
          env: this.env || undefined,
          priority: this.priority,
        }),
      );
      return;
    }

    if (this.dialogType === "reject") {
      const beadId = this.item?.beadId || this.item?.id;
      const feedback = this.feedbackInput.value().trim();
      if (!beadId) {
        this.error = "Missing bead ID.";
        cx.notify();
        return;
      }
      if (!feedback) {
        this.error = "Review feedback is required to reject.";
        this.feedbackInput.focus();
        cx.notify();
        return;
      }
      this.runMutation(cx, () => this.actions.rejectReview(beadId, feedback));
      return;
    }

    if (this.dialogType === "clean-preview") {
      this.runMutation(cx, () => this.actions.executeClean(this.cleanTarget()));
      return;
    }

    if (this.dialogType === "repo-config" || this.dialogType === "project-config") {
      const name = this.projectNameInput.value().trim();
      const nextProject = {
        name,
        repo: this.repoInput.value().trim(),
        machine: this.machineInput.value().trim(),
        db: this.dbInput.value().trim(),
        bdDir: this.bdDirInput.value().trim(),
        config: this.configInput.value().trim(),
        formulasDir: this.formulasDirInput.value().trim(),
        bin: this.binInput.value().trim(),
        env: this.envInput.value().trim(),
        updatedAt: Date.now(),
      };
      if (!name) {
        this.error = "Project Name is required.";
        this.projectNameInput.focus();
        cx.notify();
        return;
      }
      if (!nextProject.repo && !nextProject.db && !nextProject.bdDir && !nextProject.config && !nextProject.formulasDir) {
        this.error = "Provide at least one of Project Root, DB Path, Beads Directory, Herdr Env Config, or Formulas Directory.";
        cx.notify();
        return;
      }
      this.busy = true;
      this.error = null;
      cx.notify();
      cx.spawn(async (saveCx) => {
        try {
          const result = await upsertGlobalProject(nextProject, this.editingProjectId);
          const savedCtx = { ...result.project, projectId: result.project.id, source: "project" };
          saveActiveProjectMirror(result.project);
          setShared("roscaelifer.ctxOverride", { ...savedCtx, updatedAt: Date.now() });
          setShared("roscaelifer.refresh", Date.now());
          this.close();
        } catch (err) {
          this.error = String(err?.message ?? err);
        } finally {
          this.busy = false;
          saveCx.notify();
        }
      });
    }
  }

  runMutation(cx, fn) {
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await fn();
        if (res === false) {
          this.error = "Operation failed. Check notification details.";
          return;
        }
        setShared("roscaelifer.refresh", Date.now());
        this.close();
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  defaultWipCwd() {
    if (this.ctx?.repo) return this.ctx.repo;
    if (this.ctx?.machine) return "";
    const activeSpace = (spaces() || []).find((s) => s.active);
    const candidate = focused()?.cwd || activeSpace?.folder || "";
    const clean = String(candidate || "").replace(/\/+$/, "");
    const userHome = String(home() || "").replace(/\/+$/, "");
    if (!clean || clean === "/" || clean === userHome) return "";
    return clean;
  }

  defaultWipFormula() {
    const names = this.formulas
      .map((f) => (typeof f === "string" ? f : f?.name))
      .filter(Boolean);
    for (const std of WORKER_FORMULAS) {
      if (names.includes(std)) return std;
    }
    return WORKER_FORMULAS[0];
  }

  wipFormulaOptions() {
    const seen = new Set(WORKER_FORMULAS);
    const extras = [];
    for (const f of this.formulas) {
      const name = typeof f === "string" ? f : f?.name;
      if (name && name.startsWith("worker-") && !seen.has(name)) {
        seen.add(name);
        extras.push(name);
      }
    }
    return [...WORKER_FORMULAS, ...extras].map((n) => ({ value: n, label: n }));
  }

  toggleMcpProfile(profile, cx) {
    const current = this.mcpInput
      .value()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const next = current.includes(profile)
      ? current.filter((item) => item !== profile)
      : [...current, profile];
    this.mcpInput.set_value(next.join(", "));
    cx?.notify?.();
  }

  formulaOptions() {
    const names = this.formulas
      .map((f) => (typeof f === "string" ? f : f?.name))
      .filter(Boolean);
    return [{ value: "", label: "(default / formula label omitted)" }, ...names.map((n) => ({ value: n, label: n }))];
  }

  envOptions() {
    const names = this.envs
      .map((e) => (typeof e === "string" ? e : e?.name))
      .filter(Boolean);
    return [{ value: "", label: "(default env)" }, ...names.map((n) => ({ value: n, label: n }))];
  }

  renderSelect(t, key, label, options, currentVal, onPick) {
    const isOpen = this.openSelect === key;
    const selectedOpt = options.find((o) => String(o.value) === String(currentVal)) ?? options[0];
    const triggerFocus = this.selectFocus[key];
    const listFocus = this.listFocus[key];

    const trigger = h_flex()
      .id(`dlg-sel-trig-${key}`)
      .track_focus(triggerFocus)
      .w_full()
      .h(34)
      .px(10)
      .items_center()
      .justify_between()
      .rounded(7)
      .border_1()
      .border_color(isOpen ? t.accent : t.input)
      .bg(t.background)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        const dismissed = this._selectDismissedAt;
        if (dismissed && dismissed.key === key && Date.now() - dismissed.at < 200) {
          this._selectDismissedAt = null;
          return;
        }
        this._selectDismissedAt = null;
        this.openSelect = isOpen ? null : key;
        if (isOpen) {
          triggerFocus.focus();
        } else {
          this.selectHighlight = Math.max(
            0,
            options.findIndex((o) => String(o.value) === String(currentVal)),
          );
          listFocus.focus();
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(selectedOpt?.label ?? String(currentVal || "Select…")))
      .child(div().text_size(11).text_color(t.dim).child(isOpen ? "▲" : "▼"));

    const list = v_flex()
      .id(`dlg-sel-list-${key}`)
      .track_focus(listFocus)
      .w(320)
      .max_h(220)
      .p(4)
      .overflow_y_scrollbar()
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .shadow_md()
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => {
        if (this.openSelect !== key) return;
        this.openSelect = null;
        this._selectDismissedAt = { key, at: Date.now() };
        triggerFocus.focus();
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (!options.length) return;
        if (e.key === "down") {
          this.selectHighlight = (this.selectHighlight + 1) % options.length;
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "up") {
          this.selectHighlight = (this.selectHighlight + options.length - 1) % options.length;
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "enter") {
          const opt = options[this.selectHighlight] ?? options[0];
          if (opt) onPick(opt.value);
          this.openSelect = null;
          this._selectDismissedAt = null;
          triggerFocus.focus();
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "escape") {
          this.openSelect = null;
          this._selectDismissedAt = null;
          triggerFocus.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .children(
        options.map((opt, idx) => {
          const active = String(opt.value) === String(currentVal);
          const highlighted = idx === this.selectHighlight;
          return h_flex()
            .id(`dlg-sel-opt-${key}-${idx}`)
            .role("menu_list_option")
            .when(highlighted, (el) => el.aria_active_descendant())
            .px(8)
            .py(6)
            .rounded(6)
            .items_center()
            .justify_between()
            .cursor_pointer()
            .when(active || highlighted, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              onPick(opt.value);
              this.openSelect = null;
              this._selectDismissedAt = null;
              triggerFocus.focus();
              cx.notify();
            })
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(opt.label))
            .when(active, (el) => el.child(div().text_size(11).text_color(t.accent).child("✓")));
        }),
      );

    return v_flex()
      .gap(5)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
      .child(
        Select.new(`dlg-sel-${key}`)
          .accessibility_label(label)
          .open(isOpen)
          .track_focus(triggerFocus)
          .content_focus_handle(listFocus)
          .on_open_change((open, cx) => {
            this.openSelect = open ? key : null;
            this.selectHighlight = Math.max(
              0,
              options.findIndex((o) => String(o.value) === String(currentVal)),
            );
            cx.notify();
          })
          .on_confirm((_e, cx) => {
            const opt = options[this.selectHighlight];
            if (opt) onPick(opt.value);
            this.openSelect = null;
            cx.notify();
          })
          .on_dismiss((_e, cx) => {
            this.openSelect = null;
            cx.notify();
          })
          .child(Popup.new(`dlg-pop-${key}`, trigger).anchor("bottom_left").when(isOpen, (el) => el.content(list))),
      );
  }

  renderBtn(t, id, label, onClick, { primary = false, danger = false, disabled = false } = {}) {
    const bg = primary ? t.solid : danger ? alpha(t.ansi1, "24") : t.raised;
    const fg = primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground;
    const border = primary ? t.solid : danger ? alpha(t.ansi1, "66") : t.input;
    return Button.new(id)
      .h(32)
      .px(14)
      .flex()
      .items_center()
      .justify_center()
      .rounded(7)
      .border_1()
      .border_color(border)
      .bg(bg)
      .text_size(12.5)
      .font_medium()
      .text_color(fg)
      .disabled(disabled)
      .when(disabled, (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((e, cx) => {
        if (!disabled) onClick(e, cx);
      })
      .child(label);
  }

  renderEnqueue(t) {
    return v_flex()
      .gap(12)
      .when(Boolean(this.item?.isBlocked), (el) =>
        el.child(
          div()
            .p(8)
            .rounded(7)
            .bg(alpha(t.blocked || t.ansi3, "18"))
            .border_1()
            .border_color(alpha(t.blocked || t.ansi3, "55"))
            .text_size(11.5)
            .text_color(t.blocked || t.ansi3)
            .child("This bead has open blockers. Queue will wait until they are unblocked; Dispatch Now is disabled."),
        ),
      )
      .when(Boolean(this.item), (el) =>
        el.child(
          v_flex()
            .p(10)
            .gap(3)
            .rounded(8)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .child(div().text_size(11).text_color(t.accent).child(this.item.beadId || this.item.id))
            .child(div().text_size(13).font_medium().text_color(t.foreground).child(this.item.title ?? "")),
        ),
      )
      .child(this.renderSelect(t, "formula", "Formula", this.formulaOptions(), this.formula, (v) => (this.formula = v)))
      .child(this.renderSelect(t, "env", "Environment", this.envOptions(), this.env, (v) => (this.env = v)))
      .when(this.item?.bdStatus === "deferred", (el) =>
        el.child(
          v_flex()
            .gap(3)
            .child(
              Checkbox.new("dlg-wake-deferred")
                .checked(this.wakeDeferred)
                .on_change((checked, cx) => {
                  this.wakeDeferred = Boolean(checked);
                  cx.notify();
                })
                .flex()
                .items_center()
                .gap(8)
                .cursor_pointer()
                .child(div().size(16).rounded(4).border_1().border_color(this.wakeDeferred ? t.accent : t.input).bg(this.wakeDeferred ? t.accent : t.background).text_size(11).text_color(t.accent_foreground).child(this.wakeDeferred ? "✓" : ""))
                .child(div().text_size(12).text_color(t.foreground).child("Wake deferred bead (set open & clear defer)")),
            )
            .child(div().pl(24).text_size(11).text_color(t.dim).child("The bead becomes eligible for bd ready and the next roscaelifer intake.")),
        ),
      );
  }

  renderCreate(t) {
    const candidateItems = this.items.filter((it) => it.beadId && it.bdStatus !== "closed").slice(0, 40);
    const blockOptions = [
      { value: "", label: "(none — pick an existing bead to block)" },
      ...candidateItems.map((it) => ({ value: it.beadId, label: `${it.beadId} · ${it.title}` })),
    ];

    return v_flex()
      .gap(12)
      .when(this.hasBd === false, (el) =>
        el.child(
          h_flex()
            .p(8)
            .gap(8)
            .items_center()
            .justify_between()
            .rounded(7)
            .bg(alpha(t.blocked || t.ansi3, "18"))
            .border_1()
            .border_color(alpha(t.blocked || t.ansi3, "55"))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(11.5)
                .text_color(t.blocked || t.ansi3)
                .child("No .beads directory in this project. Switch to WIP Card for standalone tasks."),
            )
            .child(
              this.renderBtn(t, "dlg-switch-to-wip", "Switch to WIP Card", (_e, cx) => {
                this.dialogType = "create-wip";
                this.error = null;
                cx.notify();
              }),
            ),
        ),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Title *"))
          .child(
            Input.new(this.titleInput)
              .h(34)
              .px(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "title" ? t.accent : t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          ),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Description"))
          .child(
            Textarea.new(this.descInput)
              .w_full()
              .h(110)
              .p(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "desc" ? t.accent : t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .child(div().flex_1().child(this.renderSelect(t, "priority", "Priority", PRIORITIES, this.priority, (v) => (this.priority = Number(v)))))
          .child(div().flex_1().child(this.renderSelect(t, "type", "Type", ISSUE_TYPES, this.issueType, (v) => (this.issueType = v)))),
      )
      .child(
        h_flex()
          .gap(10)
          .child(div().flex_1().child(this.renderSelect(t, "formula", "Formula", this.formulaOptions(), this.formula, (v) => (this.formula = v))))
          .child(div().flex_1().child(this.renderSelect(t, "env", "Environment", this.envOptions(), this.env, (v) => (this.env = v)))),
      )
      .child(
        v_flex()
          .gap(6)
          .child(
            this.renderSelect(t, "blocks", "Blocks Dependency (optional)", blockOptions, this.blocksSelected[0] ?? "", (v) => {
              if (!v) return;
              if (!this.blocksSelected.includes(v)) this.blocksSelected.push(v);
            }),
          )
          .when(this.blocksSelected.length > 0, (el) =>
            el.child(
              h_flex()
                .gap(6)
                .flex_wrap()
                .children(
                  this.blocksSelected.map((id) =>
                    h_flex()
                      .id(`dlg-blk-chip-${id}`)
                      .px(7)
                      .py(3)
                      .gap(5)
                      .items_center()
                      .rounded(5)
                      .bg(t.raised)
                      .border_1()
                      .border_color(t.border)
                      .text_size(11.5)
                      .child(div().text_color(t.accent).child(`blocks ${id}`))
                      .child(
                        div()
                          .id(`dlg-blk-rm-${id}`)
                          .cursor_pointer()
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click((_e, cx) => {
                            this.blocksSelected = this.blocksSelected.filter((x) => x !== id);
                            cx.notify();
                          })
                          .child("×"),
                      ),
                  ),
                ),
            ),
          )
          .child(
            Input.new(this.blocksInput)
              .h(30)
              .px(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "blocks" ? t.accent : t.border)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground),
          ),
      )
      .child(
        Checkbox.new("dlg-enqueue-now")
          .checked(this.enqueueNow)
          .on_change((checked, cx) => {
            this.enqueueNow = checked;
            cx.notify();
          })
          .flex()
          .items_center()
          .gap(8)
          .cursor_pointer()
          .child(
            div()
              .size(16)
              .rounded(4)
              .border_1()
              .border_color(this.enqueueNow ? t.accent : t.input)
              .bg(this.enqueueNow ? t.accent : t.background)
              .flex()
              .items_center()
              .justify_center()
              .text_size(11)
              .text_color(t.accent_foreground)
              .child(this.enqueueNow ? "✓" : ""),
          )
          .child(div().text_size(12.5).text_color(t.foreground).child("Enqueue immediately (add roscaelifer label)")),
      );
  }

  renderCreateWip(t) {
    const activeMcps = new Set(
      this.mcpInput
        .value()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const modeNote =
      this.hasBd === true
        ? "Creates an ephemeral WIP bead (roscaelifer, wip, formula) and ensures the runner."
        : this.hasBd === false
          ? "No .beads directory — creates a standalone roscaelifer WIP task and ensures the runner."
          : "Detecting project .beads / standalone WIP mode…";

    return v_flex()
      .gap(12)
      .child(
        div()
          .px(10)
          .py(7)
          .rounded(7)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .text_size(11.5)
          .text_color(t.muted)
          .child(modeNote),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Title *"))
          .child(
            Input.new(this.titleInput)
              .h(34)
              .px(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "title" ? t.accent : t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          ),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Task / Description"))
          .child(
            Textarea.new(this.descInput)
              .w_full()
              .h(110)
              .p(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "desc" ? t.accent : t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .child(
            div()
              .flex_1()
              .child(
                this.renderSelect(
                  t,
                  "formula",
                  "Worker Formula",
                  this.wipFormulaOptions(),
                  this.wipFormula,
                  (v) => (this.wipFormula = v),
                ),
              ),
          )
          .child(
            div()
              .flex_1()
              .child(
                this.renderSelect(
                  t,
                  "model",
                  "Model",
                  WIP_MODELS,
                  this.model,
                  (v) => (this.model = v),
                ),
              ),
          ),
      )
      .child(
        h_flex()
          .gap(10)
          .child(
            div()
              .flex_1()
              .child(
                this.renderSelect(
                  t,
                  "env",
                  "Environment",
                  this.envOptions(),
                  this.env,
                  (v) => (this.env = v),
                ),
              ),
          )
          .when(this.hasBd !== false, (el) =>
            el.child(
              div()
                .flex_1()
                .child(
                  this.renderSelect(
                    t,
                    "priority",
                    "Priority",
                    PRIORITIES,
                    this.priority,
                    (v) => (this.priority = Number(v)),
                  ),
                ),
            ),
          ),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Working Directory (cwd, optional)"))
          .child(
            h_flex()
              .gap(6)
              .child(
                Input.new(this.cwdInput)
                  .flex_1()
                  .h(32)
                  .px(10)
                  .rounded(7)
                  .border_1()
                  .border_color(this.focusedField === "cwd" ? t.accent : t.input)
                  .bg(t.background)
                  .text_size(12)
                  .text_color(t.foreground),
              )
              .when(!this.ctx?.machine, (el) =>
                el.child(
                  this.renderBtn(t, "dlg-wip-pick-cwd", "Browse…", (_e, cx) => {
                    cx.spawn(async (pickCx) => {
                      const folder = await pickFolder({ prompt: "Select Worker Working Directory" });
                      if (folder) {
                        this.cwdInput.set_value(folder);
                        pickCx.notify();
                      }
                    });
                  }),
                ),
              ),
          ),
      )
      .child(
        v_flex()
          .gap(6)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("MCP Profile (optional)"))
          .child(
            Input.new(this.mcpInput)
              .h(32)
              .px(10)
              .rounded(7)
              .border_1()
              .border_color(this.focusedField === "mcp" ? t.accent : t.input)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(11).text_color(t.dim).child("Presets:"))
              .children(
                MCP_PROFILE_PRESETS.map((preset) => {
                  const active = activeMcps.has(preset);
                  return div()
                    .id(`dlg-mcp-preset-${preset}`)
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .border_1()
                    .border_color(active ? t.accent : t.border)
                    .bg(active ? alpha(t.accent, "22") : t.raised)
                    .text_size(11)
                    .text_color(active ? t.accent : t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.toggleMcpProfile(preset, cx))
                    .child(preset);
                }),
              ),
          ),
      );
  }

  renderReject(t) {
    return v_flex()
      .gap(12)
      .when(Boolean(this.item), (el) =>
        el.child(
          v_flex()
            .p(10)
            .gap(3)
            .rounded(8)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .child(div().text_size(11).text_color(t.blocked).child(`Rejecting review · ${this.item.beadId || this.item.id}`))
            .child(div().text_size(13).font_medium().text_color(t.foreground).child(this.item.title ?? "")),
        ),
      )
      .child(
        v_flex()
          .gap(5)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Review Feedback * (appended as bd note & reopens bead)"))
          .child(
            Textarea.new(this.feedbackInput)
              .w_full()
              .h(140)
              .p(10)
              .rounded(7)
              .border_1()
              .border_color(this.feedbackFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground),
          ),
      );
  }

  renderCleanPreview(t) {
    if (this.loadingPreview) {
      return div().py(16).text_size(12.5).text_color(t.muted).child("Scanning pending terminals and worktrees (clean --dry-run)…");
    }
    const p = this.preview ?? { actions: [], errors: [], empty: true };
    return v_flex()
      .gap(10)
      .when(p.empty, (el) =>
        el.child(div().p(12).rounded(8).bg(t.background).border_1().border_color(t.border).text_size(12.5).text_color(t.muted).child("Nothing pending to clean.")),
      )
      .when(p.actions.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(6)
            .children(
              p.actions.map((act, idx) => {
                const ops = [];
                if (act.kill_terminal) ops.push("kill terminal");
                if (act.remove_terminal) ops.push("remove terminal");
                if (act.remove_worktree) ops.push("remove worktree");
                if (act.delete_sidecar) ops.push("delete sidecar");
                const kind = ops.length > 0 ? ops.join(" + ") : act.kind || act.action || act.type || "cleanup";
                const sharedNotes = [];
                if (act.shared_terminal) sharedNotes.push("shared terminal kept");
                if (act.shared_worktree) sharedNotes.push("shared worktree kept");
                const target =
                  [act.task_id && act.step_id ? `${act.task_id}/${act.step_id}` : act.task_id || act.step_id, act.hc_address || act.pane_id || act.worktree || act.sidecar_file || act.path || act.target || act.marker]
                    .filter(Boolean)
                    .join(" · ");
                const detail = [act.env, act.branch, act.session, act.worktree && act.hc_address ? act.worktree : null, act.detail, act.reason, ...sharedNotes]
                  .filter(Boolean)
                  .join(" · ");
                return v_flex()
                  .id(`dlg-clean-act-${idx}`)
                  .p(8)
                  .gap(3)
                  .rounded(7)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .gap(8)
                      .child(div().text_size(11.5).font_semibold().text_color(kind.includes("kill") || kind.includes("remove") ? t.ansi1 : t.blocked).child(kind))
                      .when(Boolean(act.skipped || act.kept || sharedNotes.length > 0), (c) => c.child(div().text_size(11).text_color(t.dim).child("shared / kept"))),
                  )
                  .when(Boolean(target), (c) => c.child(div().text_size(12).text_color(t.foreground).child(String(target))))
                  .when(Boolean(detail), (c) => c.child(div().text_size(11).text_color(t.dim).child(detail)));
              }),
            ),
        ),
      )
      .when(p.errors.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .children(p.errors.map((err) => div().p(8).rounded(6).bg(alpha(t.ansi1, "18")).text_size(11.5).text_color(t.ansi1).child(String(err)))),
        ),
      )
      .child(
        h_flex()
          .justify_start()
          .child(this.renderBtn(t, "dlg-clean-refresh", "Re-scan", (_e, cx) => this.loadCleanPreview(cx), { disabled: this.busy || this.loadingPreview })),
      );
  }

  hasContextPaths(ctx = this.ctx) {
    return Boolean(ctx && (ctx.repo || ctx.db || ctx.bdDir || ctx.config || ctx.formulasDir));
  }

  resolveProjectForForm() {
    const projects = Array.isArray(this.projectsConfig?.projects) ? this.projectsConfig.projects : [];
    const active = projects.find((project) => project.id === this.projectsConfig.activeProject);
    if (active) return active;
    const ctxProjectId = this.ctx?.projectId;
    if (ctxProjectId) {
      const byId = projects.find((project) => project.id === ctxProjectId || project.projectId === ctxProjectId);
      if (byId) return byId;
    }
    if (this.hasContextPaths()) {
      const ctxKey = repoIdentityKey(this.ctx);
      const byIdentity = projects.find((project) => repoIdentityKey(project) === ctxKey);
      if (byIdentity) return byIdentity;
      return this.ctx;
    }
    return null;
  }

  setProjectForm(project, markTouched = true) {
    const value = project || {};
    this.editingProjectId = value.id || value.projectId || null;
    const repo = value.repo || "";
    const base = String(repo || value.bdDir || value.db || value.config || value.formulasDir || "").replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    this.autoProjectName = base;
    this.projectNameInput.set_value(value.name || base);
    this.repoInput.set_value(repo);
    this.machineInput.set_value(value.machine || "");
    this.dbInput.set_value(value.db || "");
    this.bdDirInput.set_value(value.bdDir || "");
    this.configInput.set_value(value.config || "");
    this.formulasDirInput.set_value(value.formulasDir || "");
    this.binInput.set_value(value.bin || "");
    this.envInput.set_value(value.env || "");
    this.projectFormTouched = markTouched;
  }

  clearProjectForm(cx) {
    this.setProjectForm(null, false);
    this.editingProjectId = null;
    this.projectNameInput.focus();
    cx?.notify?.();
  }

  updateProjectRoot(folder) {
    const previous = this.repoInput.value().trim();
    const derived = [
      [this.dbInput, `${previous}/.roscaelifer/roscaelifer.db`, `${folder}/.roscaelifer/roscaelifer.db`],
      [this.bdDirInput, `${previous}/.beads`, `${folder}/.beads`],
      [this.configInput, `${previous}/roscaelifer.toml`, `${folder}/roscaelifer.toml`],
    ];
    const currentName = this.projectNameInput.value().trim();
    const nextName = String(folder).replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    this.repoInput.set_value(folder);
    if (!currentName || currentName === this.autoProjectName) this.projectNameInput.set_value(nextName);
    this.autoProjectName = nextName;
    for (const [input, oldDefault, nextDefault] of derived) {
      if (!input.value().trim() || input.value().trim() === oldDefault) input.set_value(nextDefault);
    }
    const formulasValue = this.formulasDirInput.value().trim();
    const oldFormulas = [`${previous}/formulas`, `${previous}/.roscaelifer/formulas`];
    if (!formulasValue || oldFormulas.includes(formulasValue)) {
      this.formulasDirInput.set_value(
        formulasValue === oldFormulas[1] ? `${folder}/.roscaelifer/formulas` : `${folder}/formulas`,
      );
    }
    this.projectFormTouched = true;
  }

  applyDetectedProject(detected) {
    const value = detected && typeof detected === "object" ? detected : {};
    // Detection is authoritative: it must also repair stale db/formulasDir values
    // on an already saved project, so do not run updateProjectRoot() first.
    const nextRepo = typeof value.repo === "string" ? value.repo.trim() : "";
    if (nextRepo) this.repoInput.set_value(nextRepo);

    const fill = (input, detectedValue) => {
      const text = typeof detectedValue === "string" ? detectedValue.trim() : "";
      if (text) input.set_value(text);
    };
    fill(this.machineInput, value.machine);
    fill(this.dbInput, value.db);
    fill(this.bdDirInput, value.bdDir);
    fill(this.configInput, value.config);
    fill(this.formulasDirInput, value.formulasDir);
    fill(this.binInput, value.bin);
    if (!this.envInput.value().trim()) fill(this.envInput, value.env);

    const detectedName = String(value.name || "").trim()
      || nextRepo.replace(/\/+$/, "").split("/").filter(Boolean).pop()
      || "";
    const currentName = this.projectNameInput.value().trim();
    if (!currentName || currentName === this.autoProjectName) {
      if (detectedName) this.projectNameInput.set_value(detectedName);
      this.autoProjectName = detectedName;
    }
    this.projectFormTouched = true;
  }

  detectProject(cx) {
    if (this.busy) return;
    const currentRepo = this.repoInput.value().trim();
    const currentMachine = this.machineInput.value().trim();
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (detectCx) => {
      try {
        const detected = currentRepo
          ? await detectRepoFromPath(currentRepo, currentMachine)
          : await detectCurrentWorkspaceProject({ focusedInfo: focused(), spaceList: spaces(), paneList: panes() });
        if (!detected) {
          this.error = currentRepo
            ? `No roscaelifer project detected at ${currentRepo}.`
            : "No roscaelifer project detected in the focused workspace.";
          return;
        }
        this.applyDetectedProject(detected);
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.busy = false;
        detectCx.notify();
      }
    });
  }

  deleteProject(cx) {
    if (!this.editingProjectId || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (deleteCx) => {
      try {
        const result = await deleteGlobalProject(this.editingProjectId);
        this.projectsConfig = result.config;
        if (result.wasActive) {
          clearActiveProjectMirror();
          setShared("roscaelifer.ctxOverride", { __autoDetect: true, ts: Date.now() });
          setShared("roscaelifer.refresh", Date.now());
        }
        const next = this.projectsConfig.projects[0] || null;
        this.setProjectForm(next, false);
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.busy = false;
        deleteCx.notify();
      }
    });
  }

  useAutoDetect(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (autoCx) => {
      try {
        const config = await loadGlobalProjectsConfig();
        config.activeProject = "";
        await saveGlobalProjectsConfig(config);
        clearActiveProjectMirror();
        setShared("roscaelifer.ctxOverride", { __autoDetect: true, ts: Date.now() });
        setShared("roscaelifer.refresh", Date.now());
        this.close();
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.busy = false;
        autoCx.notify();
      }
    });
  }

  renderProjectConfig(t) {
    const fieldRow = (name, label, inputState, pickable = false) =>
      v_flex()
        .gap(4)
        .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
        .child(
          h_flex()
            .gap(6)
            .child(Input.new(inputState).flex_1().h(32).px(10).rounded(7).border_1().border_color(this.focusedField === name ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground))
            .when(pickable, (el) => el.child(this.renderBtn(t, `dlg-pick-${name}`, "Browse…", (_e, cx) => {
              if (this.busy) return;
              cx.spawn(async (pickCx) => {
                const folder = await pickFolder({ prompt: `Select ${label}` });
                if (!folder) {
                  pickCx.notify();
                  return;
                }
                if (name !== "repo") {
                  inputState.set_value(folder);
                  pickCx.notify();
                  return;
                }
                this.busy = true;
                this.error = null;
                pickCx.notify();
                try {
                  const detected = await detectRepoFromPath(folder, this.machineInput.value().trim());
                  if (detected) this.applyDetectedProject(detected);
                  else this.updateProjectRoot(folder);
                } catch {
                  this.updateProjectRoot(folder);
                } finally {
                  this.busy = false;
                  pickCx.notify();
                }
              });
            }))),
        );

    const projects = Array.isArray(this.projectsConfig?.projects) ? this.projectsConfig.projects : [];
    const counts = new Map();
    for (const project of projects) counts.set(project.name, (counts.get(project.name) || 0) + 1);
    const projectLabel = (project) => {
      if ((counts.get(project.name) || 0) < 2) return project.name;
      const base = project.repo || project.bdDir || project.db || project.config || "";
      const parent = base.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2, -1)[0] || "project";
      return project.machine ? `${project.name} @${project.machine}` : `${project.name} · ${parent}`;
    };
    return v_flex()
      .gap(10)
      .child(div().text_size(12).text_color(t.dim).child("Manage saved projects (~/.config/roscaelifer/projects.json) or switch the active project."))
      .child(
        h_flex().items_center().justify_between()
          .child(div().text_size(12).font_medium().text_color(t.foreground).child("Saved Projects"))
          .child(h_flex().gap(6)
            .child(this.renderBtn(t, "dlg-new-project", "+ New Project", (_e, cx) => this.clearProjectForm(cx)))
            .child(this.renderBtn(t, "dlg-auto-detect", "Auto-Detect", (_e, cx) => this.detectProject(cx)))),
      )
      .when(projects.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(projects.map((project) => {
        const active = project.id === this.projectsConfig.activeProject;
        const selected = project.id === this.editingProjectId;
        return div().id(`dlg-project-${project.id}`).px(8).py(5).rounded(6).border_1().border_color(active || selected ? t.accent : t.border).bg(active ? t.selected : t.raised).text_size(11.5).text_color(t.foreground).font_medium().cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.setProjectForm(project, false); cx.notify(); }).child(`${active ? "• " : ""}${projectLabel(project)}`);
      }))))
      .child(fieldRow("name", "Project Name", this.projectNameInput))
      .child(fieldRow("repo", "Project Root (optional)", this.repoInput, true))
      .child(fieldRow("machine", "Machine (blank = local)", this.machineInput))
      .child(fieldRow("db", "Roscaelifer DB Path (--db)", this.dbInput))
      .child(fieldRow("bdDir", "Beads Directory (.beads)", this.bdDirInput, true))
      .child(fieldRow("config", "Herdr Env Config (roscaelifer.toml)", this.configInput))
      .child(fieldRow("formulasDir", "Formulas Directory", this.formulasDirInput, true))
      .child(fieldRow("bin", "roscaelifer Binary", this.binInput))
      .child(fieldRow("env", "Default Env (optional)", this.envInput));
  }

  render(_cx) {
    const t = theme();
    const ct = this.cleanTarget();
    const cleanLabel = ct.taskId ? (ct.stepId ? `${ct.taskId}/${ct.stepId}` : String(ct.taskId)) : null;
    const titles = {
      enqueue: "Queue / Dispatch Bead",
      create: "New Bead",
      "create-wip": "New WIP Card",
      reject: "Reject Review",
      "clean-preview": cleanLabel ? `Clean Preview · ${cleanLabel}` : "Clean Pending Resources",
      "project-config": "Project Configuration",
      "repo-config": "Project Configuration",
    };
    const confirmLabels = {
      enqueue: this.busy ? "Working…" : "Dispatch Now",
      create: this.busy ? "Creating…" : "Create Bead",
      "create-wip": this.busy ? "Creating…" : "Create & Run",
      reject: this.busy ? "Rejecting…" : "Reject & Reopen",
      "clean-preview": this.busy ? "Cleaning…" : "Confirm Clean",
      "project-config": this.busy ? "Saving…" : (this.editingProjectId ? "Save & Activate" : "Create & Activate"),
      "repo-config": this.busy ? "Saving…" : (this.editingProjectId ? "Save & Activate" : "Create & Activate"),
    };

    const canSubmit =
      !this.busy &&
      (this.dialogType !== "reject" || Boolean(this.feedbackInput.value().trim())) &&
      ((this.dialogType !== "create" && this.dialogType !== "create-wip") || Boolean(this.titleInput.value().trim())) &&
      (this.dialogType !== "clean-preview" || (!this.loadingPreview && Boolean(this.preview && !this.preview.empty)));

    return v_flex()
      .id(`roscaelifer-dialog-${this.dialogType}`)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.openSelect) {
            this.openSelect = null;
            cx.notify();
          } else {
            this.close();
          }
          cx.stop_propagation();
        }
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(14)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      // Title bar
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .justify_between()
          .child(div().text_size(15.5).font_semibold().child(titles[this.dialogType] ?? "Dialog"))
          .child(
            div()
              .id("dlg-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      // Scrollable form body
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("dlg-body-scroll")
              .track_scroll(this.scroll)
              .size_full()
              .overflow_y_scroll()
              .pr(6)
              .when(this.dialogType === "enqueue", (el) => el.child(this.renderEnqueue(t)))
              .when(this.dialogType === "create", (el) => el.child(this.renderCreate(t)))
              .when(this.dialogType === "create-wip", (el) => el.child(this.renderCreateWip(t)))
              .when(this.dialogType === "reject", (el) => el.child(this.renderReject(t)))
              .when(this.dialogType === "clean-preview", (el) => el.child(this.renderCleanPreview(t)))
              .when(this.dialogType === "repo-config" || this.dialogType === "project-config", (el) => el.child(this.renderProjectConfig(t))),
          )
          .child(Scrollbar.vertical("dlg-body-scroll").absolute().inset_0()),
      )
      // Error line
      .when(Boolean(this.error), (el) =>
        el.child(div().flex_none().p(8).rounded(6).bg(alpha(t.ansi1, "18")).border_1().border_color(alpha(t.ansi1, "44")).text_size(12).text_color(t.ansi1).child(this.error)),
      )
      // Footer buttons
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            this.dialogType === "repo-config" || this.dialogType === "project-config"
              ? h_flex()
                  .gap(6)
                  .child(this.renderBtn(t, "dlg-auto-project", "Use Auto-Detect", (_e, cx) => this.useAutoDetect(cx), { disabled: this.busy }))
                  .when(Boolean(this.editingProjectId), (el) => el.child(this.renderBtn(t, "dlg-delete-project", "Delete", (_e, cx) => this.deleteProject(cx), { danger: true, disabled: this.busy })))
              : div(),
          )
          .child(
            h_flex()
              .gap(8)
              .child(this.renderBtn(t, "dlg-cancel", "Cancel", () => this.close()))
              .when(this.dialogType === "enqueue", (el) =>
                el.child(this.renderBtn(t, "dlg-queue", this.busy ? "Working…" : "Queue", (_e, cx) => this.submit(cx, false), { disabled: !canSubmit })),
              )
              .child(
                this.renderBtn(t, "dlg-confirm", confirmLabels[this.dialogType] ?? "Confirm", (_e, cx) => this.submit(cx, this.dialogType === "enqueue"), {
                  primary: this.dialogType !== "reject" && this.dialogType !== "clean-preview",
                  danger: this.dialogType === "reject" || this.dialogType === "clean-preview",
                  disabled: !canSubmit || (this.dialogType === "enqueue" && Boolean(this.item?.isBlocked)),
                }),
              ),
          ),
      );
  }
}

export const DialogHandler = DialogController;
