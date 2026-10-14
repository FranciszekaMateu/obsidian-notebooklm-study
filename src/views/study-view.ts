import { Component, ItemView, MarkdownRenderer, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Grade, Rating, State } from "ts-fsrs";
import { renderQuizQuestion } from "../blocks";
import type NotebookLMStudy from "../main";
import { DeckInfo } from "../srs/deck-index";
import { GRADES, UndoToken, formatInterval } from "../srs/scheduler";
import { QuizQuestion, StudyItem } from "../types";

export const STUDY_VIEW = "nlm-study-view";

export interface StudyFilter {
    /** Limit to one note. */
    path?: string;
    /** Limit to one deck name. */
    deck?: string;
}

const LEARN_AHEAD_MS = 20 * 60 * 1000;
const MATURE_DAYS = 21;
const GRADE_LABEL: Record<Grade, string> = {
    [Rating.Again]: "Again",
    [Rating.Hard]: "Hard",
    [Rating.Good]: "Good",
    [Rating.Easy]: "Easy",
};

interface Session {
    filter: StudyFilter;
    title: string;
    total: number;
    queue: StudyItem[];
    learning: { item: StudyItem; due: number }[];
    current: StudyItem | null;
    revealed: boolean;
    quizCorrect: boolean | null;
    answerWith?: (i: number) => void;
    history: { item: StudyItem; token: UndoToken }[];
    done: number;
    again: number;
}

interface QuizRun {
    path: string;
    title: string;
    questions: QuizQuestion[];
    order: number[];
    pos: number;
    correct: number;
    missed: number[];
    answered: boolean;
    answerWith?: (i: number) => void;
}

export class StudyView extends ItemView {
    private session: Session | null = null;
    private quiz: QuizRun | null = null;
    private cardComponent: Component | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return STUDY_VIEW; }
    getDisplayText() { return this.session ? "Review" : this.quiz ? "Quiz" : "Study dashboard"; }
    getIcon() { return "graduation-cap"; }

    async onOpen() {
        this.contentEl.addClass("nlm-study");
        this.registerEvent(this.plugin.index.on("changed", () => {
            if (!this.session && !this.quiz) this.renderDashboard();
        }));
        this.registerDomEvent(this.contentEl, "keydown", e => this.onKey(e));
        this.contentEl.tabIndex = 0;
        this.renderDashboard();
    }

    async onClose() {
        this.cardComponent?.unload();
    }

    private freshComponent(): Component {
        this.cardComponent?.unload();
        this.cardComponent = new Component();
        this.cardComponent.load();
        return this.cardComponent;
    }

    // --- Dashboard ----------------------------------------------------------

    renderDashboard() {
        this.session = null;
        this.quiz = null;
        this.cardComponent?.unload();
        this.cardComponent = null;
        const p = this.plugin;
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page" });

        const header = page.createDiv({ cls: "nlm-dash-header" });
        const titleWrap = header.createDiv();
        titleWrap.createEl("h2", { text: "Study dashboard" });
        titleWrap.createDiv({ cls: "nlm-muted", text: new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) });
        const actions = header.createDiv({ cls: "nlm-actions" });
        iconButton(actions, "panel-right", "Open panel", () => void p.openSidebar());
        if (Platform.isDesktopApp) iconButton(actions, "cloud-download", "Add from NotebookLM", () => void p.openSidebar("sync"));

        if (!p.index.ready) {
            page.createDiv({ cls: "nlm-empty", text: "Indexing vault…" });
            return;
        }

        const items = p.studyableItems();
        const ids = items.map(i => i.id);
        const c = p.stateCounts(ids);
        const stats = p.scheduler.stats();
        const newToday = Math.min(c.fresh, p.newLeftToday());
        const todo = c.due + c.learning + newToday;

        // Hero: what to do now.
        const hero = page.createDiv({ cls: "nlm-hero" });
        const heroText = hero.createDiv({ cls: "nlm-hero-text" });
        heroText.createDiv({ cls: "nlm-hero-number", text: String(todo) });
        heroText.createDiv({
            cls: "nlm-hero-label",
            text: todo ? `cards to study today · ${c.due} review · ${c.learning} learning · ${newToday} new` : items.length ? "You're all caught up for today" : "No cards yet",
        });
        const start = hero.createEl("button", { cls: "mod-cta nlm-hero-btn" });
        setIcon(start.createSpan({ cls: "nlm-btn-icon" }), "play");
        start.createSpan({ text: todo ? "Start review" : "Study ahead" });
        start.disabled = !items.length;
        start.onclick = () => this.startSession({});

        const tiles = page.createDiv({ cls: "nlm-tiles" });
        tile(tiles, "check-circle", String(stats.reviewedToday), "reviewed today",
            stats.accuracyToday === null ? "" : `${Math.round(stats.accuracyToday * 100)}% correct`);
        tile(tiles, "target", stats.retention30d === null ? "—" : `${Math.round(stats.retention30d * 100)}%`, "retention (30 days)",
            `goal ${Math.round(p.settings.desiredRetention * 100)}%`);
        tile(tiles, "flame", String(stats.streak), stats.streak === 1 ? "day streak" : "days streak", "");
        tile(tiles, "layers", String(items.length), "cards in total",
            `${p.index.list().filter(d => d.items.length).length} notes`);

        if (!items.length) {
            this.renderEmpty(page);
            return;
        }

        const grid = page.createDiv({ cls: "nlm-dash-grid" });
        this.renderStates(grid.createDiv({ cls: "nlm-panel" }), ids);
        this.renderForecast(grid.createDiv({ cls: "nlm-panel" }), ids);
        this.renderHeatmap(page.createDiv({ cls: "nlm-panel" }));
        this.renderDeckTable(page.createDiv({ cls: "nlm-panel" }));
    }

    private renderEmpty(page: HTMLElement) {
        const empty = page.createDiv({ cls: "nlm-panel nlm-empty-state" });
        setIcon(empty.createDiv({ cls: "nlm-empty-icon" }), "sparkles");
        empty.createEl("h3", { text: "Bring in your first deck" });
        empty.createEl("p", { text: "Import flashcards, quizzes or mind maps from NotebookLM, or write cards yourself in any note:" });
        empty.createEl("pre", { text: "> [!flashcard]- What is a perceptron?\n> A single artificial neuron." });
        const row = empty.createDiv({ cls: "nlm-actions" });
        if (Platform.isDesktopApp) row.createEl("button", { cls: "mod-cta", text: "Add from NotebookLM" }).onclick = () => void this.plugin.openSidebar("sync");
        row.createEl("button", { text: "Import a file" }).onclick = () => void this.plugin.openSidebar("import");
    }

    private renderStates(panel: HTMLElement, ids: string[]) {
        panel.createDiv({ cls: "nlm-panel-title", text: "Card states" });
        let fresh = 0, learning = 0, young = 0, mature = 0;
        for (const id of ids) {
            const s = this.plugin.scheduler.stored(id);
            if (!s || s.state === State.New) fresh++;
            else if (s.state !== State.Review) learning++;
            else if (s.scheduled_days >= MATURE_DAYS) mature++;
            else young++;
        }
        const total = ids.length || 1;
        const parts: [string, string, number][] = [
            ["new", "New", fresh], ["learning", "Learning", learning], ["young", "Young", young], ["mature", "Mature", mature],
        ];
        const bar = panel.createDiv({ cls: "nlm-stack" });
        for (const [cls, label, n] of parts) {
            if (!n) continue;
            const seg = bar.createDiv({ cls: `nlm-stack-seg nlm-seg-${cls}`, attr: { "aria-label": `${label}: ${n}` } });
            seg.style.width = `${(n / total) * 100}%`;
        }
        const legend = panel.createDiv({ cls: "nlm-legend" });
        for (const [cls, label, n] of parts) {
            const item = legend.createDiv({ cls: "nlm-legend-item" });
            item.createSpan({ cls: `nlm-legend-dot nlm-seg-${cls}` });
            item.createSpan({ text: label });
            item.createSpan({ cls: "nlm-legend-value", text: `${n} · ${Math.round((n / total) * 100)}%` });
        }
        panel.createDiv({ cls: "nlm-muted nlm-small", text: `Mature cards have an interval of ${MATURE_DAYS} days or more.` });
    }

    private renderForecast(panel: HTMLElement, ids: string[]) {
        const days = 14;
        const data = this.plugin.scheduler.forecast(ids, days);
        panel.createDiv({ cls: "nlm-panel-title", text: "Upcoming reviews" });
        const max = Math.max(1, ...data);
        const bars = panel.createDiv({ cls: "nlm-forecast-bars" });
        const today = new Date();
        data.forEach((n, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const label = i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
            const col = bars.createDiv({ cls: "nlm-forecast-col", attr: { "aria-label": `${label}: ${n} review${n === 1 ? "" : "s"}` } });
            col.createDiv({ cls: "nlm-forecast-value", text: n ? String(n) : "" });
            const bar = col.createDiv({ cls: "nlm-forecast-bar" + (i === 0 ? " is-today" : "") });
            bar.style.height = `${n ? Math.max(4, (n / max) * 100) : 0}%`;
            col.createDiv({ cls: "nlm-forecast-label", text: i === 0 ? "T" : String(d.getDate()) });
        });
        const week = data.slice(0, 7).reduce((a, b) => a + b, 0);
        panel.createDiv({ cls: "nlm-muted nlm-small", text: `${week} reviews over the next 7 days` });
    }

    private renderHeatmap(panel: HTMLElement) {
        const weeks = 20;
        const activity = this.plugin.scheduler.activity(weeks * 7);
        const total = activity.reduce((a, b) => a + b.count, 0);
        const head = panel.createDiv({ cls: "nlm-panel-head" });
        head.createDiv({ cls: "nlm-panel-title", text: "Activity" });
        head.createDiv({ cls: "nlm-muted nlm-small", text: `${total} reviews in the last ${weeks} weeks` });

        // Align columns to weeks: pad the start so the first column begins on the same weekday.
        const firstDow = new Date(activity[0].day).getDay();
        const cells: ({ day: number; count: number } | null)[] = [...Array(firstDow).fill(null), ...activity];
        const max = Math.max(1, ...activity.map(a => a.count));
        const grid = panel.createDiv({ cls: "nlm-heatmap" });
        for (const cell of cells) {
            const c = grid.createDiv({ cls: "nlm-heat-cell" });
            if (!cell) { c.addClass("is-pad"); continue; }
            const level = cell.count === 0 ? 0 : Math.min(4, Math.ceil((cell.count / max) * 4));
            c.addClass(`lvl-${level}`);
            c.setAttr("aria-label", `${new Date(cell.day).toLocaleDateString()}: ${cell.count} review${cell.count === 1 ? "" : "s"}`);
        }
    }

    private renderDeckTable(panel: HTMLElement) {
        const p = this.plugin;
        panel.createDiv({ cls: "nlm-panel-title", text: "Decks" });
        const table = panel.createEl("table", { cls: "nlm-deck-table" });
        const head = table.createEl("thead").createEl("tr");
        for (const h of ["", "New", "Learning", "Due", "Total", "Learned", ""]) head.createEl("th", { text: h });
        const tbody = table.createEl("tbody");

        const groups = new Map<string, DeckInfo[]>();
        for (const d of p.index.list()) {
            if (d.type === "mindmap") continue;
            if (!groups.has(d.deck)) groups.set(d.deck, []);
            groups.get(d.deck)!.push(d);
        }

        const row = (name: string, items: StudyItem[], cls: string, onStudy: () => void, onOpen?: () => void) => {
            const c = p.stateCounts(items.map(i => i.id));
            const tr = tbody.createEl("tr", { cls });
            const nameCell = tr.createEl("td", { cls: "nlm-td-name" });
            if (onOpen) {
                const a = nameCell.createEl("a", { text: name });
                a.onclick = onOpen;
            } else nameCell.setText(name);
            tr.createEl("td", { cls: "nlm-td-new", text: String(c.fresh) });
            tr.createEl("td", { cls: "nlm-td-learning", text: String(c.learning) });
            tr.createEl("td", { cls: "nlm-td-due", text: String(c.due) });
            tr.createEl("td", { text: String(items.length) });
            const pct = items.length ? Math.round((c.review / items.length) * 100) : 0;
            const learned = tr.createEl("td", { cls: "nlm-td-progress" });
            const bar = learned.createDiv({ cls: "nlm-mini-progress" });
            bar.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
            learned.createSpan({ cls: "nlm-small", text: `${pct}%` });
            const act = tr.createEl("td");
            if (items.length) {
                const b = act.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Study ${name}` } });
                setIcon(b, "play");
                b.onclick = onStudy;
            }
        };

        for (const [name, notes] of groups) {
            const items = notes.flatMap(n => p.filterStudyable(n.items));
            row(name, items, "nlm-tr-deck", () => this.startSession({ deck: name }));
            if (notes.length > 1 || notes[0].title !== name) {
                for (const n of notes) {
                    row(n.title, p.filterStudyable(n.items), "nlm-tr-note", () => this.startSession({ path: n.path }),
                        () => void this.app.workspace.openLinkText(n.path, "", false));
                }
            }
        }
    }

    // --- Review session -------------------------------------------------------

    startSession(filter: StudyFilter) {
        this.quiz = null;
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

        // Nothing scheduled: study ahead with the earliest upcoming cards.
        if (!queue.length && !learning.length) {
            queue = items
                .filter(i => sched.has(i.id))
                .sort((a, b) => sched.stored(a.id)!.due - sched.stored(b.id)!.due)
                .slice(0, 20);
            if (!queue.length) queue = fresh.slice(0, 20);
        }

        const title = filter.path
            ? this.plugin.index.decks.get(filter.path)?.title ?? "Note"
            : filter.deck ?? "All decks";
        this.session = {
            filter, title, total: queue.length + learning.length,
            queue, learning, current: null, revealed: false, quizCorrect: null, history: [], done: 0, again: 0,
        };
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

    private sessionTop(page: HTMLElement, title: string, done: number, total: number, onBack: () => void): HTMLElement {
        const top = page.createDiv({ cls: "nlm-session-top" });
        const back = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Back to dashboard" } });
        setIcon(back, "arrow-left");
        back.onclick = onBack;
        const mid = top.createDiv({ cls: "nlm-session-mid" });
        mid.createDiv({ cls: "nlm-session-title", text: title });
        const progress = mid.createDiv({ cls: "nlm-progress" });
        progress.createDiv({ cls: "nlm-progress-bar" }).style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
        return top;
    }

    private async renderSession() {
        const s = this.session!;
        const comp = this.freshComponent();
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page nlm-session" });

        const remaining = s.queue.length + s.learning.length + (s.current ? 1 : 0);
        const total = Math.max(s.total, s.done + remaining);
        const top = this.sessionTop(page, s.title, s.done, total, () => this.renderDashboard());
        const counts = top.createDiv({ cls: "nlm-session-counts" });
        const left = this.remainingByState();
        counts.createSpan({ cls: "nlm-count-new", text: String(left.fresh), attr: { "aria-label": "New" } });
        counts.createSpan({ cls: "nlm-count-learning", text: String(left.learning), attr: { "aria-label": "Learning" } });
        counts.createSpan({ cls: "nlm-count-due", text: String(left.review), attr: { "aria-label": "Review" } });
        if (s.history.length) {
            const undo = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Undo (U)" } });
            setIcon(undo, "undo-2");
            undo.onclick = () => this.undo();
        }

        if (!s.current) {
            await this.plugin.saveSettings();
            const done = page.createDiv({ cls: "nlm-session-done" });
            setIcon(done.createDiv({ cls: "nlm-done-icon" }), "party-popper");
            done.createEl("h2", { text: "Session complete" });
            const acc = s.done ? Math.round(((s.done - s.again) / s.done) * 100) : 0;
            const summary = done.createDiv({ cls: "nlm-done-stats" });
            doneStat(summary, String(s.done), "reviewed");
            doneStat(summary, `${acc}%`, "remembered");
            doneStat(summary, String(s.learning.length), "due again later");
            const row = done.createDiv({ cls: "nlm-actions" });
            row.createEl("button", { cls: "mod-cta", text: "Back to dashboard" }).onclick = () => this.renderDashboard();
            if (s.filter.path) {
                const path = s.filter.path;
                row.createEl("button", { text: "Open note" }).onclick = () => void this.app.workspace.openLinkText(path, "", false);
            }
            return;
        }

        const item = s.current;
        const card = page.createDiv({ cls: "nlm-review-card" + (s.revealed ? " is-revealed" : "") });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        const stateLabel = stateName(this.plugin.scheduler.stored(item.id)?.state);
        meta.createSpan({ cls: `nlm-state nlm-state-${stateLabel.toLowerCase()}`, text: stateLabel });
        meta.createSpan({ cls: "nlm-review-deck", text: item.deck });
        const open = meta.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open in note" } });
        setIcon(open, "file-symlink");
        open.onclick = () => void this.openAt(item);

        const body = card.createDiv({ cls: "nlm-review-body" });

        if (item.kind === "flashcard") {
            card.addClass("is-flashcard");
            const front = body.createDiv({ cls: "nlm-review-front" });
            await MarkdownRenderer.render(this.app, item.card.front, front, item.path, comp);
            if (s.revealed) {
                body.createDiv({ cls: "nlm-divider" });
                const backEl = body.createDiv({ cls: "nlm-review-back" });
                await MarkdownRenderer.render(this.app, item.card.back, backEl, item.path, comp);
                this.renderGrades(page, null);
            } else {
                const btn = page.createEl("button", { cls: "mod-cta nlm-reveal" });
                btn.createSpan({ text: "Show answer" });
                btn.createSpan({ cls: "nlm-kbd", text: "Space" });
                btn.onclick = () => { s.revealed = true; void this.renderSession(); };
            }
        } else {
            card.addClass("is-quiz");
            const { answerWith } = await renderQuizQuestion(this.plugin, body, item.question, item.path, comp, correct => {
                s.revealed = true;
                s.quizCorrect = correct;
                card.addClass("is-revealed");
                this.renderGrades(page, correct ? Rating.Good : Rating.Again);
            });
            s.answerWith = answerWith;
            if (!s.revealed) {
                page.createDiv({ cls: "nlm-hint-keys", text: `Click an answer or press A–${String.fromCharCode(64 + item.question.options.length)}` });
            }
        }
        this.contentEl.focus({ preventScroll: true });
    }

    private remainingByState() {
        const s = this.session!;
        const out = { fresh: 0, learning: 0, review: 0 };
        const all = [...s.queue, ...s.learning.map(l => l.item), ...(s.current ? [s.current] : [])];
        for (const i of all) {
            const st = this.plugin.scheduler.stored(i.id)?.state;
            if (st === undefined || st === State.New) out.fresh++;
            else if (st === State.Review) out.review++;
            else out.learning++;
        }
        return out;
    }

    private renderGrades(page: HTMLElement, suggested: Grade | null) {
        const s = this.session!;
        page.querySelector(".nlm-grades")?.remove();
        page.querySelector(".nlm-hint-keys")?.remove();
        const now = Date.now();
        const preview = this.plugin.scheduler.preview(s.current!.id, now);
        const row = page.createDiv({ cls: "nlm-grades" });
        GRADES.forEach((g, i) => {
            const b = row.createEl("button", { cls: `nlm-grade nlm-grade-${GRADE_LABEL[g].toLowerCase()}` });
            if (g === suggested) b.addClass("is-suggested");
            b.createDiv({ cls: "nlm-grade-ivl", text: formatInterval(now, preview[g].getTime()) });
            b.createDiv({ cls: "nlm-grade-label", text: GRADE_LABEL[g] });
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
        if (g === Rating.Again) s.again++;

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
        const lastRating = this.plugin.scheduler.data.log[last.token.logLength]?.rating;
        this.plugin.scheduler.undo(last.token);
        s.learning = s.learning.filter(l => l.item.id !== last.item.id);
        if (s.current) s.queue.unshift(s.current);
        s.done = Math.max(0, s.done - 1);
        if (lastRating === Rating.Again) s.again = Math.max(0, s.again - 1);
        s.current = last.item;
        s.revealed = false;
        s.quizCorrect = null;
        this.plugin.requestSave();
        this.plugin.index.trigger("reviewed");
        void this.renderSession();
    }

    /** Open the note in a split, scrolled to the card. */
    private async openAt(item: StudyItem) {
        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (!(file instanceof TFile)) return;
        const leaf = this.app.workspace.getLeaf("split");
        await leaf.openFile(file, item.line !== undefined ? { eState: { line: item.line } } : undefined);
    }

    // --- Quiz practice ----------------------------------------------------------

    startQuiz(path: string, order?: number[]) {
        this.session = null;
        const deck = this.plugin.index.decks.get(path);
        const questions = (deck?.items ?? []).flatMap(i => (i.kind === "quiz" ? [i.question] : []));
        this.quiz = {
            path,
            title: deck?.title ?? "Quiz",
            questions,
            order: order ?? questions.map((_, i) => i),
            pos: 0,
            correct: 0,
            missed: [],
            answered: false,
        };
        void this.renderQuiz();
    }

    private async renderQuiz() {
        const q = this.quiz!;
        const comp = this.freshComponent();
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page nlm-session" });
        const top = this.sessionTop(page, `Quiz · ${q.title}`, q.pos, q.order.length, () => this.renderDashboard());
        top.createDiv({ cls: "nlm-session-score", text: `${q.correct} / ${q.pos}` });

        if (!q.questions.length) {
            page.createDiv({ cls: "nlm-empty", text: "This note has no quiz questions." });
            return;
        }

        if (q.pos >= q.order.length) {
            const total = q.order.length;
            const pct = Math.round((q.correct / total) * 100);
            const done = page.createDiv({ cls: "nlm-session-done" });
            const ring = done.createDiv({ cls: "nlm-score-ring" });
            ring.style.setProperty("--pct", String(pct));
            ring.createSpan({ text: `${pct}%` });
            done.createEl("h2", { text: pct >= 90 ? "Excellent!" : pct >= 70 ? "Well done" : pct >= 50 ? "Getting there" : "Keep practicing" });
            done.createDiv({ cls: "nlm-muted", text: `${q.correct} of ${total} correct` });
            const row = done.createDiv({ cls: "nlm-actions" });
            if (q.missed.length) {
                const missed = [...q.missed];
                row.createEl("button", { cls: "mod-cta", text: `Retry ${missed.length} missed` }).onclick = () => this.startQuiz(q.path, missed);
            }
            row.createEl("button", { text: "Restart" }).onclick = () => this.startQuiz(q.path);
            row.createEl("button", { text: "Shuffle" }).onclick = () => this.startQuiz(q.path, shuffle(q.questions.map((_, i) => i)));
            row.createEl("button", { text: "Back to note" }).onclick = () => void this.app.workspace.openLinkText(q.path, "", false);
            return;
        }

        const index = q.order[q.pos];
        const card = page.createDiv({ cls: "nlm-review-card is-quiz" });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        meta.createSpan({ cls: "nlm-state", text: `Question ${q.pos + 1} of ${q.order.length}` });
        const body = card.createDiv({ cls: "nlm-review-body" });
        q.answered = false;
        const { answerWith } = await renderQuizQuestion(this.plugin, body, q.questions[index], q.path, comp, correct => {
            q.answered = true;
            if (correct) q.correct++;
            else q.missed.push(index);
            card.addClass(correct ? "is-correct" : "is-wrong");
            const next = page.createEl("button", { cls: "mod-cta nlm-reveal" });
            next.createSpan({ text: q.pos + 1 < q.order.length ? "Next question" : "See results" });
            next.createSpan({ cls: "nlm-kbd", text: "Enter" });
            next.onclick = () => this.nextQuestion();
            top.querySelector(".nlm-session-score")?.setText(`${q.correct} / ${q.pos + 1}`);
        });
        q.answerWith = answerWith;
        this.contentEl.focus({ preventScroll: true });
    }

    private nextQuestion() {
        const q = this.quiz;
        if (!q?.answered) return;
        q.pos++;
        void this.renderQuiz();
    }

    // --- Keyboard -------------------------------------------------------------

    private onKey(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        const key = e.key.toLowerCase();

        if (this.quiz) {
            const q = this.quiz;
            if (!q.answered && /^[a-h]$/.test(key)) { e.preventDefault(); q.answerWith?.(key.charCodeAt(0) - 97); }
            else if (q.answered && (key === "enter" || key === " ")) { e.preventDefault(); this.nextQuestion(); }
            return;
        }

        const s = this.session;
        if (!s?.current) return;
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

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const b = parent.createEl("button");
    setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
    b.createSpan({ text: label });
    b.onclick = onClick;
}

function tile(parent: HTMLElement, icon: string, value: string, label: string, sub: string) {
    const t = parent.createDiv({ cls: "nlm-tile" });
    setIcon(t.createDiv({ cls: "nlm-tile-icon" }), icon);
    const text = t.createDiv();
    text.createDiv({ cls: "nlm-tile-value", text: value });
    text.createDiv({ cls: "nlm-tile-label", text: label });
    if (sub) text.createDiv({ cls: "nlm-tile-sub", text: sub });
}

function doneStat(parent: HTMLElement, value: string, label: string) {
    const d = parent.createDiv({ cls: "nlm-done-stat" });
    d.createDiv({ cls: "nlm-done-value", text: value });
    d.createDiv({ cls: "nlm-muted", text: label });
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

function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
