import { Component, ItemView, MarkdownRenderer, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Rating, State } from "ts-fsrs";
import { clozePlain, renderCloze } from "../cloze";
import { locale, t, tn } from "../i18n";
import type NotebookLMStudy from "../main";
import { StudyItem, itemPrompt } from "../types";

export const BROWSER_VIEW = "nlm-browser-view";

type SortKey = "prompt" | "kind" | "deck" | "state" | "due" | "interval" | "reps" | "lapses" | "difficulty" | "recall";
type StateFilter = "all" | "new" | "learning" | "review" | "due" | "suspended";

interface Row {
    item: StudyItem;
    prompt: string;
    state: State | null;
    due: number | null;
    interval: number | null;
    reps: number;
    lapses: number;
    difficulty: number | null;
    recall: number | null;
    suspended: boolean;
}

const PAGE = 200;

/** Searchable table of every card, with per-card history and actions. */
export class BrowserView extends ItemView {
    private query = "";
    private deck = "";
    private kind = "";
    private state: StateFilter = "all";
    private sort: SortKey = "due";
    private desc = false;
    private limit = PAGE;
    private selected: string | null = null;
    private detailComponent = new Component();
    private tableEl!: HTMLElement;
    private detailEl!: HTMLElement;
    private countEl!: HTMLElement;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return BROWSER_VIEW; }
    getDisplayText() { return t("Card browser"); }
    getIcon() { return "table"; }

    async onOpen() {
        this.contentEl.addClass("nlm-browser");
        this.addChild(this.detailComponent);
        this.registerEvent(this.plugin.index.on("changed", () => this.renderTable()));
        this.registerEvent(this.plugin.index.on("reviewed", () => this.renderTable()));
        this.refresh();
    }

    refresh() {
        const el = this.contentEl;
        el.empty();
        this.renderToolbar(el);
        const body = el.createDiv({ cls: "nlm-br-body" });
        this.tableEl = body.createDiv({ cls: "nlm-br-table" });
        this.detailEl = body.createDiv({ cls: "nlm-br-detail" });
        this.renderTable();
        this.renderDetail();
    }

    search(query: string) {
        this.query = query;
        this.refresh();
    }

    private renderToolbar(el: HTMLElement) {
        const bar = el.createDiv({ cls: "nlm-br-toolbar" });
        const search = bar.createEl("input", { type: "search", attr: { placeholder: t("Search cards…") } });
        search.value = this.query;
        search.oninput = () => { this.query = search.value; this.limit = PAGE; this.renderTable(); };

        const decks = [...new Set(this.plugin.index.items().map(i => i.deck))].sort();
        const deckSel = select(bar, [["", t("All decks")], ...decks.map(d => [d, d] as [string, string])], this.deck, v => { this.deck = v; this.renderTable(); });
        deckSel.addClass("nlm-br-deck");
        select(bar, [["", t("All types")], ["flashcard", t("Flashcards")], ["cloze", t("Cloze")], ["quiz", t("Quiz")]], this.kind, v => { this.kind = v; this.renderTable(); });
        select(bar, [
            ["all", t("Any state")], ["new", t("New")], ["learning", t("Learning")], ["review", t("Review")],
            ["due", t("Due today")], ["suspended", t("Suspended")],
        ], this.state, v => { this.state = v as StateFilter; this.renderTable(); });

        this.countEl = bar.createSpan({ cls: "nlm-muted nlm-small nlm-br-count" });
        const study = bar.createEl("button", { cls: "mod-cta" });
        setIcon(study.createSpan({ cls: "nlm-btn-icon" }), "play");
        study.createSpan({ text: t("Study these") });
        study.onclick = () => {
            const ids = this.rows().filter(r => !r.suspended).map(r => r.item.id);
            if (ids.length) void this.plugin.openStudy({ ids, title: t("Selected cards") });
        };
    }

    private rows(): Row[] {
        const sched = this.plugin.scheduler;
        const now = Date.now();
        const dayEnd = sched.dayEnd(now);
        const q = this.query.trim().toLowerCase();
        const rows: Row[] = [];
        for (const item of this.plugin.index.items()) {
            if (this.deck && item.deck !== this.deck) continue;
            if (this.kind && item.kind !== this.kind) continue;
            const prompt = item.kind === "cloze" ? clozePlain(item.cloze.text) : itemPrompt(item);
            if (q && !(`${prompt}\n${answerText(item)}\n${item.deck}`.toLowerCase().includes(q))) continue;
            const s = sched.stored(item.id);
            const suspended = sched.isSuspended(item.id);
            const state = s ? s.state : null;
            const isNew = !s || s.state === State.New;
            if (this.state === "suspended" && !suspended) continue;
            if (this.state === "new" && !isNew) continue;
            if (this.state === "learning" && !(s && (s.state === State.Learning || s.state === State.Relearning))) continue;
            if (this.state === "review" && !(s && s.state === State.Review)) continue;
            if (this.state === "due" && !(s && !isNew && s.due < dayEnd)) continue;
            rows.push({
                item, prompt, state, suspended,
                due: s && !isNew ? s.due : null,
                interval: s && s.state === State.Review ? s.scheduled_days : null,
                reps: s?.reps ?? 0,
                lapses: s?.lapses ?? 0,
                difficulty: s && !isNew ? s.difficulty : null,
                recall: sched.retrievability(item.id, now),
            });
        }
        const dir = this.desc ? -1 : 1;
        const val = (r: Row): number | string => {
            switch (this.sort) {
                case "prompt": return r.prompt.toLowerCase();
                case "kind": return r.item.kind;
                case "deck": return r.item.deck.toLowerCase();
                case "state": return r.state ?? -1;
                case "due": return r.due ?? Number.MAX_SAFE_INTEGER;
                case "interval": return r.interval ?? -1;
                case "reps": return r.reps;
                case "lapses": return r.lapses;
                case "difficulty": return r.difficulty ?? -1;
                case "recall": return r.recall ?? 2;
            }
        };
        return rows.sort((a, b) => {
            const x = val(a), y = val(b);
            return (x < y ? -1 : x > y ? 1 : 0) * dir;
        });
    }

    private renderTable() {
        if (!this.tableEl) return;
        const rows = this.rows();
        this.countEl?.setText(tn(rows.length, "{n} card", "{n} cards"));
        const el = this.tableEl;
        el.empty();
        if (!rows.length) {
            el.createDiv({ cls: "nlm-empty", text: t("No cards match.") });
            return;
        }

        const table = el.createEl("table", { cls: "nlm-deck-table nlm-br-grid" });
        const head = table.createEl("thead").createEl("tr");
        const cols: [SortKey, string][] = [
            ["prompt", t("Card")], ["kind", t("Type")], ["deck", t("Deck")], ["state", t("State")], ["due", t("Due")],
            ["interval", t("Interval")], ["reps", t("Reviews")], ["lapses", t("Lapses")], ["difficulty", t("Difficulty")], ["recall", t("Recall")],
        ];
        for (const [key, label] of cols) {
            const th = head.createEl("th", { text: label, cls: "is-sortable" + (this.sort === key ? " is-sorted" : "") });
            if (this.sort === key) th.createSpan({ text: this.desc ? " ↓" : " ↑" });
            th.onclick = () => {
                if (this.sort === key) this.desc = !this.desc;
                else { this.sort = key; this.desc = false; }
                this.renderTable();
            };
        }
        const tbody = table.createEl("tbody");
        for (const r of rows.slice(0, this.limit)) {
            const tr = tbody.createEl("tr", { cls: (r.item.id === this.selected ? "is-selected" : "") + (r.suspended ? " is-suspended" : "") });
            tr.createEl("td", { cls: "nlm-td-name nlm-br-prompt", text: truncate(r.prompt, 120) });
            tr.createEl("td", { text: kindName(r.item) });
            tr.createEl("td", { cls: "nlm-br-deckcell", text: r.item.deck });
            tr.createEl("td", { cls: `nlm-state-${stateKey(r)}`, text: stateLabel(r) });
            tr.createEl("td", { text: r.due === null ? "—" : relativeDay(r.due) });
            tr.createEl("td", { text: r.interval === null ? "—" : `${r.interval} d` });
            tr.createEl("td", { text: String(r.reps) });
            tr.createEl("td", { text: String(r.lapses) });
            tr.createEl("td", { text: r.difficulty === null ? "—" : r.difficulty.toFixed(1) });
            tr.createEl("td", { text: r.recall === null ? "—" : `${Math.round(r.recall * 100)}%` });
            tr.onclick = () => { this.selected = r.item.id; this.renderTable(); this.renderDetail(); };
        }
        if (rows.length > this.limit) {
            const more = el.createEl("button", { cls: "nlm-br-more", text: t("Show {n} more", { n: Math.min(PAGE, rows.length - this.limit) }) });
            more.onclick = () => { this.limit += PAGE; this.renderTable(); };
        }
    }

    private renderDetail() {
        const el = this.detailEl;
        if (!el) return;
        el.empty();
        this.detailComponent.unload();
        this.detailComponent = this.addChild(new Component());
        const item = this.selected ? this.plugin.index.items().find(i => i.id === this.selected) : undefined;
        if (!item) {
            el.createDiv({ cls: "nlm-empty", text: t("Select a card to see its details and history.") });
            return;
        }
        const sched = this.plugin.scheduler;
        const s = sched.stored(item.id);
        const comp = this.detailComponent;

        const head = el.createDiv({ cls: "nlm-br-detail-head" });
        head.createSpan({ cls: "nlm-state", text: kindName(item) });
        head.createSpan({ cls: "nlm-muted nlm-small", text: item.deck });

        const front = el.createDiv({ cls: "nlm-br-side" });
        front.createDiv({ cls: "nlm-br-side-label", text: t("Front") });
        const frontBody = front.createDiv();
        const back = el.createDiv({ cls: "nlm-br-side" });
        back.createDiv({ cls: "nlm-br-side-label", text: t("Answer") });
        const backBody = back.createDiv();
        if (item.kind === "flashcard") {
            void MarkdownRenderer.render(this.app, item.card.front, frontBody, item.path, comp);
            void MarkdownRenderer.render(this.app, item.card.back, backBody, item.path, comp);
        } else if (item.kind === "cloze") {
            void MarkdownRenderer.render(this.app, renderCloze(item.cloze.text, item.group, "front"), frontBody, item.path, comp);
            void MarkdownRenderer.render(this.app, renderCloze(item.cloze.text, item.group, "back"), backBody, item.path, comp);
        } else {
            void MarkdownRenderer.render(this.app, item.question.question, frontBody, item.path, comp);
            const ul = backBody.createEl("ul", { cls: "nlm-br-options" });
            for (const o of item.question.options) ul.createEl("li", { cls: o.correct ? "is-correct" : "", text: o.text });
        }

        const stats = el.createDiv({ cls: "nlm-br-stats" });
        const stat = (label: string, value: string) => {
            const d = stats.createDiv();
            d.createDiv({ cls: "nlm-muted nlm-small", text: label });
            d.createDiv({ text: value });
        };
        const recall = sched.retrievability(item.id);
        stat(t("State"), sched.isSuspended(item.id) ? t("Suspended") : stateNameOf(s?.state));
        stat(t("Due"), s && s.state !== State.New ? new Date(s.due).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) : "—");
        stat(t("Stability"), s && s.state !== State.New ? `${s.stability.toFixed(1)} d` : "—");
        stat(t("Difficulty"), s && s.state !== State.New ? s.difficulty.toFixed(2) : "—");
        stat(t("Recall now"), recall === null ? "—" : `${Math.round(recall * 100)}%`);
        stat(t("Reviews / lapses"), `${s?.reps ?? 0} / ${s?.lapses ?? 0}`);

        const actions = el.createDiv({ cls: "nlm-actions" });
        button(actions, "file-symlink", t("Open in note"), async () => {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) await this.app.workspace.getLeaf("split").openFile(file, item.line !== undefined ? { eState: { line: item.line } } : undefined);
        });
        button(actions, "play", t("Study"), () => void this.plugin.openStudy({ ids: [item.id], title: truncate(itemPrompt(item), 40) }));
        const suspended = sched.isSuspended(item.id);
        button(actions, suspended ? "play-circle" : "pause-circle", suspended ? t("Unsuspend") : t("Suspend"), () => {
            sched.setSuspended(item.id, !suspended);
            this.plugin.requestSave();
            this.plugin.index.trigger("reviewed");
            this.renderDetail();
        });
        button(actions, "rotate-ccw", t("Reset progress"), () => {
            if (!confirm(t("Forget the review history of this card?"))) return;
            sched.reset(item.id);
            this.plugin.requestSave();
            this.plugin.index.trigger("reviewed");
            this.renderDetail();
        });

        const history = sched.history(item.id);
        const h = el.createDiv({ cls: "nlm-br-history" });
        h.createDiv({ cls: "nlm-panel-title", text: t("History") });
        if (!history.length) h.createDiv({ cls: "nlm-muted nlm-small", text: t("Never reviewed.") });
        for (const e of history.slice().reverse()) {
            const row = h.createDiv({ cls: "nlm-br-history-row" });
            row.createSpan({ cls: "nlm-muted", text: new Date(e.t).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) });
            row.createSpan({ cls: `nlm-grade-tag nlm-grade-${["", "again", "hard", "good", "easy"][e.rating]}`, text: ratingName(e.rating) });
        }
    }
}

function select(parent: HTMLElement, options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = parent.createEl("select", { cls: "dropdown" });
    for (const [v, l] of options) s.createEl("option", { value: v, text: l });
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
}

function button(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createEl("button");
    setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
    b.createSpan({ text: label });
    b.onclick = onClick;
}

function answerText(item: StudyItem): string {
    if (item.kind === "flashcard") return item.card.back;
    if (item.kind === "quiz") return item.question.options.map(o => o.text).join(" ");
    return "";
}

function kindName(item: StudyItem): string {
    if (item.kind === "quiz") return t("Quiz");
    if (item.kind === "cloze") return t("Cloze");
    return item.reversed ? t("Reversed") : t("Flashcard");
}

function stateKey(r: Row): string {
    if (r.suspended) return "suspended";
    switch (r.state) {
        case State.Learning: case State.Relearning: return "learning";
        case State.Review: return "review";
        default: return "new";
    }
}

function stateLabel(r: Row): string {
    return r.suspended ? t("Suspended") : stateNameOf(r.state ?? undefined);
}

function stateNameOf(state: State | undefined): string {
    switch (state) {
        case State.Learning: return t("Learning");
        case State.Review: return t("Review");
        case State.Relearning: return t("Relearning");
        default: return t("New");
    }
}

function ratingName(r: number): string {
    return r === Rating.Again ? t("Again") : r === Rating.Hard ? t("Hard") : r === Rating.Good ? t("Good") : t("Easy");
}

function relativeDay(ts: number): string {
    const days = Math.round((ts - Date.now()) / 86_400_000);
    if (days === 0) return t("today");
    if (days === 1) return t("tomorrow");
    if (days < 0) return tn(-days, "{n} day late", "{n} days late");
    return tn(days, "in {n} day", "in {n} days");
}

function truncate(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
