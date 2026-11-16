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
import { closeOverlay, pickFolder, props, setShared, theme } from "herdr";
import { createActions } from "./actions.js";
import { clearActiveRepo } from "./store.js";

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
    this.selectHighlight = 0;
    this.selectFocus = {};
    this.listFocus = {};
    for (const key of ["formula", "env", "priority", "type", "blocks"]) {
      this.selectFocus[key] = cx.focus_handle();
      this.listFocus[key] = cx.focus_handle();
    }

    // Dialog-specific state
    const formulaDefault = this.item?.formula || this.formulas[0]?.name || this.formulas[0] || "";
    const envDefault = this.item?.env || "";

    if (this.dialogType === "enqueue") {
      this.formula = typeof formulaDefault === "string" ? formulaDefault : "";
      this.env = typeof envDefault === "string" ? envDefault : "";
      this.handle.focus();
    } else if (this.dialogType === "create") {
      this.titleInput = InputState.new({ placeholder: "Short actionable bead title" });
      this.descInput = TextareaState.new({ placeholder: "Description, context, acceptance criteria…", rows: 5 });
      this.blocksInput = InputState.new({ placeholder: "Optional bead ID(s), e.g. rsc-123" });
      this.priority = 2;
      this.issueType = "task";
      this.formula = typeof formulaDefault === "string" ? formulaDefault : "";
      this.env = "";
      this.blocksSelected = [];
      this.enqueueNow = true;
      this.focusedField = null;

      this.titleInput.on("change", (_e, cx) => {
        this.error = null;
        cx.notify();
      });
      this.titleInput.on("focus", (_e, cx) => {
        this.focusedField = "title";
        cx.notify();
      });
      this.titleInput.on("blur", (_e, cx) => {
        if (this.focusedField === "title") this.focusedField = null;
        cx.notify();
      });
      this.descInput.on("focus", (_e, cx) => {
        this.focusedField = "desc";
        cx.notify();
      });
      this.descInput.on("blur", (_e, cx) => {
        if (this.focusedField === "desc") this.focusedField = null;
        cx.notify();
      });
      this.blocksInput.on("focus", (_e, cx) => {
        this.focusedField = "blocks";
        cx.notify();
      });
      this.blocksInput.on("blur", (_e, cx) => {
        if (this.focusedField === "blocks") this.focusedField = null;
        cx.notify();
      });

      this.titleInput.focus();
      cx.timer.after(120, () => this.titleInput.focus());
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
    } else if (this.dialogType === "repo-config") {
      this.repoInput = InputState.new({ value: this.ctx.repo ?? "", placeholder: "/path/to/repo" });
      this.machineInput = InputState.new({ value: this.ctx.machine ?? "", placeholder: "remote machine (optional)" });
      this.dbInput = InputState.new({ value: this.ctx.db ?? "", placeholder: ".roscaelifer/roscaelifer.db" });
      this.bdDirInput = InputState.new({ value: this.ctx.bdDir ?? "", placeholder: "/path/to/repo/.beads" });
      this.configInput = InputState.new({ value: this.ctx.config ?? "", placeholder: "roscaelifer.toml" });
      this.formulasDirInput = InputState.new({ value: this.ctx.formulasDir ?? "", placeholder: "formulas" });
      this.binInput = InputState.new({ value: this.ctx.bin ?? "", placeholder: "roscaelifer-herdr (optional override)" });
      this.focusedField = "repo";
      for (const [name, st] of [
        ["repo", this.repoInput],
        ["machine", this.machineInput],
        ["db", this.dbInput],
        ["bdDir", this.bdDirInput],
        ["config", this.configInput],
        ["formulasDir", this.formulasDirInput],
        ["bin", this.binInput],
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
      this.repoInput.focus();
      cx.timer.after(120, () => this.repoInput.focus());
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

  submit(cx) {
    if (this.busy) return;
    if (this.dialogType === "enqueue") {
      const beadId = this.item?.beadId || this.item?.id;
      if (!beadId) {
        this.error = "Missing bead ID.";
        cx.notify();
        return;
      }
      this.runMutation(cx, () =>
        this.actions.enqueueBead(beadId, {
          formula: this.formula || undefined,
          env: this.env || undefined,
          currentLabels: this.item?.labels || [],
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

    if (this.dialogType === "repo-config") {
      const nextCtx = {
        repo: this.repoInput.value().trim(),
        machine: this.machineInput.value().trim(),
        db: this.dbInput.value().trim(),
        bdDir: this.bdDirInput.value().trim(),
        config: this.configInput.value().trim(),
        formulasDir: this.formulasDirInput.value().trim(),
        bin: this.binInput.value().trim(),
        updatedAt: Date.now(),
      };
      setShared("roscaelifer.ctxOverride", nextCtx);
      setShared("roscaelifer.refresh", Date.now());
      this.close();
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
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "escape") {
          this.openSelect = null;
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
      .child(this.renderSelect(t, "env", "Environment", this.envOptions(), this.env, (v) => (this.env = v)));
  }

  renderCreate(t) {
    const candidateItems = this.items.filter((it) => it.beadId && it.bdStatus !== "closed").slice(0, 40);
    const blockOptions = [
      { value: "", label: "(none — pick an existing bead to block)" },
      ...candidateItems.map((it) => ({ value: it.beadId, label: `${it.beadId} · ${it.title}` })),
    ];

    return v_flex()
      .gap(12)
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

  renderRepoConfig(t) {
    const updateRepoPaths = (folder) => {
      const prevRepo = this.repoInput.value().trim();
      const derived = [
        [this.dbInput, `${prevRepo}/.roscaelifer/roscaelifer.db`, `${folder}/.roscaelifer/roscaelifer.db`],
        [this.bdDirInput, `${prevRepo}/.beads`, `${folder}/.beads`],
        [this.configInput, `${prevRepo}/roscaelifer.toml`, `${folder}/roscaelifer.toml`],
        [this.formulasDirInput, `${prevRepo}/formulas`, `${folder}/formulas`],
      ];
      this.repoInput.set_value(folder);
      for (const [input, oldDefault, nextDefault] of derived) {
        const current = input.value().trim();
        if (!current || current === oldDefault) {
          input.set_value(nextDefault);
        }
      }
    };

    const fieldRow = (name, label, inputState, pickable = false) =>
      v_flex()
        .gap(4)
        .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
        .child(
          h_flex()
            .gap(6)
            .child(
              Input.new(inputState)
                .flex_1()
                .h(32)
                .px(10)
                .rounded(7)
                .border_1()
                .border_color(this.focusedField === name ? t.accent : t.input)
                .bg(t.background)
                .text_size(12)
                .text_color(t.foreground),
            )
            .when(pickable, (el) =>
              el.child(
                this.renderBtn(t, `dlg-pick-${name}`, "Browse…", (_e, cx) => {
                  cx.spawn(async (cx) => {
                    const folder = await pickFolder({ prompt: `Select ${label}` });
                    if (folder) {
                      if (name === "repo") {
                        updateRepoPaths(folder);
                      } else {
                        inputState.set_value(folder);
                      }
                      cx.notify();
                    }
                  });
                }),
              ),
            ),
        );

    const history = Array.isArray(this.p.history) ? this.p.history : [];
    const historyLabels = history.map((h, idx) => h.label || h.repo || h.db || `Repo ${idx + 1}`);
    const labelCounts = new Map();
    for (const label of historyLabels) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    const displayHistoryLabel = (h, idx) => {
      const label = historyLabels[idx];
      if ((labelCounts.get(label) || 0) < 2) return label;
      const base = h.repo || h.bdDir || h.db || "";
      const parent = base.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2, -1)[0] || "repo";
      return h.machine ? `${label} @${h.machine}` : `${label} · ${parent}`;
    };
    const currentRepo = this.repoInput.value().trim();
    const currentMachine = normalizeMachine(this.machineInput.value());
    const currentDB = this.dbInput.value().trim();
    const currentBDDir = this.bdDirInput.value().trim();
    return v_flex()
      .gap(10)
      .child(div().text_size(12).text_color(t.dim).child("Override auto-detected repository paths for this mod view."))
      .when(history.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .child(div().text_size(11).font_medium().text_color(t.dim).child("Recent Repositories"))
            .child(
              h_flex()
                .gap(6)
                .flex_wrap()
                .children(
                  history.slice(0, 6).map((h, idx) => {
                    const active =
                      normalizeMachine(h.machine) === currentMachine &&
                      ((h.repo && String(h.repo).trim() === currentRepo) ||
                        (h.db && String(h.db).trim() === currentDB) ||
                        (h.bdDir && String(h.bdDir).trim() === currentBDDir));
                    return div()
                      .id(`dlg-hist-${idx}`)
                      .px(8)
                      .py(4)
                      .rounded(5)
                      .border_1()
                      .border_color(active ? t.accent : t.border)
                      .bg(active ? t.selected : t.raised)
                      .text_size(11.5)
                      .text_color(t.foreground)
                      .font_medium()
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        this.repoInput.set_value(h.repo || "");
                        this.machineInput.set_value(h.machine || "");
                        this.dbInput.set_value(h.db || "");
                        this.bdDirInput.set_value(h.bdDir || "");
                        this.configInput.set_value(h.config || "");
                        this.formulasDirInput.set_value(h.formulasDir || "");
                        this.binInput.set_value(h.bin || "");
                        cx.notify();
                      })
                      .child(displayHistoryLabel(h, idx));
                  }),
                ),
            ),
        ),
      )
      .child(fieldRow("repo", "Repository Root", this.repoInput, true))
      .child(fieldRow("machine", "Machine (blank = local)", this.machineInput, false))
      .child(fieldRow("db", "Roscaelifer DB Path (--db)", this.dbInput, false))
      .child(fieldRow("bdDir", "Beads Directory (.beads)", this.bdDirInput, true))
      .child(fieldRow("config", "Herdr Env Config (roscaelifer.toml)", this.configInput, false))
      .child(fieldRow("formulasDir", "Formulas Directory", this.formulasDirInput, true))
      .child(fieldRow("bin", "roscaelifer Binary", this.binInput, false));
  }

  render(_cx) {
    const t = theme();
    const ct = this.cleanTarget();
    const cleanLabel = ct.taskId ? (ct.stepId ? `${ct.taskId}/${ct.stepId}` : String(ct.taskId)) : null;
    const titles = {
      enqueue: "Enqueue Bead",
      create: "New Bead",
      reject: "Reject Review",
      "clean-preview": cleanLabel ? `Clean Preview · ${cleanLabel}` : "Clean Pending Resources",
      "repo-config": "Repository Configuration",
    };
    const confirmLabels = {
      enqueue: this.busy ? "Enqueueing…" : "Enqueue",
      create: this.busy ? "Creating…" : "Create Bead",
      reject: this.busy ? "Rejecting…" : "Reject & Reopen",
      "clean-preview": this.busy ? "Cleaning…" : "Confirm Clean",
      "repo-config": "Save Override",
    };

    const canSubmit =
      !this.busy &&
      (this.dialogType !== "reject" || Boolean(this.feedbackInput.value().trim())) &&
      (this.dialogType !== "create" || Boolean(this.titleInput.value().trim())) &&
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
              .when(this.dialogType === "reject", (el) => el.child(this.renderReject(t)))
              .when(this.dialogType === "clean-preview", (el) => el.child(this.renderCleanPreview(t)))
              .when(this.dialogType === "repo-config", (el) => el.child(this.renderRepoConfig(t))),
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
            this.dialogType === "repo-config"
              ? this.renderBtn(t, "dlg-reset-ctx", "Reset Auto-Detect", () => {
                  clearActiveRepo();
                  setShared("roscaelifer.ctxOverride", null);
                  setShared("roscaelifer.refresh", Date.now());
                  this.close();
                })
              : div(),
          )
          .child(
            h_flex()
              .gap(8)
              .child(this.renderBtn(t, "dlg-cancel", "Cancel", () => this.close()))
              .child(
                this.renderBtn(t, "dlg-confirm", confirmLabels[this.dialogType] ?? "Confirm", (_e, cx) => this.submit(cx), {
                  primary: this.dialogType !== "reject" && this.dialogType !== "clean-preview",
                  danger: this.dialogType === "reject" || this.dialogType === "clean-preview",
                  disabled: !canSubmit,
                }),
              ),
          ),
      );
  }
}

export const DialogHandler = DialogController;
