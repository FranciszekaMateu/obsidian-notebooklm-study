import { Component, ItemView, MarkdownRenderer, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { Grade, Rating, State } from "ts-fsrs";
import { renderQuizQuestion } from "../blocks";
import type NotebookLMStudy from "../main";
import { DeckInfo } from "../srs/deck-index";
import { GRADES, UndoToken, formatInterval } from "../srs/scheduler";
import { StudyItem } from "../types";

export const STUDY_VIEW = "nlm-study-view";

export interface StudyFilter {
    /** Limit to one note. */
    path?: string;
    /** Limit to one deck name. */
    deck?: string;
}

const LEARN_AHEAD_MS = 20 * 60 * 1000;
const GRADE_LABEL: Record<Grade, string> = {
    [Rating.Again]: "Again",
    [Rating.Hard]: "Hard",
    [Rating.Good]: "Good",
    [Rating.Easy]: "Easy",
};

interface Session {
    filter: StudyFilter;
    queue: StudyItem[];
    learning: { item: StudyItem; due: number }[];
    current: StudyItem | null;
    revealed: boolean;
    quizCorrect: boolean | null;
    answerWith?: (i: number) => void;
    history: { item: StudyItem; token: UndoToken }[];
    done: number;
}

export class StudyView extends ItemView {
    private session: Session | null = null;
    private cardComponent: Component | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return STUDY_VIEW; }
    getDisplayText() { return "NotebookLM study"; }
    getIcon() { return "graduation-cap"; }

    async onOpen() {
        this.contentEl.addClass("nlm-study");
        this.registerEvent(this.plugin.index.on("changed", () => {
            if (!this.session) this.renderDashboard();
        }));
        this.registerDomEvent(this.contentEl, "keydown", e => this.onKey(e));
        this.contentEl.tabIndex = 0;
        this.renderDashboard();
    }

    async onClose() {
        this.cardComponent?.unload();
    }

    // --- Dashboard ----------------------------------------------------------

    renderDashboard() {
        this.session = null;
        this.cardComponent?.unload();
        this.cardComponent = null;
        const el = this.contentEl;
        el.empty();

        const header = el.createDiv({ cls: "nlm-dash-header" });
        header.createEl("h2", { text: "NotebookLM study" });
        const actions = header.createDiv({ cls: "nlm-actions" });
        if (Platform.isDesktopApp) {
            const sync = actions.createEl("button", { text: "Sync from NotebookLM" });
            setIcon(sync.createSpan({ cls: "nlm-btn-icon" }), "refresh-cw");
            sync.onclick = () => this.plugin.openSyncModal();
        }
        actions.createEl("button", { text: "Import file" }).onclick = () => this.plugin.openImportModal();

        if (!this.plugin.index.ready) {
            el.createDiv({ cls: "nlm-empty", text: "Indexing vault…" });
            return;
        }

        const decks = this.plugin.index.list();
        const studyable = this.plugin.studyableItems();
        const ids = studyable.map(i => i.id);
        const avail = this.plugin.countAvailable(studyable);
        const stats = this.plugin.scheduler.stats();

        const tiles = el.createDiv({ cls: "nlm-tiles" });
        tile(tiles, "Due today", String(avail.due));
        tile(tiles, "New today", String(avail.fresh));
        tile(tiles, "Reviewed today", String(stats.reviewedToday));
        tile(tiles, "Retention (30d)", stats.retention30d === null ? "—" : `${Math.round(stats.retention30d * 100)}%`);
        tile(tiles, "Streak", `${stats.streak} ${stats.streak === 1 ? "day" : "days"}`);

        const studyAll = el.createEl("button", {
            cls: "mod-cta nlm-study-all",
            text: avail.due + avail.fresh > 0 ? `Study now (${avail.due + avail.fresh})` : "Nothing due — study ahead",
        });
        studyAll.onclick = () => this.startSession({});

        this.renderForecast(el, ids);

        if (!decks.length) {
            const empty = el.createDiv({ cls: "nlm-empty" });
            empty.createEl("p", { text: "No NotebookLM content yet." });
            empty.createEl("p", {
                text: Platform.isDesktopApp
                    ? "Sync a notebook with the nlm CLI, or import a CSV/JSON export."
                    : "Import a CSV/JSON export, or sync from the desktop app.",
            });
            return;
        }

        // Group notes under their deck name.
        const groups = new Map<string, DeckInfo[]>();
        for (const d of decks) {
            if (!groups.has(d.deck)) groups.set(d.deck, []);
            groups.get(d.deck)!.push(d);
        }

        const list = el.createDiv({ cls: "nlm-deck-list" });
        for (const [deckName, notes] of groups) {
            const group = list.createDiv({ cls: "nlm-deck-group" });
            const gh = group.createDiv({ cls: "nlm-deck-group-header" });
            gh.createSpan({ cls: "nlm-deck-name", text: deckName });
            const groupItems = notes.flatMap(n => this.plugin.filterStudyable(n.items));
            const ga = this.plugin.countAvailable(groupItems);
            if (groupItems.length) {
                counts(gh, ga.fresh, ga.due);
                gh.createEl("button", { text: "Study deck" }).onclick = () => this.startSession({ deck: deckName });
            }

            for (const note of notes) {
                const row = group.createDiv({ cls: "nlm-deck-row" });
                setIcon(row.createSpan({ cls: "nlm-row-icon" }), iconFor(note.type));
                const link = row.createEl("a", { cls: "nlm-row-title", text: note.title });
                link.onclick = () => this.app.workspace.openLinkText(note.path, "", false);

                if (note.type === "mindmap") {
                    row.createSpan({ cls: "nlm-row-meta", text: "mind map" });
                    continue;
                }
                const items = this.plugin.filterStudyable(note.items);
                row.createSpan({ cls: "nlm-row-meta", text: `${note.items.length} ${note.type === "quiz" ? "questions" : "cards"}` });
                if (!items.length) continue;
                const a = this.plugin.countAvailable(items);
                counts(row, a.fresh, a.due);
                const b = row.createEl("button", { attr: { "aria-label": "Study this note" } });
                setIcon(b, "play");
                b.onclick = () => this.startSession({ path: note.path });
            }
        }
    }

    private renderForecast(el: HTMLElement, ids: string[]) {
        const days = 14;
        const data = this.plugin.scheduler.forecast(ids, days);
        if (!data.some(n => n > 0)) return;
        const max = Math.max(...data);
        const wrap = el.createDiv({ cls: "nlm-forecast" });
        wrap.createDiv({ cls: "nlm-forecast-title", text: "Upcoming reviews (14 days)" });
        const bars = wrap.createDiv({ cls: "nlm-forecast-bars" });
        data.forEach((n, i) => {
            const col = bars.createDiv({ cls: "nlm-forecast-col", attr: { "aria-label": `${i === 0 ? "Today" : `In ${i}d`}: ${n}` } });
            col.createDiv({ cls: "nlm-forecast-value", text: n ? String(n) : "" });
            const bar = col.createDiv({ cls: "nlm-forecast-bar" });
            bar.style.height = `${max ? Math.max(n ? 4 : 0, (n / max) * 100) : 0}%`;
            col.createDiv({ cls: "nlm-forecast-label", text: i === 0 ? "T" : String(i) });
        });
    }

    // --- Session ------------------------------------------------------------

    startSession(filter: StudyFilter) {
        const items = this.plugin.studyableItems(filter);
        const sched = this.plugin.scheduler;
        const now = Date.now();
        const dayEnd = sched.dayEnd(now);
        const stats = sched.stats(now);
        const s = this.plugin.settings;

        const learning: Session["learning"] = [];
        const reviews: StudyItem[] = [];
        const fresh: StudyItem[] = [];
        for (const item of items) {
            const st = sched.stored(item.id);
            if (!st || st.state === State.New) fresh.push(item);
            else if (st.state === State.Review) { if (st.due < dayEnd) reviews.push(item); }
            else if (st.due < dayEnd) learning.push({ item, due: st.due });
        }

        reviews.sort((a, b) => sched.stored(a.id)!.due - sched.stored(b.id)!.due);
        const reviewCap = Math.max(0, s.maxReviewsPerDay - (stats.reviewedToday - stats.newToday));
        const newCap = Math.max(0, s.newPerDay - stats.newToday);
        let queue = interleave(reviews.slice(0, reviewCap), fresh.slice(0, newCap));

        // Nothing scheduled: let the user study ahead with the earliest upcoming cards.
        if (!queue.length && !learning.length) {
            queue = items
                .filter(i => sched.has(i.id))
                .sort((a, b) => sched.stored(a.id)!.due - sched.stored(b.id)!.due)
                .slice(0, 20);
            if (!queue.length) queue = fresh.slice(0, 20);
        }

        this.session = { filter, queue, learning, current: null, revealed: false, quizCorrect: null, history: [], done: 0 };
        this.next();
    }

    private next() {
        const s = this.session!;
        const now = Date.now();
        s.learning.sort((a, b) => a.due - b.due);

        let item: StudyItem | undefined;
        if (s.learning.length && s.learning[0].due <= now) item = s.learning.shift()!.item;
        else if (s.queue.length) item = s.queue.shift();
        else if (s.learning.length && s.learning[0].due <= now + LEARN_AHEAD_MS) item = s.learning.shift()!.item;

        s.current = item ?? null;
        s.revealed = false;
        s.quizCorrect = null;
        s.answerWith = undefined;
        void this.renderSession();
    }

    private async renderSession() {
        const s = this.session!;
        this.cardComponent?.unload();
        this.cardComponent = new Component();
        this.cardComponent.load();
        const comp = this.cardComponent;

        const el = this.contentEl;
        el.empty();
        const top = el.createDiv({ cls: "nlm-session-top" });
        const back = top.createEl("button", { attr: { "aria-label": "Back to dashboard" } });
        setIcon(back, "arrow-left");
        back.onclick = () => this.renderDashboard();
        const remaining = s.queue.length + s.learning.length + (s.current ? 1 : 0);
        top.createSpan({ cls: "nlm-session-count", text: `${s.done} done · ${remaining} left` });
        if (s.history.length) {
            const undo = top.createEl("button", { text: "Undo", attr: { "aria-label": "Undo last answer (U)" } });
            undo.onclick = () => this.undo();
        }

        if (!s.current) {
            const done = el.createDiv({ cls: "nlm-session-done" });
            setIcon(done.createDiv({ cls: "nlm-done-icon" }), "party-popper");
            done.createEl("h3", { text: "Session complete" });
            const later = s.learning.length;
            done.createEl("p", {
                text: later
                    ? `${s.done} reviewed. ${later} learning card${later > 1 ? "s" : ""} will be due again later today.`
                    : `${s.done} reviewed.`,
            });
            done.createEl("button", { cls: "mod-cta", text: "Back to dashboard" }).onclick = () => this.renderDashboard();
            await this.plugin.saveSettings();
            return;
        }

        const item = s.current;
        const card = el.createDiv({ cls: "nlm-review-card" });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        meta.createSpan({ text: item.deck });
        const stateLabel = stateName(this.plugin.scheduler.stored(item.id)?.state);
        meta.createSpan({ cls: `nlm-state nlm-state-${stateLabel.toLowerCase()}`, text: stateLabel });
        const open = meta.createEl("a", { text: "Open note" });
        open.onclick = () => this.app.workspace.openLinkText(item.path, "", "split");

        const body = card.createDiv({ cls: "nlm-review-body" });

        if (item.kind === "flashcard") {
            const front = body.createDiv({ cls: "nlm-review-front" });
            await MarkdownRenderer.render(this.app, item.card.front, front, item.path, comp);
            if (s.revealed) {
                body.createEl("hr");
                const backEl = body.createDiv({ cls: "nlm-review-back" });
                await MarkdownRenderer.render(this.app, item.card.back, backEl, item.path, comp);
                this.renderGrades(el, null);
            } else {
                const btn = el.createEl("button", { cls: "mod-cta nlm-reveal", text: "Show answer" });
                btn.createSpan({ cls: "nlm-kbd", text: "Space" });
                btn.onclick = () => { s.revealed = true; void this.renderSession(); };
            }
        } else {
            const { answerWith } = await renderQuizQuestion(this.plugin, body, item.question, item.path, comp, correct => {
                s.revealed = true;
                s.quizCorrect = correct;
                this.renderGrades(el, correct ? Rating.Good : Rating.Again);
            });
            s.answerWith = answerWith;
            if (!s.revealed) el.createDiv({ cls: "nlm-hint-keys", text: "Press A–" + String.fromCharCode(64 + item.question.options.length) + " to answer" });
        }
        this.contentEl.focus();
    }

    private renderGrades(el: HTMLElement, suggested: Grade | null) {
        const s = this.session!;
        el.querySelector(".nlm-grades")?.remove();
        el.querySelector(".nlm-hint-keys")?.remove();
        const now = Date.now();
        const preview = this.plugin.scheduler.preview(s.current!.id, now);
        const row = el.createDiv({ cls: "nlm-grades" });
        GRADES.forEach((g, i) => {
            const b = row.createEl("button", { cls: `nlm-grade nlm-grade-${GRADE_LABEL[g].toLowerCase()}` });
            if (g === suggested) b.addClass("is-suggested");
            b.createDiv({ cls: "nlm-grade-label", text: GRADE_LABEL[g] });
            b.createDiv({ cls: "nlm-grade-ivl", text: formatInterval(now, preview[g].getTime()) });
            b.createSpan({ cls: "nlm-kbd", text: String(i + 1) });
            b.onclick = () => this.grade(g);
        });
    }

    private grade(g: Grade) {
        const s = this.session;
        if (!s?.current || !s.revealed) return;
        const item = s.current;
        const token = this.plugin.scheduler.review(item.id, g);
        s.history.push({ item, token });
        s.done++;

        const st = this.plugin.scheduler.stored(item.id)!;
        if (st.state !== State.Review && st.due < this.plugin.scheduler.dayEnd()) {
            s.learning.push({ item, due: st.due });
        }
        this.plugin.requestSave();
        this.plugin.index.trigger("reviewed");
        this.next();
    }

    private undo() {
        const s = this.session;
        const last = s?.history.pop();
        if (!s || !last) return;
        this.plugin.scheduler.undo(last.token);
        s.learning = s.learning.filter(l => l.item.id !== last.item.id);
        if (s.current) s.queue.unshift(s.current);
        s.done = Math.max(0, s.done - 1);
        s.current = last.item;
        s.revealed = false;
        s.quizCorrect = null;
        this.plugin.requestSave();
        void this.renderSession();
    }

    private onKey(e: KeyboardEvent) {
        const s = this.session;
        if (!s?.current || e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        const key = e.key.toLowerCase();

        if (key === "u") { e.preventDefault(); this.undo(); return; }

        if (!s.revealed) {
            if (s.current.kind === "flashcard" && (key === " " || key === "enter")) {
                e.preventDefault();
                s.revealed = true;
                void this.renderSession();
            } else if (s.current.kind === "quiz" && /^[a-h]$/.test(key)) {
                e.preventDefault();
                s.answerWith?.(key.charCodeAt(0) - 97);
            }
            return;
        }

        if (/^[1-4]$/.test(key)) {
            e.preventDefault();
            this.grade(GRADES[Number(key) - 1]);
        } else if (key === " " || key === "enter") {
            e.preventDefault();
            this.grade(s.quizCorrect === false ? Rating.Again : Rating.Good);
        }
    }
}

function tile(parent: HTMLElement, label: string, value: string) {
    const t = parent.createDiv({ cls: "nlm-tile" });
    t.createDiv({ cls: "nlm-tile-value", text: value });
    t.createDiv({ cls: "nlm-tile-label", text: label });
}

function counts(parent: HTMLElement, fresh: number, due: number) {
    const c = parent.createDiv({ cls: "nlm-counts" });
    c.createSpan({ cls: "nlm-count-new", text: String(fresh), attr: { "aria-label": "New" } });
    c.createSpan({ cls: "nlm-count-due", text: String(due), attr: { "aria-label": "Due" } });
}

function iconFor(type: string): string {
    return type === "quiz" ? "list-checks" : type === "mindmap" ? "network" : "layers";
}

function stateName(state: State | undefined): string {
    switch (state) {
        case State.Learning: return "Learning";
        case State.Review: return "Review";
        case State.Relearning: return "Relearning";
        default: return "New";
    }
}

/** Spread new cards evenly through the reviews. */
function interleave(reviews: StudyItem[], fresh: StudyItem[]): StudyItem[] {
    if (!fresh.length) return reviews;
    if (!reviews.length) return fresh;
    const out: StudyItem[] = [];
    const step = Math.max(1, Math.floor(reviews.length / fresh.length));
    let f = 0;
    reviews.forEach((r, i) => {
        out.push(r);
        if ((i + 1) % step === 0 && f < fresh.length) out.push(fresh[f++]);
    });
    while (f < fresh.length) out.push(fresh[f++]);
    return out;
}
