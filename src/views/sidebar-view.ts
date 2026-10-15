import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { CardKind, CardSource, normalizeName, tidySelection } from "../card-maker";
import { flashcardCallout } from "../callouts";
import { clozeGroups } from "../cloze";
import { kindLabel } from "../generate";
import { locale, t, tn } from "../i18n";
import type NotebookLMStudy from "../main";
import { Artifact, CreateRequest, Notebook, QueryReference } from "../nlm-cli";
import { chip } from "../note-toolbar";
import { parseFile } from "../parsers";
import { isSourceFile } from "../sources";
import { DeckInfo } from "../srs/deck-index";
import { ParsedContent } from "../types";

export const SIDEBAR_VIEW = "nlm-sidebar-view";
export type SidebarSection = "sync" | "generate" | "ask" | "card" | "import";

const KIND_ICON: Record<string, string> = {
    flashcards: "layers", quiz: "list-checks", mind_map: "network",
    audio: "audio-lines", report: "file-text", infographic: "image", slide_deck: "presentation",
};
const TYPE_ICON: Record<string, string> = {
    flashcards: "layers", quiz: "list-checks", mindmap: "network",
    audio: "audio-lines", report: "file-text", infographic: "image", slides: "presentation",
};

export interface RevealOptions {
    notes?: TFile[];
    question?: string;
    notebook?: string;
    selection?: { text: string; source?: CardSource };
}

type Load<T> = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

interface ImportDraft {
    fileName: string;
    parsed: ParsedContent | null;
    title: string;
    deck: string;
    error: string;
}

interface ChatMessage {
    role: "user" | "assistant" | "error";
    text: string;
    question?: string;
    refs?: QueryReference[];
}

type OutputKey = "flashcards" | "quiz" | "mind_map" | "audio" | "report" | "infographic";

/**
 * The plugin's home in the right sidebar: today's numbers, NotebookLM sync and
 * browser, generation, chat with a notebook, every deck and file import.
 */
export class SidebarView extends ItemView {
    private notebooks: Load<Notebook[]> = { state: "idle" };
    private artifacts = new Map<string, Load<Artifact[]>>();
    private selected = new Map<string, Set<string>>();
    private expandedNotebook: string | null = null;
    private notebookQuery = "";
    private openSections = new Set<string>(["today", "decks"]);
    private collapsedDecks = new Set<string>();
    private busy: string | null = null;
    private draft: ImportDraft | null = null;

    // Generate
    private genNotes: TFile[] = [];
    private genTarget = "new";
    /** The notebook was picked automatically; re-pick once the notebook list loads. */
    private genAutoTarget = false;
    private genTitle = "";
    private genOutputs = new Set<OutputKey>(["flashcards", "quiz"]);
    private genFocus = "";
    private genAudioFormat: "deep_dive" | "brief" | "critique" | "debate" = "deep_dive";
    private genReportFormat: "Study Guide" | "Briefing Doc" | "Blog Post" = "Study Guide";

    // Ask
    private askNotebook = "";
    private askConversation: string | undefined;
    private askMessages: ChatMessage[] = [];
    private askDraft = "";
    private askPending = false;
    private chatComponent = new Component();

    // New card
    private cardKind: CardKind = "basic";
    private cardFront = "";
    private cardBack = "";
    private cardSource: CardSource | undefined;
    private cardBusy = false;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return SIDEBAR_VIEW; }
    getDisplayText() { return "NotebookLM"; }
    getIcon() { return "graduation-cap"; }

    async onOpen() {
        this.contentEl.addClass("nlm-sidebar");
        this.addChild(this.chatComponent);
        const rerender = () => { if (!this.isTyping()) this.render(); };
        this.registerEvent(this.plugin.index.on("changed", rerender));
        this.registerEvent(this.plugin.index.on("reviewed", rerender));
        this.registerEvent(this.plugin.generator.on("changed", rerender));
        this.registerEvent(this.plugin.autoSync.on("changed", rerender));
        this.registerEvent(this.app.workspace.on("file-open", () => {
            if (this.openSections.has("generate") || this.openSections.has("ask")) rerender();
        }));
        this.registerInterval(window.setInterval(rerender, 60_000));
        this.render();
    }

    refresh() {
        this.render();
    }

    /** Re-rendering while the user types in an input would steal focus. */
    private isTyping(): boolean {
        const a = document.activeElement;
        return !!a && this.contentEl.contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName);
    }

    /** Open a section (and scroll to it). Used by commands and menus. */
    reveal(section: SidebarSection, opts: RevealOptions = {}) {
        this.openSections.add(section);
        if (section === "generate") {
            if (opts.notes?.length) this.genNotes = opts.notes;
            else if (!this.genNotes.length && !opts.notebook) this.useActiveNote();
            this.genTitle = this.defaultGenTitle();
            this.genAutoTarget = !opts.notebook;
            if (opts.notebook) this.genTarget = opts.notebook;
            else this.suggestGenTarget();
        }
        if (section === "card" && opts.selection) this.startCard(opts.selection.text, opts.selection.source);
        if (section === "ask" && opts.question) this.askDraft = opts.question;
        if (section === "ask") {
            const linked = this.linkedNotebook();
            if (linked && linked !== this.askNotebook) {
                this.askNotebook = linked;
                this.askConversation = undefined;
                this.askMessages = [];
            }
        }
        if ((section === "sync" || section === "generate" || section === "ask") && this.notebooks.state === "idle") void this.loadNotebooks();
        this.render();
        this.contentEl.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "start" });
        if (section === "ask") this.contentEl.querySelector<HTMLTextAreaElement>(".nlm-chat-input textarea")?.focus();
        if (section === "card") this.contentEl.querySelector<HTMLTextAreaElement>(".nlm-card-form textarea")?.focus();
    }

    render() {
        const el = this.contentEl;
        const scroll = el.scrollTop;
        el.empty();
        this.chatComponent.unload();
        this.chatComponent = this.addChild(new Component());
        this.renderToday(el);
        if (Platform.isDesktopApp) {
            this.renderSync(el);
            this.renderGenerate(el);
            this.renderAsk(el);
        }
        this.renderNewCard(el);
        this.renderDecks(el);
        this.renderImport(el);
        el.scrollTop = scroll;
    }

    private section(parent: HTMLElement, id: string, icon: string, title: string, extra?: (h: HTMLElement) => void): HTMLElement {
        const open = this.openSections.has(id);
        const sec = parent.createDiv({ cls: "nlm-sb-section", attr: { "data-section": id } });
        const head = sec.createDiv({ cls: "nlm-sb-head", attr: { role: "button", tabindex: "0", "aria-expanded": String(open) } });
        setIcon(head.createSpan({ cls: "nlm-sb-caret" }), open ? "chevron-down" : "chevron-right");
        setIcon(head.createSpan({ cls: "nlm-btn-icon" }), icon);
        head.createSpan({ cls: "nlm-sb-title", text: title });
        extra?.(head);
        const toggle = () => {
            if (this.openSections.has(id)) this.openSections.delete(id);
            else this.reveal(id as SidebarSection);
            this.render();
        };
        head.onclick = e => { if (!(e.target as HTMLElement).closest("button")) toggle(); };
        head.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
        const body = sec.createDiv({ cls: "nlm-sb-body" });
        if (!open) body.hide();
        return body;
    }

    // --- Today ----------------------------------------------------------------

    private renderToday(el: HTMLElement) {
        const p = this.plugin;
        const hero = el.createDiv({ cls: "nlm-sb-hero" });
        if (!p.index.ready) {
            hero.createDiv({ cls: "nlm-empty", text: t("Indexing vault…") });
            return;
        }
        const items = p.studyableItems();
        const c = p.stateCounts(items.map(i => i.id));
        const stats = p.scheduler.stats();
        const fresh = Math.min(c.fresh, p.newLeftToday());
        const todo = c.due + c.learning + fresh;

        const nums = hero.createDiv({ cls: "nlm-sb-numbers" });
        num(nums, String(c.due + c.learning), t("due"), "nlm-due");
        num(nums, String(fresh), t("new"), "nlm-new");
        num(nums, String(stats.reviewedToday), t("done today"), "");
        num(nums, String(stats.streak), t("day streak"), "");

        const cta = hero.createEl("button", { cls: "mod-cta nlm-sb-cta" });
        setIcon(cta.createSpan({ cls: "nlm-btn-icon" }), todo ? "play" : "check");
        cta.createSpan({ text: todo ? t("Study now · {n}", { n: todo }) : items.length ? t("All caught up") : t("No cards yet") });
        cta.disabled = !items.length;
        cta.onclick = () => void p.openStudy({});

        const links = hero.createDiv({ cls: "nlm-sb-links" });
        link(links, t("Dashboard"), () => void p.openStudy());
        link(links, t("Card browser"), () => void p.openBrowser());
        link(links, t("Exam"), () => void p.openExamSetup());
    }

    // --- NotebookLM sync ------------------------------------------------------

    private renderSync(el: HTMLElement) {
        const p = this.plugin;
        const linked = new Set(p.index.list().filter(d => d.notebookId).map(d => d.notebookId));
        const body = this.section(el, "sync", "refresh-cw", "NotebookLM");

        const check = body.createEl("button", { cls: "nlm-sb-wide mod-cta" });
        setIcon(check.createSpan({ cls: "nlm-btn-icon" + (p.autoSync.running ? " is-spinning" : "") }), "refresh-cw");
        check.createSpan({ text: p.autoSync.running ? t("Checking…") : t("Check for new items") });
        check.disabled = p.autoSync.running || !linked.size;
        check.onclick = () => void p.autoSync.run(false);

        const meta: string[] = [tn(linked.size, "{n} notebook linked", "{n} notebooks linked")];
        if (p.syncState.lastRun) meta.push(t("checked {when}", { when: relativeTime(new Date(p.syncState.lastRun).toISOString()) }));
        meta.push(p.settings.autoSyncHours ? t("auto every {h} h", { h: p.settings.autoSyncHours }) : t("auto sync off"));
        body.createDiv({ cls: "nlm-sb-muted", text: meta.join(" · ") });
        if (p.autoSync.lastError) body.createDiv({ cls: "nlm-sb-error", text: p.autoSync.lastError });

        if (this.busy) busyBox(body, this.busy);

        body.createDiv({ cls: "nlm-sb-subhead", text: t("Browse notebooks") });
        if (!this.notebookList(body)) return;

        const notebooks = (this.notebooks as { value: Notebook[] }).value;
        const searchRow = body.createDiv({ cls: "nlm-sb-search" });
        const search = searchRow.createEl("input", { type: "search", attr: { placeholder: t("Search {n} notebooks…", { n: notebooks.length }) } });
        search.value = this.notebookQuery;
        const refresh = searchRow.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Reload notebooks") } });
        setIcon(refresh, "rotate-cw");
        refresh.onclick = () => void this.loadNotebooks();

        const list = body.createDiv({ cls: "nlm-sb-list" });
        const draw = () => {
            list.empty();
            const q = this.notebookQuery.toLowerCase();
            const shown = notebooks.filter(n => n.title.toLowerCase().includes(q));
            if (!shown.length) list.createDiv({ cls: "nlm-sb-muted nlm-pad", text: t("No notebooks match.") });
            for (const nb of shown) this.renderNotebook(list, nb);
        };
        search.oninput = () => { this.notebookQuery = search.value; draw(); };
        draw();
    }

    /** Show loading / error state for the notebook list. Returns true once notebooks are ready. */
    private notebookList(body: HTMLElement): boolean {
        switch (this.notebooks.state) {
            case "idle":
                body.createEl("button", { cls: "nlm-sb-wide", text: t("Load notebooks") }).onclick = () => void this.loadNotebooks();
                return false;
            case "loading":
                busyBox(body, t("Loading notebooks…"));
                return false;
            case "error":
                this.errorBox(body, this.notebooks.message, () => void this.loadNotebooks());
                return false;
        }
        return true;
    }

    private renderNotebook(list: HTMLElement, nb: Notebook) {
        const inVault = this.plugin.index.list().filter(d => d.notebookId === nb.id).length;
        const expanded = this.expandedNotebook === nb.id;
        const row = list.createDiv({ cls: "nlm-sb-row nlm-sb-notebook" + (expanded ? " is-open" : ""), attr: { tabindex: "0" } });
        setIcon(row.createSpan({ cls: "nlm-row-icon" }), expanded ? "book-open" : "book");
        const text = row.createDiv({ cls: "nlm-sb-row-text" });
        text.createDiv({ cls: "nlm-sb-row-title", text: nb.title });
        const meta: string[] = [];
        if (nb.sourceCount !== undefined) meta.push(tn(nb.sourceCount, "{n} source", "{n} sources"));
        if (nb.updatedAt) meta.push(relativeTime(nb.updatedAt));
        if (inVault) meta.push(t("{n} in vault", { n: inVault }));
        text.createDiv({ cls: "nlm-sb-row-meta", text: meta.join(" · ") });
        const toggle = () => {
            this.expandedNotebook = expanded ? null : nb.id;
            if (!expanded && !this.artifacts.has(nb.id)) void this.loadArtifacts(nb);
            this.render();
        };
        row.onclick = toggle;
        row.onkeydown = e => { if (e.key === "Enter") toggle(); };

        if (!expanded) return;
        const panel = list.createDiv({ cls: "nlm-sb-artifacts" });
        const quick = panel.createDiv({ cls: "nlm-actions" });
        chipButton(quick, "sparkles", t("Generate"), () => { this.genNotes = []; this.reveal("generate", { notebook: nb.id }); });
        chipButton(quick, "message-circle", t("Ask"), () => { this.askNotebook = nb.id; this.askConversation = undefined; this.reveal("ask"); });

        const load = this.artifacts.get(nb.id) ?? { state: "loading" };
        if (load.state === "loading" || load.state === "idle") { busyBox(panel, t("Loading…")); return; }
        if (load.state === "error") { this.errorBox(panel, load.message, () => void this.loadArtifacts(nb)); return; }

        const artifacts = load.value;
        if (!artifacts.length) {
            panel.createDiv({ cls: "nlm-sb-muted", text: t("Nothing generated in this notebook yet. Use Generate, or NotebookLM's Studio panel.") });
            return;
        }

        const existing = new Map(this.plugin.index.list().filter(d => d.artifactId).map(d => [d.artifactId as string, d]));
        if (!this.selected.has(nb.id)) {
            this.selected.set(nb.id, new Set(artifacts.filter(a => a.status === "completed" && !existing.has(a.id)
                && ["flashcards", "quiz", "mind_map"].includes(a.kind)).map(a => a.id)));
        }
        const sel = this.selected.get(nb.id)!;

        for (const a of artifacts) {
            const ready = a.status === "completed";
            const have = existing.get(a.id);
            const row = panel.createEl("label", { cls: "nlm-sb-artifact" + (ready ? "" : " is-disabled") });
            const cb = row.createEl("input", { type: "checkbox" });
            cb.checked = sel.has(a.id);
            cb.disabled = !ready;
            cb.onchange = () => { cb.checked ? sel.add(a.id) : sel.delete(a.id); this.render(); };
            setIcon(row.createSpan({ cls: "nlm-row-icon" }), KIND_ICON[a.kind] ?? "file");
            const text = row.createDiv({ cls: "nlm-sb-row-text" });
            text.createDiv({ cls: "nlm-sb-row-title", text: a.title });
            const meta = [kindLabel(a.kind)];
            if (a.createdAt) meta.push(relativeTime(a.createdAt));
            if (!ready) meta.push(a.status === "in_progress" ? t("generating…") : a.status);
            text.createDiv({ cls: "nlm-sb-row-meta", text: meta.join(" · ") });
            if (have) {
                const open = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("In vault — open note") } });
                setIcon(open, "file-check");
                open.onclick = e => { e.preventDefault(); void this.app.workspace.openLinkText(have.path, "", false); };
            }
        }

        const go = panel.createEl("button", { cls: "mod-cta nlm-sb-wide" });
        const n = sel.size;
        const updating = [...sel].filter(id => existing.has(id)).length;
        go.setText(n ? (updating ? t("Import {n} ({u} already in vault)", { n, u: updating }) : t("Import {n}", { n })) : t("Select items to import"));
        go.disabled = !n || !!this.busy;
        go.onclick = () => void this.run(async () => {
            const chosen = artifacts.filter(a => sel.has(a.id));
            const files = await this.plugin.importArtifacts(nb, chosen, msg => this.setBusy(msg));
            sel.clear();
            if (files[0] && this.plugin.settings.openAfterImport) await this.app.workspace.getLeaf(false).openFile(files[0]);
        });
    }

    private async loadNotebooks() {
        this.notebooks = { state: "loading" };
        this.render();
        try {
            this.notebooks = { state: "ready", value: await this.plugin.nlm().listNotebooks() };
            if (this.genAutoTarget) this.suggestGenTarget();
        } catch (e) {
            this.notebooks = { state: "error", message: (e as Error).message };
        }
        this.render();
    }

    private async loadArtifacts(nb: Notebook) {
        this.artifacts.set(nb.id, { state: "loading" });
        this.selected.delete(nb.id);
        this.render();
        try {
            this.artifacts.set(nb.id, { state: "ready", value: await this.plugin.nlm().listArtifacts(nb.id) });
        } catch (e) {
            this.artifacts.set(nb.id, { state: "error", message: (e as Error).message });
        }
        this.render();
    }

    private setBusy(msg: string | null) {
        this.busy = msg;
        this.render();
    }

    private async run(task: () => Promise<void>) {
        if (this.busy) return;
        this.setBusy(t("Working…"));
        try {
            await task();
        } catch (e) {
            new Notice((e as Error).message, 8000);
        } finally {
            this.setBusy(null);
        }
    }

    private errorBox(parent: HTMLElement, message: string, retry: () => void) {
        const box = parent.createDiv({ cls: "nlm-sb-error" });
        box.createEl("pre", { text: message });
        const row = box.createDiv({ cls: "nlm-actions" });
        row.createEl("button", { text: t("Retry") }).onclick = retry;
        row.createEl("button", { text: t("Settings") }).onclick = () => this.plugin.openSettings();
    }

    // --- Generate -------------------------------------------------------------

    private useActiveNote() {
        const file = this.app.workspace.getActiveFile();
        this.genNotes = isSourceFile(file) ? [file] : [];
    }

    private defaultGenTitle(): string {
        if (this.genNotes.length === 1) return this.genNotes[0].basename;
        if (this.genNotes.length > 1) return this.genNotes[0].parent?.name || this.genNotes[0].basename;
        return "";
    }

    /** Notebook the active note is linked to, or the one the active PDF was uploaded to. */
    private linkedNotebook(): string | undefined {
        const file = this.app.workspace.getActiveFile();
        if (!file) return undefined;
        return this.plugin.index.decks.get(file.path)?.notebookId ?? this.plugin.syncState.uploads[file.path]?.notebookId;
    }

    /**
     * Pick the notebook for the chosen sources: the one they were already
     * uploaded to, else one named like a folder they live in ("Aprendizaje
     * Automático/…/x.pdf" → notebook "Aprendizaje automático"), else a new one.
     */
    private suggestGenTarget() {
        if (!this.genNotes.length) {
            this.genTarget = this.linkedNotebook() ?? this.genTarget;
            return;
        }
        const uploads = this.plugin.syncState.uploads;
        const known = this.genNotes.map(f => uploads[f.path]?.notebookId ?? this.plugin.index.decks.get(f.path)?.notebookId).find(Boolean);
        if (known) {
            this.genTarget = known;
            return;
        }
        const notebooks = this.notebooks.state === "ready" ? this.notebooks.value : [];
        for (let folder = this.genNotes[0].parent; folder && !folder.isRoot(); folder = folder.parent) {
            const name = normalizeName(folder.name);
            const match = notebooks.find(n => normalizeName(n.title) === name);
            if (match) {
                this.genTarget = match.id;
                return;
            }
        }
        this.genTarget = "new";
    }

    private renderGenerate(el: HTMLElement) {
        const gen = this.plugin.generator;
        const body = this.section(el, "generate", "sparkles", t("Generate"), head => {
            if (gen.running) head.createSpan({ cls: "nlm-sb-count", text: t("{n} running", { n: gen.running }) });
        });

        // Sources
        const src = body.createDiv({ cls: "nlm-sb-field" });
        src.createDiv({ cls: "nlm-sb-label", text: t("Sources") });
        if (this.genNotes.length) {
            const pills = src.createDiv({ cls: "nlm-sb-pills" });
            for (const f of this.genNotes.slice(0, 6)) {
                const pill = pills.createDiv({ cls: "nlm-sb-pill" });
                setIcon(pill.createSpan({ cls: "nlm-btn-icon" }), f.extension === "pdf" ? "file-type-2" : f.extension === "md" ? "file-text" : "file");
                pill.createSpan({ text: f.name });
                if (this.plugin.syncState.uploads[f.path]) pill.setAttr("aria-label", t("Already uploaded; it will not be uploaded again if unchanged."));
            }
            if (this.genNotes.length > 6) pills.createDiv({ cls: "nlm-sb-muted", text: t("and {n} more", { n: this.genNotes.length - 6 }) });
        } else {
            src.createDiv({ cls: "nlm-sb-muted", text: t("The notebook's existing sources") });
        }
        const srcActions = src.createDiv({ cls: "nlm-actions" });
        chipButton(srcActions, "file-text", t("Use current file"), () => {
            this.useActiveNote();
            this.genTitle = this.defaultGenTitle();
            if (this.genAutoTarget) this.suggestGenTarget();
            this.render();
        });
        if (this.genNotes.length) chipButton(srcActions, "x", t("Clear"), () => { this.genNotes = []; this.render(); });
        src.createDiv({ cls: "nlm-sb-muted", text: t("Notes, PDFs, Word, PowerPoint and audio files work. Tip: right-click a file or folder → Generate with NotebookLM.") });

        // Notebook
        const nbField = body.createDiv({ cls: "nlm-sb-field" });
        nbField.createDiv({ cls: "nlm-sb-label", text: t("Notebook") });
        const select = nbField.createEl("select", { cls: "dropdown" });
        select.createEl("option", { value: "new", text: t("New notebook") });
        if (this.notebooks.state === "ready") {
            for (const nb of this.notebooks.value) select.createEl("option", { value: nb.id, text: nb.title });
        } else if (this.notebooks.state === "idle") {
            void this.loadNotebooks();
        }
        select.value = this.genTarget;
        select.onchange = () => { this.genTarget = select.value; this.genAutoTarget = false; this.render(); };
        if (this.genTarget === "new") {
            const title = nbField.createEl("input", { type: "text", attr: { placeholder: t("Notebook title") } });
            title.value = this.genTitle || this.defaultGenTitle();
            title.oninput = () => (this.genTitle = title.value);
        }
        if (this.genTarget === "new" && !this.genNotes.length) {
            nbField.createDiv({ cls: "nlm-sb-error", text: t("A new notebook needs at least one note as a source.") });
        }

        // Outputs
        const out = body.createDiv({ cls: "nlm-sb-field" });
        out.createDiv({ cls: "nlm-sb-label", text: t("Create") });
        const s = this.plugin.settings;
        const outputs: { key: OutputKey; extra?: string }[] = [
            { key: "flashcards", extra: t({ easy: "Easy", medium: "Medium", hard: "Hard" }[s.genFlashcardDifficulty]) },
            { key: "quiz", extra: t("{n} questions", { n: s.genQuizCount }) },
            { key: "mind_map" },
            { key: "audio" },
            { key: "report" },
            { key: "infographic" },
        ];
        const grid = out.createDiv({ cls: "nlm-sb-outputs" });
        for (const o of outputs) {
            const label = grid.createEl("label", { cls: "nlm-sb-output" + (this.genOutputs.has(o.key) ? " is-on" : "") });
            const cb = label.createEl("input", { type: "checkbox" });
            cb.checked = this.genOutputs.has(o.key);
            cb.onchange = () => { cb.checked ? this.genOutputs.add(o.key) : this.genOutputs.delete(o.key); this.render(); };
            setIcon(label.createSpan({ cls: "nlm-row-icon" }), KIND_ICON[o.key]);
            label.createSpan({ text: kindLabel(o.key) });
            if (o.extra) label.createSpan({ cls: "nlm-sb-row-meta", text: o.extra });
        }
        if (this.genOutputs.has("audio")) {
            const a = out.createEl("select", { cls: "dropdown" });
            for (const [v, l] of [["deep_dive", t("Audio: deep dive")], ["brief", t("Audio: brief")], ["critique", t("Audio: critique")], ["debate", t("Audio: debate")]]) {
                a.createEl("option", { value: v, text: l });
            }
            a.value = this.genAudioFormat;
            a.onchange = () => (this.genAudioFormat = a.value as typeof this.genAudioFormat);
        }
        if (this.genOutputs.has("report")) {
            const r = out.createEl("select", { cls: "dropdown" });
            for (const [v, l] of [["Study Guide", t("Report: study guide")], ["Briefing Doc", t("Report: briefing doc")], ["Blog Post", t("Report: blog post")]]) {
                r.createEl("option", { value: v, text: l });
            }
            r.value = this.genReportFormat;
            r.onchange = () => (this.genReportFormat = r.value as typeof this.genReportFormat);
        }

        const focus = out.createEl("input", { type: "text", attr: { placeholder: t("Focus (optional): topic or chapter to concentrate on") } });
        focus.value = this.genFocus;
        focus.oninput = () => (this.genFocus = focus.value);

        const canRun = this.genOutputs.size > 0 && (this.genTarget !== "new" || this.genNotes.length > 0);
        const go = body.createEl("button", { cls: "mod-cta nlm-sb-wide" });
        setIcon(go.createSpan({ cls: "nlm-btn-icon" }), "sparkles");
        go.createSpan({ text: t("Generate with NotebookLM") });
        go.disabled = !canRun;
        go.onclick = () => this.startGeneration();

        // Jobs
        if (gen.jobs.length) {
            const jobs = body.createDiv({ cls: "nlm-sb-jobs" });
            for (const job of gen.jobs) {
                const j = jobs.createDiv({ cls: `nlm-sb-job is-${job.status}` });
                const head = j.createDiv({ cls: "nlm-sb-job-head" });
                setIcon(head.createSpan({ cls: "nlm-btn-icon" + (job.status === "running" ? " is-spinning" : "") }),
                    job.status === "running" ? "loader" : job.status === "done" ? "check-circle" : "alert-circle");
                head.createSpan({ cls: "nlm-sb-row-title", text: job.title });
                j.createDiv({ cls: "nlm-sb-row-meta", text: job.step });
                if (job.status === "running") {
                    const bar = j.createDiv({ cls: "nlm-mini-progress" });
                    bar.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${Math.round(job.progress * 100)}%`;
                }
                if (job.error) j.createDiv({ cls: "nlm-sb-error", text: job.error });
                for (const f of job.files) {
                    const a = j.createEl("a", { cls: "nlm-sb-job-file", text: f.basename });
                    a.onclick = () => void this.app.workspace.getLeaf(false).openFile(f);
                }
            }
            if (gen.jobs.some(j => j.status !== "running")) {
                link(body.createDiv({ cls: "nlm-sb-links" }), t("Clear finished"), () => gen.clearFinished());
            }
        }
    }

    private startGeneration() {
        const s = this.plugin.settings;
        const focus = this.genFocus.trim() || undefined;
        const outputs: CreateRequest[] = [];
        for (const key of this.genOutputs) {
            switch (key) {
                case "flashcards": outputs.push({ kind: "flashcards", difficulty: s.genFlashcardDifficulty, focus }); break;
                case "quiz": outputs.push({ kind: "quiz", count: s.genQuizCount, difficulty: s.genQuizDifficulty, focus }); break;
                case "mind_map": outputs.push({ kind: "mind_map" }); break;
                case "audio": outputs.push({ kind: "audio", format: this.genAudioFormat, length: "default", focus }); break;
                case "report": outputs.push({ kind: "report", format: this.genReportFormat }); break;
                case "infographic": outputs.push({ kind: "infographic", focus }); break;
            }
        }
        let notebook: { id: string; title: string } | { title: string };
        if (this.genTarget === "new") {
            notebook = { title: this.genTitle.trim() || this.defaultGenTitle() || t("Obsidian notes") };
        } else {
            const nb = this.notebooks.state === "ready" ? this.notebooks.value.find(n => n.id === this.genTarget) : undefined;
            notebook = { id: this.genTarget, title: nb?.title ?? this.genTarget };
        }
        this.plugin.generator.start({ notes: [...this.genNotes], notebook, outputs });
        new Notice(t("Generating with NotebookLM. This usually takes a few minutes; you can keep working."));
        // A new notebook appears in the list afterwards.
        if (this.genTarget === "new") window.setTimeout(() => void this.loadNotebooks(), 20_000);
    }

    // --- Ask ------------------------------------------------------------------

    private renderAsk(el: HTMLElement) {
        const body = this.section(el, "ask", "message-circle", t("Ask NotebookLM"));

        const top = body.createDiv({ cls: "nlm-sb-search" });
        const select = top.createEl("select", { cls: "dropdown" });
        select.createEl("option", { value: "", text: t("Choose a notebook…") });
        if (this.notebooks.state === "ready") {
            for (const nb of this.notebooks.value) select.createEl("option", { value: nb.id, text: nb.title });
        } else if (this.notebooks.state === "idle") {
            void this.loadNotebooks();
        }
        if (!this.askNotebook) this.askNotebook = this.linkedNotebook() ?? "";
        select.value = this.askNotebook;
        select.onchange = () => {
            this.askNotebook = select.value;
            this.askConversation = undefined;
            this.askMessages = [];
            this.render();
        };
        if (this.askMessages.length) {
            const reset = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("New conversation") } });
            setIcon(reset, "message-square-plus");
            reset.onclick = () => { this.askConversation = undefined; this.askMessages = []; this.render(); };
        }

        const log = body.createDiv({ cls: "nlm-chat" });
        if (!this.askMessages.length) {
            log.createDiv({ cls: "nlm-sb-muted", text: t("Answers come only from the notebook's sources, with citations. Select text in a note and right-click → Ask NotebookLM about this.") });
        }
        for (const m of this.askMessages) this.renderMessage(log, m);
        if (this.askPending) busyBox(log, t("NotebookLM is thinking…"));

        const input = body.createDiv({ cls: "nlm-chat-input" });
        const ta = input.createEl("textarea", { attr: { placeholder: t("Ask a question… (Enter to send, Shift+Enter for a new line)"), rows: "3" } });
        ta.value = this.askDraft;
        ta.oninput = () => (this.askDraft = ta.value);
        const send = input.createEl("button", { cls: "mod-cta", attr: { "aria-label": t("Send") } });
        setIcon(send, "send");
        send.disabled = this.askPending || !this.askNotebook;
        const submit = () => void this.ask();
        send.onclick = submit;
        ta.onkeydown = e => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
        };
    }

    private renderMessage(parent: HTMLElement, m: ChatMessage) {
        const el = parent.createDiv({ cls: `nlm-msg nlm-msg-${m.role}` });
        if (m.role !== "assistant") {
            el.setText(m.text);
            return;
        }
        const content = el.createDiv({ cls: "nlm-msg-body" });
        void MarkdownRenderer.render(this.app, m.text, content, "", this.chatComponent).then(() => {
            // Hover a [n] to see the cited passage.
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
            const nodes: Text[] = [];
            while (walker.nextNode()) nodes.push(walker.currentNode as Text);
            for (const node of nodes) {
                if (!/\[\d+\]/.test(node.data)) continue;
                const frag = document.createDocumentFragment();
                node.data.split(/(\[\d+\])/).forEach(part => {
                    const ref = part.match(/^\[(\d+)\]$/) && m.refs?.find(r => `[${r.number}]` === part);
                    if (ref) frag.append(createSpan({ cls: "nlm-cite", text: part, attr: { "aria-label": ref.text.slice(0, 400) } }));
                    else frag.append(part);
                });
                node.replaceWith(frag);
            }
        });
        if (m.refs?.length) {
            const det = el.createEl("details", { cls: "nlm-msg-refs" });
            det.createEl("summary", { text: tn(m.refs.length, "{n} citation", "{n} citations") });
            for (const r of m.refs) det.createDiv({ cls: "nlm-msg-ref", text: `[${r.number}] ${r.text}` });
        }
        const actions = el.createDiv({ cls: "nlm-actions" });
        chipButton(actions, "file-input", t("Insert into note"), () => this.insertAnswer(m));
        chipButton(actions, "layers", t("Save as flashcard"), () => this.saveAsFlashcard(m));
        chipButton(actions, "copy", t("Copy"), () => { void navigator.clipboard.writeText(cleanAnswer(m.text)); new Notice(t("Copied.")); });
    }

    private async ask() {
        const q = this.askDraft.trim();
        if (!q || !this.askNotebook || this.askPending) return;
        this.askMessages.push({ role: "user", text: q });
        this.askDraft = "";
        this.askPending = true;
        this.render();
        try {
            const res = await this.plugin.nlm().query(this.askNotebook, q, this.askConversation);
            this.askConversation = res.conversationId ?? this.askConversation;
            this.askMessages.push({ role: "assistant", text: res.answer, question: q, refs: res.references });
        } catch (e) {
            this.askMessages.push({ role: "error", text: (e as Error).message });
        } finally {
            this.askPending = false;
            this.render();
            const log = this.contentEl.querySelector(".nlm-chat");
            log?.lastElementChild?.scrollIntoView({ block: "nearest" });
        }
    }

    /** The markdown editor the user was last in (the sidebar itself has focus now). */
    private targetEditor(): MarkdownView | null {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active) return active;
        const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
        return leaf?.view instanceof MarkdownView ? leaf.view : null;
    }

    private insertAnswer(m: ChatMessage) {
        const view = this.targetEditor();
        if (!view) { new Notice(t("Open a note first.")); return; }
        const lines = [`> [!notebooklm] ${m.question ?? ""}`.trimEnd(), ...cleanAnswer(m.text).split("\n").map(l => (l.trim() ? `> ${l}` : ">"))];
        const editor = view.editor;
        const cur = editor.getCursor();
        const prefix = editor.getLine(cur.line).trim() ? "\n\n" : "";
        editor.replaceRange(`${prefix}${lines.join("\n")}\n`, { line: cur.line, ch: editor.getLine(cur.line).length });
        new Notice(t("Inserted into {name}.", { name: view.file?.basename ?? "" }));
    }

    private saveAsFlashcard(m: ChatMessage) {
        const view = this.targetEditor();
        if (!view) { new Notice(t("Open a note first.")); return; }
        const callout = flashcardCallout({ front: m.question ?? "", back: cleanAnswer(m.text) });
        const editor = view.editor;
        const last = editor.lastLine();
        const prefix = editor.getLine(last).trim() ? "\n\n" : "\n";
        editor.replaceRange(`${prefix}${callout}\n`, { line: last, ch: editor.getLine(last).length });
        new Notice(t("Flashcard added to {name}.", { name: view.file?.basename ?? "" }));
    }

    // --- New card -------------------------------------------------------------

    /** Prefill the form from selected text: the answer of a basic card, or the text of a cloze. */
    private startCard(text: string, source?: CardSource) {
        const tidy = tidySelection(text);
        this.cardSource = source;
        if (this.cardKind === "cloze") {
            this.cardFront = tidy;
        } else {
            this.cardFront = "";
            this.cardBack = tidy;
        }
    }

    private renderNewCard(el: HTMLElement) {
        const maker = this.plugin.cardMaker;
        const body = this.section(el, "card", "square-plus", t("New card"));
        const form = body.createDiv({ cls: "nlm-card-form" });

        // Source and destination
        const src = form.createDiv({ cls: "nlm-sb-field" });
        src.createDiv({ cls: "nlm-sb-label", text: t("Source") });
        const s = this.cardSource;
        if (s) {
            const pill = src.createDiv({ cls: "nlm-sb-pills" }).createDiv({ cls: "nlm-sb-pill" });
            setIcon(pill.createSpan({ cls: "nlm-btn-icon" }), s.file.extension === "pdf" ? "file-type-2" : "file-text");
            pill.createSpan({ text: s.page ? t("{name}, p. {page}", { name: s.file.name, page: s.page }) : s.file.name });
        } else {
            src.createDiv({ cls: "nlm-sb-muted", text: t("None") });
        }
        const actions = src.createDiv({ cls: "nlm-actions" });
        chipButton(actions, "text-select", t("Use selection"), () => {
            const sel = this.plugin.lastSelection();
            if (!sel.text) { new Notice(t("Select some text in a PDF or note first.")); return; }
            this.startCard(sel.text, sel.source);
            this.render();
        });
        if (s) chipButton(actions, "x", t("Clear"), () => { this.cardSource = undefined; this.render(); });
        const n = maker.count(s);
        const dest = src.createDiv({ cls: "nlm-sb-muted nlm-card-dest" });
        dest.setText(t("Saved to {name}", { name: maker.notePath(s).split("/").pop()!.replace(/\.md$/, "") }) + (n ? ` · ${tn(n, "{n} card", "{n} cards")}` : ""));
        if (n) {
            dest.addClass("is-link");
            dest.onclick = () => {
                const f = this.app.vault.getAbstractFileByPath(maker.notePath(s));
                if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f);
            };
        }

        // Kind
        const kinds = form.createDiv({ cls: "nlm-card-kinds" });
        const kind = (k: CardKind, icon: string, label: string) => {
            const b = kinds.createEl("button", { cls: "nlm-chip-btn" });
            b.toggleClass("is-active", this.cardKind === k);
            setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
            b.createSpan({ text: label });
            b.onclick = () => {
                if (this.cardKind === k) return;
                // Keep the selected text where it makes sense for the new kind.
                if (k === "cloze" && !this.cardFront.trim()) this.cardFront = this.cardBack;
                if (this.cardKind === "cloze" && !this.cardBack.trim()) { this.cardBack = this.cardFront.replace(/\{\{(?:c\d+::)?(.+?)\}\}/g, "$1"); this.cardFront = ""; }
                this.cardKind = k;
                this.render();
            };
        };
        kind("basic", "layers", t("Basic"));
        kind("reverse", "repeat", t("Both ways"));
        kind("cloze", "brackets", t("Cloze"));

        const save = () => void this.saveCard();
        const area = (label: string, value: string, placeholder: string, onInput: (v: string) => void) => {
            const field = form.createDiv({ cls: "nlm-sb-field" });
            field.createDiv({ cls: "nlm-sb-label", text: label });
            const ta = field.createEl("textarea", { attr: { rows: "3", placeholder } });
            ta.value = value;
            ta.oninput = () => onInput(ta.value);
            ta.onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } };
            return { field, ta };
        };

        if (this.cardKind === "cloze") {
            const { field, ta } = area(t("Text"), this.cardFront, t("Select words in the box and press Hide, or type {{ }} around them."), v => (this.cardFront = v));
            const row = field.createDiv({ cls: "nlm-actions" });
            chipButton(row, "eye-off", t("Hide selection"), () => {
                const { selectionStart: a, selectionEnd: b, value } = ta;
                if (a === b) { new Notice(t("Select the words to hide inside the box.")); return; }
                // Each {{ }} becomes its own card; the parser numbers them.
                this.cardFront = `${value.slice(0, a)}{{${value.slice(a, b).trim()}}}${value.slice(b)}`;
                this.render();
                this.contentEl.querySelector<HTMLTextAreaElement>(".nlm-card-form textarea")?.focus();
            });
            const groups = clozeGroups(this.cardFront).length;
            row.createSpan({ cls: "nlm-sb-muted", text: groups ? tn(groups, "{n} gap", "{n} gaps") : t("No gaps yet") });
        } else {
            const q = area(t("Question"), this.cardFront, this.cardKind === "reverse" ? t("Term") : t("What should this card ask?"), v => (this.cardFront = v));
            const notebook = s && Platform.isDesktopApp ? this.plugin.cardMaker.notebookOf(s.file) : undefined;
            if (notebook) {
                const row = q.field.createDiv({ cls: "nlm-actions" });
                chipButton(row, "sparkles", this.cardBusy ? t("Thinking…") : t("Suggest a question"), () => void this.suggestQuestion(notebook.id));
            }
            area(t("Answer"), this.cardBack, this.cardKind === "reverse" ? t("Definition") : t("The answer (selected text goes here)"), v => (this.cardBack = v));
        }

        const ready = this.cardKind === "cloze" ? /\{\{.+?\}\}/.test(this.cardFront) : !!this.cardFront.trim() && !!this.cardBack.trim();
        const btn = form.createEl("button", { cls: "mod-cta nlm-sb-wide" });
        setIcon(btn.createSpan({ cls: "nlm-btn-icon" }), "plus");
        btn.createSpan({ text: t("Save card") });
        btn.disabled = !ready;
        btn.onclick = save;
        form.createDiv({ cls: "nlm-sb-muted", text: t("Ctrl+Enter saves. Tip: select text in a PDF and use the floating Card button.") });
    }

    private async saveCard() {
        const front = this.cardFront.trim();
        const back = this.cardBack.trim();
        if (this.cardKind === "cloze" ? !/\{\{.+?\}\}/.test(front) : !front || !back) return;
        try {
            const file = await this.plugin.cardMaker.add({ kind: this.cardKind, front, back, source: this.cardSource });
            new Notice(t("Card saved to {name}.", { name: file.basename }));
            this.cardFront = "";
            this.cardBack = "";
        } catch (e) {
            new Notice(t("Could not save the card: {error}", { error: (e as Error).message }));
        }
        this.render();
        this.contentEl.querySelector<HTMLTextAreaElement>(".nlm-card-form textarea")?.focus();
    }

    /** Ask the source's notebook to phrase a question whose answer is the selected text. */
    private async suggestQuestion(notebookId: string) {
        if (this.cardBusy) return;
        const answer = this.cardBack.trim();
        if (!answer) { new Notice(t("Write or select the answer first.")); return; }
        this.cardBusy = true;
        this.render();
        try {
            const prompt = t("Write ONE short flashcard question whose answer is the text below. Reply with the question only, no quotes or explanations.\n\nText: {text}", { text: answer });
            const res = await this.plugin.nlm().query(notebookId, prompt);
            this.cardFront = cleanAnswer(res.answer).split("\n").find(l => l.trim())?.replace(/^["“*\s]+|["”*\s]+$/g, "") ?? "";
        } catch (e) {
            new Notice((e as Error).message);
        } finally {
            this.cardBusy = false;
            this.render();
        }
    }

    // --- Decks ----------------------------------------------------------------

    private renderDecks(el: HTMLElement) {
        const decks = this.plugin.index.list();
        const body = this.section(el, "decks", "library", t("Decks"), head => {
            head.createSpan({ cls: "nlm-sb-count", text: String(decks.length) });
        });
        if (!decks.length) {
            body.createDiv({ cls: "nlm-sb-muted", text: t("No study notes yet. Import from NotebookLM, or write a > [!flashcard] callout in any note.") });
            return;
        }

        const groups = new Map<string, DeckInfo[]>();
        for (const d of decks) {
            if (!groups.has(d.deck)) groups.set(d.deck, []);
            groups.get(d.deck)!.push(d);
        }

        for (const [name, notes] of groups) {
            const p = this.plugin;
            const items = notes.flatMap(n => p.filterStudyable(n.items));
            const c = p.stateCounts(items.map(i => i.id));
            const collapsed = this.collapsedDecks.has(name);

            const group = body.createDiv({ cls: "nlm-sb-deck" });
            const head = group.createDiv({ cls: "nlm-sb-deck-head" });
            setIcon(head.createSpan({ cls: "nlm-sb-caret" }), collapsed ? "chevron-right" : "chevron-down");
            head.createSpan({ cls: "nlm-sb-deck-name", text: name });
            if (items.length) {
                const play = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Study {name}", { name }) } });
                setIcon(play, "play");
                play.onclick = e => { e.stopPropagation(); void p.openStudy({ deck: name }); };
            }
            head.onclick = () => {
                if (collapsed) this.collapsedDecks.delete(name);
                else this.collapsedDecks.add(name);
                this.render();
            };

            if (items.length) {
                const stats = group.createDiv({ cls: "nlm-chips" });
                chip(stats, "new", c.fresh, t("New"));
                chip(stats, "learning", c.learning, t("Learning"));
                chip(stats, "due", c.due, t("Due"));
                const pct = Math.round((c.review / items.length) * 100);
                const bar = group.createDiv({ cls: "nlm-mini-progress", attr: { "aria-label": t("{pct}% learned", { pct }) } });
                bar.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
            }
            if (collapsed) continue;

            for (const note of notes) {
                const row = group.createDiv({ cls: "nlm-sb-row", attr: { tabindex: "0" } });
                setIcon(row.createSpan({ cls: "nlm-row-icon" }), TYPE_ICON[note.type] ?? "file");
                const text = row.createDiv({ cls: "nlm-sb-row-text" });
                text.createDiv({ cls: "nlm-sb-row-title", text: note.title });
                text.createDiv({ cls: "nlm-sb-row-meta", text: this.noteMeta(note) });
                row.onclick = () => void this.app.workspace.openLinkText(note.path, "", false);
                row.onkeydown = e => { if (e.key === "Enter") row.click(); };
            }
        }
    }

    private noteMeta(note: DeckInfo): string {
        const p = this.plugin;
        const count = (k: string) => note.items.filter(i => i.kind === k).length;
        const meta: string[] = [];
        if (note.type !== "flashcards" && note.type !== "quiz") meta.push(kindLabel(note.type === "mindmap" ? "mind_map" : note.type === "slides" ? "slide_deck" : note.type));
        if (count("flashcard")) meta.push(tn(count("flashcard"), "{n} card", "{n} cards"));
        if (count("cloze")) meta.push(tn(count("cloze"), "{n} cloze", "{n} clozes"));
        if (count("quiz")) meta.push(tn(count("quiz"), "{n} question", "{n} questions"));
        const nc = p.stateCounts(p.filterStudyable(note.items).map(i => i.id));
        if (nc.due + nc.learning) meta.push(t("{n} due", { n: nc.due + nc.learning }));
        return meta.join(" · ");
    }

    // --- Import file ----------------------------------------------------------

    private renderImport(el: HTMLElement) {
        const body = this.section(el, "import", "file-down", t("Import file"));
        body.createDiv({ cls: "nlm-sb-muted", text: t("CSV or JSON flashcards and quizzes, or a mind map as JSON or a Markdown outline.") });
        const pick = body.createEl("button", { cls: "nlm-sb-wide" });
        setIcon(pick.createSpan({ cls: "nlm-btn-icon" }), "upload");
        pick.createSpan({ text: this.draft ? t("Choose another file") : t("Choose file…") });
        pick.onclick = () => this.pickFile();

        const d = this.draft;
        if (!d) return;
        if (d.error) { body.createDiv({ cls: "nlm-sb-error", text: d.error }); return; }
        if (!d.parsed) return;
        const parsed = d.parsed;

        const card = body.createDiv({ cls: "nlm-sb-draft" });
        const what = parsed.type === "flashcards" ? tn(parsed.cards.length, "{n} flashcard", "{n} flashcards")
            : parsed.type === "quiz" ? tn(parsed.questions.length, "{n} quiz question", "{n} quiz questions")
            : t("Mind map · {n} branches", { n: parsed.root.children.length });
        card.createDiv({ cls: "nlm-sb-row-title", text: what });
        card.createDiv({ cls: "nlm-sb-row-meta", text: d.fileName });

        const title = card.createEl("input", { type: "text", attr: { placeholder: t("Note title") } });
        title.value = d.title;
        title.oninput = () => (d.title = title.value.trim());
        if (parsed.type !== "mindmap") {
            const deck = card.createEl("input", { type: "text", attr: { placeholder: t("Deck (optional)") } });
            deck.value = d.deck;
            deck.oninput = () => (d.deck = deck.value.trim());
        }

        const sample = card.createEl("ul", { cls: "nlm-sb-sample" });
        if (parsed.type === "flashcards") parsed.cards.slice(0, 3).forEach(c => sample.createEl("li", { text: c.front }));
        else if (parsed.type === "quiz") parsed.questions.slice(0, 3).forEach(q => sample.createEl("li", { text: q.question }));
        else parsed.root.children.slice(0, 4).forEach(n => sample.createEl("li", { text: n.name }));

        const actions = card.createDiv({ cls: "nlm-actions" });
        actions.createEl("button", { text: t("Cancel") }).onclick = () => { this.draft = null; this.render(); };
        const go = actions.createEl("button", { cls: "mod-cta", text: t("Import") });
        go.onclick = () => void this.run(async () => {
            if (!d.title) { new Notice(t("Enter a title.")); return; }
            const res = await this.plugin.writer.write({
                content: parsed, title: d.title, deck: d.deck || undefined, origin: { source: "file" },
            });
            new Notice(res.created ? t("Imported {name}.", { name: res.file.basename }) : t("Updated {name}.", { name: res.file.basename }));
            this.draft = null;
            if (this.plugin.settings.openAfterImport) await this.app.workspace.getLeaf(false).openFile(res.file);
        });
    }

    private pickFile() {
        const input = createEl("input", { type: "file", attr: { accept: ".csv,.json,.md,.txt" } });
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const base = file.name.replace(/\.[^/.]+$/, "");
            const draft: ImportDraft = { fileName: file.name, parsed: null, title: base, deck: "", error: "" };
            try {
                const parsed = parseFile(file.name, await file.text(), base);
                const empty = parsed.type === "flashcards" ? !parsed.cards.length : parsed.type === "quiz" ? !parsed.questions.length : false;
                if (empty) draft.error = t("No items found in this file. Is it a NotebookLM export?");
                else { draft.parsed = parsed; draft.title = parsed.title || base; }
            } catch (e) {
                draft.error = (e as Error).message;
            }
            this.draft = draft;
            this.openSections.add("import");
            this.render();
        };
        input.click();
    }
}

function num(parent: HTMLElement, value: string, label: string, cls: string) {
    const n = parent.createDiv({ cls: `nlm-sb-num ${cls}` });
    n.createDiv({ cls: "nlm-sb-num-value", text: value });
    n.createDiv({ cls: "nlm-sb-num-label", text: label });
}

function link(parent: HTMLElement, text: string, onClick: () => void) {
    const a = parent.createEl("a", { text });
    a.onclick = onClick;
}

function chipButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createEl("button", { cls: "nlm-chip-btn" });
    setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
    b.createSpan({ text: label });
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); onClick(); };
}

function busyBox(parent: HTMLElement, text: string) {
    const el = parent.createDiv({ cls: "nlm-sb-busy" });
    el.createDiv({ cls: "nlm-spinner" });
    el.createSpan({ text });
}

/** Strip NotebookLM's follow-up suggestion and citation markers for pasting into notes. */
function cleanAnswer(text: string): string {
    return text
        .replace(/\n+💡[\s\S]*$/u, "")
        .replace(/\s?\[\d+(?:,\s*\d+)*\]/g, "")
        .trim();
}

export function relativeTime(iso: string): string {
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return "";
    const min = Math.round((Date.now() - time) / 60000);
    if (min < 1) return t("just now");
    if (min < 60) return t("{n} min ago", { n: min });
    const h = Math.round(min / 60);
    if (h < 24) return t("{n} h ago", { n: h });
    const d = Math.round(h / 24);
    if (d < 30) return tn(d, "{n} day ago", "{n} days ago");
    return new Date(time).toLocaleDateString(locale());
}

