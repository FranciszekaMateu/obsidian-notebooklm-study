import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type NotebookLMStudy from "../main";
import { Artifact, Notebook } from "../nlm-cli";
import { chip } from "../note-toolbar";
import { parseFile } from "../parsers";
import { DeckInfo } from "../srs/deck-index";
import { ParsedContent } from "../types";

export const SIDEBAR_VIEW = "nlm-sidebar-view";

const KIND_LABEL: Record<string, string> = { flashcards: "Flashcards", quiz: "Quiz", mind_map: "Mind map" };
const KIND_ICON: Record<string, string> = { flashcards: "layers", quiz: "list-checks", mind_map: "network" };

type Load<T> = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

interface ImportDraft {
    fileName: string;
    parsed: ParsedContent | null;
    title: string;
    deck: string;
    error: string;
}

/**
 * The plugin's home in the right sidebar: today's numbers, one-click sync,
 * a NotebookLM browser, every deck in the vault and file import — all inline.
 */
export class SidebarView extends ItemView {
    private notebooks: Load<Notebook[]> = { state: "idle" };
    private artifacts = new Map<string, Load<Artifact[]>>();
    private selected = new Map<string, Set<string>>();
    private expandedNotebook: string | null = null;
    private notebookQuery = "";
    private open = new Set<string>(["today", "decks"]);
    private collapsedDecks = new Set<string>();
    private busy: string | null = null;
    private draft: ImportDraft | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return SIDEBAR_VIEW; }
    getDisplayText() { return "NotebookLM"; }
    getIcon() { return "graduation-cap"; }

    async onOpen() {
        this.contentEl.addClass("nlm-sidebar");
        const rerender = () => { if (!this.isTyping()) this.render(); };
        this.registerEvent(this.plugin.index.on("changed", rerender));
        this.registerEvent(this.plugin.index.on("reviewed", rerender));
        this.registerInterval(window.setInterval(rerender, 60_000));
        this.render();
    }

    /** Re-rendering while the user types in an input would steal focus. */
    private isTyping(): boolean {
        const a = document.activeElement;
        return !!a && this.contentEl.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
    }

    /** Open a section (and scroll to it). Used by commands. */
    reveal(section: "sync" | "import") {
        this.open.add(section);
        this.render();
        this.contentEl.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "start" });
        if (section === "sync" && this.notebooks.state === "idle") void this.loadNotebooks();
    }

    render() {
        const el = this.contentEl;
        const scroll = el.scrollTop;
        el.empty();
        this.renderToday(el);
        if (Platform.isDesktopApp) this.renderSync(el);
        this.renderDecks(el);
        this.renderImport(el);
        el.scrollTop = scroll;
    }

    private section(parent: HTMLElement, id: string, icon: string, title: string, extra?: (h: HTMLElement) => void): HTMLElement {
        const sec = parent.createDiv({ cls: "nlm-sb-section", attr: { "data-section": id } });
        const head = sec.createDiv({ cls: "nlm-sb-head", attr: { role: "button", tabindex: "0", "aria-expanded": String(this.open.has(id)) } });
        setIcon(head.createSpan({ cls: "nlm-sb-caret" }), this.open.has(id) ? "chevron-down" : "chevron-right");
        setIcon(head.createSpan({ cls: "nlm-btn-icon" }), icon);
        head.createSpan({ cls: "nlm-sb-title", text: title });
        extra?.(head);
        const toggle = () => {
            if (this.open.has(id)) this.open.delete(id);
            else this.open.add(id);
            if (id === "sync" && this.open.has(id) && this.notebooks.state === "idle") void this.loadNotebooks();
            this.render();
        };
        head.onclick = e => { if (!(e.target as HTMLElement).closest("button")) toggle(); };
        head.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
        const body = sec.createDiv({ cls: "nlm-sb-body" });
        if (!this.open.has(id)) body.hide();
        return body;
    }

    // --- Today ----------------------------------------------------------------

    private renderToday(el: HTMLElement) {
        const p = this.plugin;
        const hero = el.createDiv({ cls: "nlm-sb-hero" });
        if (!p.index.ready) {
            hero.createDiv({ cls: "nlm-empty", text: "Indexing vault…" });
            return;
        }
        const items = p.studyableItems();
        const c = p.stateCounts(items.map(i => i.id));
        const stats = p.scheduler.stats();
        const todo = c.due + c.learning + Math.min(c.fresh, p.newLeftToday());

        const nums = hero.createDiv({ cls: "nlm-sb-numbers" });
        num(nums, String(c.due + c.learning), "due", "nlm-due");
        num(nums, String(Math.min(c.fresh, p.newLeftToday())), "new", "nlm-new");
        num(nums, String(stats.reviewedToday), "done today", "");
        num(nums, String(stats.streak), "day streak", "");

        const cta = hero.createEl("button", { cls: "mod-cta nlm-sb-cta" });
        setIcon(cta.createSpan({ cls: "nlm-btn-icon" }), todo ? "play" : "check");
        cta.createSpan({ text: todo ? `Study now · ${todo}` : items.length ? "All caught up" : "No cards yet" });
        cta.disabled = !items.length;
        cta.onclick = () => void p.openStudy({});

        const links = hero.createDiv({ cls: "nlm-sb-links" });
        const dash = links.createEl("a", { text: "Open dashboard" });
        dash.onclick = () => void p.openStudy();
        if (stats.retention30d !== null) links.createSpan({ text: `Retention ${Math.round(stats.retention30d * 100)}%` });
    }

    // --- NotebookLM sync ------------------------------------------------------

    private renderSync(el: HTMLElement) {
        const p = this.plugin;
        const linked = p.index.list().filter(d => d.notebookId && d.artifactId);
        const body = this.section(el, "sync", "refresh-cw", "NotebookLM");

        const syncAll = body.createEl("button", { cls: "nlm-sb-wide" });
        setIcon(syncAll.createSpan({ cls: "nlm-btn-icon" }), "refresh-cw");
        syncAll.createSpan({ text: linked.length ? `Update ${linked.length} synced note${linked.length === 1 ? "" : "s"}` : "Nothing synced yet" });
        syncAll.disabled = !linked.length || !!this.busy;
        syncAll.onclick = () => void this.run(async () => {
            await p.resyncAll(undefined, msg => this.setBusy(msg));
        });
        const last = linked.map(d => d.synced).filter(Boolean).sort().pop();
        if (last) body.createDiv({ cls: "nlm-sb-muted", text: `Last update ${relativeTime(last)}` });

        if (this.busy) {
            const b = body.createDiv({ cls: "nlm-sb-busy" });
            b.createDiv({ cls: "nlm-spinner" });
            b.createSpan({ text: this.busy });
        }

        body.createDiv({ cls: "nlm-sb-subhead", text: "Add from a notebook" });
        switch (this.notebooks.state) {
            case "idle":
                body.createEl("button", { cls: "nlm-sb-wide", text: "Load notebooks" }).onclick = () => void this.loadNotebooks();
                return;
            case "loading":
                loading(body, "Loading notebooks…");
                return;
            case "error":
                this.errorBox(body, this.notebooks.message, () => void this.loadNotebooks());
                return;
        }

        const notebooks = this.notebooks.value;
        const searchRow = body.createDiv({ cls: "nlm-sb-search" });
        const search = searchRow.createEl("input", { type: "search", attr: { placeholder: `Search ${notebooks.length} notebooks…` } });
        search.value = this.notebookQuery;
        const refresh = searchRow.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Reload notebooks" } });
        setIcon(refresh, "rotate-cw");
        refresh.onclick = () => void this.loadNotebooks();

        const list = body.createDiv({ cls: "nlm-sb-list" });
        const draw = () => {
            list.empty();
            const q = this.notebookQuery.toLowerCase();
            const shown = notebooks.filter(n => n.title.toLowerCase().includes(q));
            if (!shown.length) list.createDiv({ cls: "nlm-sb-muted", text: "No notebooks match." });
            for (const nb of shown) this.renderNotebook(list, nb);
        };
        search.oninput = () => { this.notebookQuery = search.value; draw(); };
        draw();
    }

    private renderNotebook(list: HTMLElement, nb: Notebook) {
        const inVault = this.plugin.index.list().filter(d => d.notebookId === nb.id).length;
        const expanded = this.expandedNotebook === nb.id;
        const row = list.createDiv({ cls: "nlm-sb-row nlm-sb-notebook" + (expanded ? " is-open" : ""), attr: { tabindex: "0" } });
        setIcon(row.createSpan({ cls: "nlm-row-icon" }), expanded ? "book-open" : "book");
        const text = row.createDiv({ cls: "nlm-sb-row-text" });
        text.createDiv({ cls: "nlm-sb-row-title", text: nb.title });
        const meta: string[] = [];
        if (nb.sourceCount !== undefined) meta.push(`${nb.sourceCount} source${nb.sourceCount === 1 ? "" : "s"}`);
        if (nb.updatedAt) meta.push(relativeTime(nb.updatedAt));
        if (inVault) meta.push(`${inVault} in vault`);
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
        const load = this.artifacts.get(nb.id) ?? { state: "loading" };
        if (load.state === "loading" || load.state === "idle") { loading(panel, "Loading…"); return; }
        if (load.state === "error") { this.errorBox(panel, load.message, () => void this.loadArtifacts(nb)); return; }

        const artifacts = load.value;
        if (!artifacts.length) {
            panel.createDiv({ cls: "nlm-sb-muted", text: "No flashcards, quizzes or mind maps yet. Create them in NotebookLM's Studio panel." });
            return;
        }

        const existing = new Map(this.plugin.index.list().filter(d => d.artifactId).map(d => [d.artifactId as string, d]));
        if (!this.selected.has(nb.id)) {
            this.selected.set(nb.id, new Set(artifacts.filter(a => a.status === "completed" && !existing.has(a.id)).map(a => a.id)));
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
            setIcon(row.createSpan({ cls: "nlm-row-icon" }), KIND_ICON[a.kind]);
            const text = row.createDiv({ cls: "nlm-sb-row-text" });
            text.createDiv({ cls: "nlm-sb-row-title", text: a.title });
            const meta = [KIND_LABEL[a.kind]];
            if (a.createdAt) meta.push(relativeTime(a.createdAt));
            if (!ready) meta.push(a.status);
            text.createDiv({ cls: "nlm-sb-row-meta", text: meta.join(" · ") });
            if (have) {
                const open = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "In vault — open note" } });
                setIcon(open, "file-check");
                open.onclick = e => { e.preventDefault(); void this.app.workspace.openLinkText(have.path, "", false); };
            }
        }

        const go = panel.createEl("button", { cls: "mod-cta nlm-sb-wide" });
        const n = sel.size;
        const updating = [...sel].filter(id => existing.has(id)).length;
        go.setText(n ? `Import ${n}${updating ? ` (${updating} update${updating === 1 ? "" : "s"})` : ""}` : "Select items to import");
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
        this.open.add("sync");
        this.render();
        try {
            this.notebooks = { state: "ready", value: await this.plugin.nlm().listNotebooks() };
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
            this.artifacts.set(nb.id, { state: "ready", value: await this.plugin.nlm().listStudyArtifacts(nb.id) });
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
        this.setBusy("Working…");
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
        row.createEl("button", { text: "Retry" }).onclick = retry;
        row.createEl("button", { text: "Settings" }).onclick = () => this.plugin.openSettings();
    }

    // --- Decks ----------------------------------------------------------------

    private renderDecks(el: HTMLElement) {
        const decks = this.plugin.index.list();
        const body = this.section(el, "decks", "library", "Decks", head => {
            head.createSpan({ cls: "nlm-sb-count", text: String(decks.length) });
        });
        if (!decks.length) {
            body.createDiv({
                cls: "nlm-sb-muted",
                text: "No study notes yet. Import from NotebookLM, or write a > [!flashcard] callout in any note.",
            });
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
            const caret = head.createSpan({ cls: "nlm-sb-caret" });
            setIcon(caret, collapsed ? "chevron-right" : "chevron-down");
            head.createSpan({ cls: "nlm-sb-deck-name", text: name });
            if (items.length) {
                const play = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Study ${name}` } });
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
                chip(stats, "new", c.fresh, "New");
                chip(stats, "learning", c.learning, "Learning");
                chip(stats, "due", c.due, "Due");
                const pct = Math.round((c.review / items.length) * 100);
                const bar = group.createDiv({ cls: "nlm-mini-progress", attr: { "aria-label": `${pct}% learned` } });
                bar.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
            }
            if (collapsed) continue;

            for (const note of notes) {
                const row = group.createDiv({ cls: "nlm-sb-row", attr: { tabindex: "0" } });
                setIcon(row.createSpan({ cls: "nlm-row-icon" }), note.type === "mindmap" ? "network" : note.type === "quiz" ? "list-checks" : "layers");
                const text = row.createDiv({ cls: "nlm-sb-row-text" });
                text.createDiv({ cls: "nlm-sb-row-title", text: note.title });
                const cards = note.items.filter(i => i.kind === "flashcard").length;
                const qs = note.items.filter(i => i.kind === "quiz").length;
                const meta: string[] = [];
                if (note.type === "mindmap") meta.push("mind map");
                if (cards) meta.push(`${cards} cards`);
                if (qs) meta.push(`${qs} questions`);
                const nc = p.stateCounts(p.filterStudyable(note.items).map(i => i.id));
                if (nc.due + nc.learning) meta.push(`${nc.due + nc.learning} due`);
                text.createDiv({ cls: "nlm-sb-row-meta", text: meta.join(" · ") });
                row.onclick = () => void this.app.workspace.openLinkText(note.path, "", false);
                row.onkeydown = e => { if (e.key === "Enter") row.click(); };
            }
        }
    }

    // --- Import file ----------------------------------------------------------

    private renderImport(el: HTMLElement) {
        const body = this.section(el, "import", "file-down", "Import file");
        body.createDiv({ cls: "nlm-sb-muted", text: "CSV or JSON flashcards and quizzes, or a mind map as JSON or a Markdown outline." });
        const pick = body.createEl("button", { cls: "nlm-sb-wide" });
        setIcon(pick.createSpan({ cls: "nlm-btn-icon" }), "upload");
        pick.createSpan({ text: this.draft ? "Choose another file" : "Choose file…" });
        pick.onclick = () => this.pickFile();

        const d = this.draft;
        if (!d) return;
        if (d.error) { body.createDiv({ cls: "nlm-sb-error", text: d.error }); return; }
        if (!d.parsed) return;
        const parsed = d.parsed;

        const card = body.createDiv({ cls: "nlm-sb-draft" });
        const what = parsed.type === "flashcards" ? `${parsed.cards.length} flashcards`
            : parsed.type === "quiz" ? `${parsed.questions.length} quiz questions` : `Mind map · ${parsed.root.children.length} branches`;
        card.createDiv({ cls: "nlm-sb-row-title", text: what });
        card.createDiv({ cls: "nlm-sb-row-meta", text: d.fileName });

        const title = card.createEl("input", { type: "text", attr: { placeholder: "Note title" } });
        title.value = d.title;
        title.oninput = () => (d.title = title.value.trim());
        if (parsed.type !== "mindmap") {
            const deck = card.createEl("input", { type: "text", attr: { placeholder: "Deck (optional)" } });
            deck.value = d.deck;
            deck.oninput = () => (d.deck = deck.value.trim());
        }

        const sample = card.createEl("ul", { cls: "nlm-sb-sample" });
        if (parsed.type === "flashcards") parsed.cards.slice(0, 3).forEach(c => sample.createEl("li", { text: c.front }));
        else if (parsed.type === "quiz") parsed.questions.slice(0, 3).forEach(q => sample.createEl("li", { text: q.question }));
        else parsed.root.children.slice(0, 4).forEach(n => sample.createEl("li", { text: n.name }));

        const actions = card.createDiv({ cls: "nlm-actions" });
        actions.createEl("button", { text: "Cancel" }).onclick = () => { this.draft = null; this.render(); };
        const go = actions.createEl("button", { cls: "mod-cta", text: "Import" });
        go.onclick = () => void this.run(async () => {
            if (!d.title) { new Notice("Enter a title."); return; }
            const res = await this.plugin.writer.write({
                content: parsed, title: d.title, deck: d.deck || undefined, origin: { source: "file" },
            });
            new Notice(`${res.created ? "Imported" : "Updated"} ${res.file.basename}.`);
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
                if (empty) draft.error = "No items found in this file. Is it a NotebookLM export?";
                else { draft.parsed = parsed; draft.title = parsed.title || base; }
            } catch (e) {
                draft.error = (e as Error).message;
            }
            this.draft = draft;
            this.open.add("import");
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

function loading(parent: HTMLElement, text: string) {
    const el = parent.createDiv({ cls: "nlm-sb-busy" });
    el.createDiv({ cls: "nlm-spinner" });
    el.createSpan({ text });
}

export function relativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
    return new Date(t).toLocaleDateString();
}
