import { Component, ItemView, MarkdownRenderer, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Grade, Rating, State } from "ts-fsrs";
import { renderQuizQuestion } from "../blocks";
import { renderCloze } from "../cloze";
import { locale, t, tn } from "../i18n";
import type NotebookLMStudy from "../main";
import { DeckInfo } from "../srs/deck-index";
import { ExamResult, GRADES, UndoToken, formatInterval } from "../srs/scheduler";
import { QuizQuestion, StudyItem } from "../types";

export const STUDY_VIEW = "nlm-study-view";

export interface StudyFilter {
    /** Limit to one note. */
    path?: string;
    /** Limit to one deck name. */
    deck?: string;
    /** Limit to these item ids. */
    ids?: string[];
    /** Session title override. */
    title?: string;
}

const LEARN_AHEAD_MS = 20 * 60 * 1000;
const MATURE_DAYS = 21;
const DAY = 24 * 60 * 60 * 1000;

function gradeLabel(g: Grade): string {
    return { [Rating.Again]: t("Again"), [Rating.Hard]: t("Hard"), [Rating.Good]: t("Good"), [Rating.Easy]: t("Easy") }[g];
}
const GRADE_CLS: Record<Grade, string> = { [Rating.Again]: "again", [Rating.Hard]: "hard", [Rating.Good]: "good", [Rating.Easy]: "easy" };

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

interface ExamQuestion {
    path: string;
    question: QuizQuestion;
    /** Option order as shown (indices into question.options). */
    order: number[];
    chosen: number | null;
}

interface ExamRun {
    questions: ExamQuestion[];
    pos: number;
    startedAt: number;
    deadline: number | null;
    finished: ExamResult | null;
}

export class StudyView extends ItemView {
    private session: Session | null = null;
    private quiz: QuizRun | null = null;
    private exam: ExamRun | null = null;
    private examSetupPaths: Set<string> | null = null;
    private examCount = 20;
    private examMinutes = 20;
    private cardComponent: Component | null = null;
    private timer: number | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: NotebookLMStudy) {
        super(leaf);
    }

    getViewType() { return STUDY_VIEW; }
    getDisplayText() { return this.session ? t("Review") : this.quiz ? t("Quiz") : this.exam ? t("Exam") : t("Study dashboard"); }
    getIcon() { return "graduation-cap"; }

    async onOpen() {
        this.contentEl.addClass("nlm-study");
        this.registerEvent(this.plugin.index.on("changed", () => {
            if (!this.session && !this.quiz && !this.exam) this.renderDashboard();
        }));
        this.registerDomEvent(this.contentEl, "keydown", e => this.onKey(e));
        this.contentEl.tabIndex = 0;
        this.renderDashboard();
    }

    async onClose() {
        this.cardComponent?.unload();
        this.stopTimer();
    }

    refresh() {
        if (this.session) void this.renderSession();
        else if (this.quiz) void this.renderQuiz();
        else if (this.exam) void this.renderExam();
        else this.renderDashboard();
    }

    private freshComponent(): Component {
        this.cardComponent?.unload();
        this.cardComponent = new Component();
        this.cardComponent.load();
        return this.cardComponent;
    }

    private reset() {
        this.session = null;
        this.quiz = null;
        this.exam = null;
        this.stopTimer();
        this.cardComponent?.unload();
        this.cardComponent = null;
    }

    // --- Dashboard ----------------------------------------------------------

    renderDashboard() {
        this.reset();
        const p = this.plugin;
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page" });

        const header = page.createDiv({ cls: "nlm-dash-header" });
        const titleWrap = header.createDiv();
        titleWrap.createEl("h2", { text: t("Study dashboard") });
        titleWrap.createDiv({ cls: "nlm-muted", text: new Date().toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" }) });
        const actions = header.createDiv({ cls: "nlm-actions" });
        iconButton(actions, "table", t("Card browser"), () => void p.openBrowser());
        iconButton(actions, "timer", t("Exam"), () => this.renderExamSetup());
        iconButton(actions, "panel-right", t("Panel"), () => void p.openSidebar());

        if (!p.index.ready) {
            page.createDiv({ cls: "nlm-empty", text: t("Indexing vault…") });
            return;
        }

        const items = p.studyableItems();
        const ids = items.map(i => i.id);
        const c = p.stateCounts(ids);
        const stats = p.scheduler.stats();
        const newToday = Math.min(c.fresh, p.newLeftToday());
        const todo = c.due + c.learning + newToday;

        const hero = page.createDiv({ cls: "nlm-hero" });
        const heroText = hero.createDiv({ cls: "nlm-hero-text" });
        heroText.createDiv({ cls: "nlm-hero-number", text: String(todo) });
        heroText.createDiv({
            cls: "nlm-hero-label",
            text: todo
                ? t("cards to study today · {r} review · {l} learning · {n} new", { r: c.due, l: c.learning, n: newToday })
                : items.length ? t("You're all caught up for today") : t("No cards yet"),
        });
        const start = hero.createEl("button", { cls: "mod-cta nlm-hero-btn" });
        setIcon(start.createSpan({ cls: "nlm-btn-icon" }), "play");
        start.createSpan({ text: todo ? t("Start review") : t("Study ahead") });
        start.disabled = !items.length;
        start.onclick = () => this.startSession({});

        const tiles = page.createDiv({ cls: "nlm-tiles" });
        tile(tiles, "check-circle", String(stats.reviewedToday), t("reviewed today"),
            stats.accuracyToday === null ? "" : t("{pct}% correct", { pct: Math.round(stats.accuracyToday * 100) }));
        tile(tiles, "target", stats.retention30d === null ? "—" : `${Math.round(stats.retention30d * 100)}%`, t("retention (30 days)"),
            t("goal {pct}%", { pct: Math.round(p.settings.desiredRetention * 100) }));
        tile(tiles, "flame", String(stats.streak), tn(stats.streak, "day streak", "days streak"), "");
        tile(tiles, "layers", String(items.length), t("cards in total"),
            tn(p.index.list().filter(d => d.items.length).length, "{n} note", "{n} notes"));

        if (!items.length) {
            this.renderEmpty(page);
            return;
        }

        const grid = page.createDiv({ cls: "nlm-dash-grid" });
        this.renderStates(grid.createDiv({ cls: "nlm-panel" }), ids);
        this.renderForecast(grid.createDiv({ cls: "nlm-panel" }), ids);
        this.renderHeatmap(page.createDiv({ cls: "nlm-panel" }));
        this.renderExamsPanel(page);
        this.renderDeckTable(page.createDiv({ cls: "nlm-panel" }));
    }

    private renderEmpty(page: HTMLElement) {
        const empty = page.createDiv({ cls: "nlm-panel nlm-empty-state" });
        setIcon(empty.createDiv({ cls: "nlm-empty-icon" }), "sparkles");
        empty.createEl("h3", { text: t("Bring in your first deck") });
        empty.createEl("p", { text: t("Import flashcards, quizzes or mind maps from NotebookLM, or write cards yourself in any note:") });
        empty.createEl("pre", { text: "> [!flashcard]- What is a perceptron?\n> A single artificial neuron.\n\n> [!cloze]\n> The {{mitochondrion}} makes {{ATP}}." });
        const row = empty.createDiv({ cls: "nlm-actions" });
        if (Platform.isDesktopApp) row.createEl("button", { cls: "mod-cta", text: t("Add from NotebookLM") }).onclick = () => void this.plugin.openSidebar("sync");
        row.createEl("button", { text: t("Import a file") }).onclick = () => void this.plugin.openSidebar("import");
    }

    private renderStates(panel: HTMLElement, ids: string[]) {
        panel.createDiv({ cls: "nlm-panel-title", text: t("Card states") });
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
            ["new", t("New"), fresh], ["learning", t("Learning"), learning], ["young", t("Young"), young], ["mature", t("Mature"), mature],
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
        panel.createDiv({ cls: "nlm-muted nlm-small", text: t("Mature cards have an interval of {n} days or more.", { n: MATURE_DAYS }) });
    }

    private renderForecast(panel: HTMLElement, ids: string[]) {
        const days = 14;
        const data = this.plugin.scheduler.forecast(ids, days);
        panel.createDiv({ cls: "nlm-panel-title", text: t("Upcoming reviews") });
        const max = Math.max(1, ...data);
        const bars = panel.createDiv({ cls: "nlm-forecast-bars" });
        const today = new Date();
        data.forEach((n, i) => {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const label = i === 0 ? t("Today") : d.toLocaleDateString(locale(), { weekday: "short", day: "numeric" });
            const col = bars.createDiv({ cls: "nlm-forecast-col", attr: { "aria-label": `${label}: ${n}` } });
            col.createDiv({ cls: "nlm-forecast-value", text: n ? String(n) : "" });
            const bar = col.createDiv({ cls: "nlm-forecast-bar" + (i === 0 ? " is-today" : "") });
            bar.style.height = `${n ? Math.max(4, (n / max) * 100) : 0}%`;
            col.createDiv({ cls: "nlm-forecast-label", text: i === 0 ? t("T") : String(d.getDate()) });
        });
        const week = data.slice(0, 7).reduce((a, b) => a + b, 0);
        panel.createDiv({ cls: "nlm-muted nlm-small", text: t("{n} reviews over the next 7 days", { n: week }) });
    }

    private renderHeatmap(panel: HTMLElement) {
        const weeks = 20;
        const activity = this.plugin.scheduler.activity(weeks * 7);
        const total = activity.reduce((a, b) => a + b.count, 0);
        const head = panel.createDiv({ cls: "nlm-panel-head" });
        head.createDiv({ cls: "nlm-panel-title", text: t("Activity") });
        head.createDiv({ cls: "nlm-muted nlm-small", text: t("{n} reviews in the last {w} weeks", { n: total, w: weeks }) });

        const firstDow = new Date(activity[0].day).getDay();
        const cells: ({ day: number; count: number } | null)[] = [...Array(firstDow).fill(null), ...activity];
        const max = Math.max(1, ...activity.map(a => a.count));
        const grid = panel.createDiv({ cls: "nlm-heatmap" });
        for (const cell of cells) {
            const c = grid.createDiv({ cls: "nlm-heat-cell" });
            if (!cell) { c.addClass("is-pad"); continue; }
            const level = cell.count === 0 ? 0 : Math.min(4, Math.ceil((cell.count / max) * 4));
            c.addClass(`lvl-${level}`);
            c.setAttr("aria-label", `${new Date(cell.day).toLocaleDateString(locale())}: ${cell.count}`);
        }
    }

    private renderExamsPanel(page: HTMLElement) {
        const exams = this.plugin.srs.exams;
        const weak = this.weakTopics();
        if (!exams.length && !weak.length) return;
        const grid = page.createDiv({ cls: "nlm-dash-grid" });

        if (exams.length) {
            const panel = grid.createDiv({ cls: "nlm-panel" });
            panel.createDiv({ cls: "nlm-panel-title", text: t("Recent exams") });
            const list = panel.createDiv({ cls: "nlm-exam-list" });
            for (const e of exams.slice(-6).reverse()) {
                const pct = Math.round((e.correct / e.total) * 100);
                const row = list.createDiv({ cls: "nlm-exam-row" });
                row.createSpan({ cls: "nlm-muted", text: new Date(e.t).toLocaleDateString(locale(), { day: "numeric", month: "short" }) });
                const bar = row.createDiv({ cls: "nlm-mini-progress" });
                const fill = bar.createDiv({ cls: "nlm-mini-progress-bar" });
                fill.style.width = `${pct}%`;
                fill.toggleClass("is-low", pct < 60);
                row.createSpan({ cls: "nlm-exam-score", text: `${pct}%` });
                row.createSpan({ cls: "nlm-muted nlm-small", text: `${e.correct}/${e.total} · ${formatDuration(e.durationMs)}` });
            }
        }

        if (weak.length) {
            const panel = grid.createDiv({ cls: "nlm-panel" });
            panel.createDiv({ cls: "nlm-panel-title", text: t("Topics to reinforce") });
            for (const w of weak.slice(0, 5)) {
                const row = panel.createDiv({ cls: "nlm-exam-row" });
                const a = row.createEl("a", { cls: "nlm-exam-topic", text: w.title });
                a.onclick = () => void this.app.workspace.openLinkText(w.path, "", false);
                const bar = row.createDiv({ cls: "nlm-mini-progress" });
                const fill = bar.createDiv({ cls: "nlm-mini-progress-bar" });
                fill.style.width = `${Math.round(w.accuracy * 100)}%`;
                fill.toggleClass("is-low", w.accuracy < 0.6);
                row.createSpan({ cls: "nlm-exam-score", text: `${Math.round(w.accuracy * 100)}%` });
            }
            const paths = weak.slice(0, 5).map(w => w.path);
            panel.createEl("button", { text: t("Exam on these topics") }).onclick = () => this.renderExamSetup(paths);
        }
    }

    /** Notes with the lowest accuracy, from exams and quiz reviews. */
    private weakTopics(): { path: string; title: string; accuracy: number }[] {
        const acc = new Map<string, { c: number; n: number }>();
        const add = (path: string, c: number, n: number) => {
            const cur = acc.get(path) ?? { c: 0, n: 0 };
            cur.c += c;
            cur.n += n;
            acc.set(path, cur);
        };
        for (const e of this.plugin.srs.exams.slice(-20)) {
            for (const [path, r] of Object.entries(e.byNote)) add(path, r.correct, r.total);
        }
        const pathOf = new Map(this.plugin.index.items().map(i => [i.id, i.path]));
        const since = Date.now() - 60 * DAY;
        for (const e of this.plugin.srs.log) {
            if (e.t < since) continue;
            const path = pathOf.get(e.id);
            if (path) add(path, e.rating === Rating.Again ? 0 : 1, 1);
        }
        return [...acc.entries()]
            .filter(([path, v]) => v.n >= 3 && this.plugin.index.decks.has(path))
            .map(([path, v]) => ({ path, title: this.plugin.index.decks.get(path)!.title, accuracy: v.c / v.n }))
            .filter(w => w.accuracy < 0.85)
            .sort((a, b) => a.accuracy - b.accuracy);
    }

    private deckRetention(ids: Set<string>): number | null {
        const since = Date.now() - 90 * DAY;
        let n = 0, ok = 0;
        for (const e of this.plugin.srs.log) {
            if (e.t < since || e.state !== State.Review || !ids.has(e.id)) continue;
            n++;
            if (e.rating !== Rating.Again) ok++;
        }
        return n ? ok / n : null;
    }

    private renderDeckTable(panel: HTMLElement) {
        const p = this.plugin;
        panel.createDiv({ cls: "nlm-panel-title", text: t("Decks") });
        const table = panel.createEl("table", { cls: "nlm-deck-table" });
        const head = table.createEl("thead").createEl("tr");
        for (const h of ["", t("New"), t("Learning"), t("Due"), t("Total"), t("Retention"), t("Learned"), ""]) head.createEl("th", { text: h });
        const tbody = table.createEl("tbody");

        const groups = new Map<string, DeckInfo[]>();
        for (const d of p.index.list()) {
            if (!d.items.length) continue;
            if (!groups.has(d.deck)) groups.set(d.deck, []);
            groups.get(d.deck)!.push(d);
        }

        const row = (name: string, items: StudyItem[], cls: string, onStudy: () => void, onOpen?: () => void) => {
            const c = p.stateCounts(items.map(i => i.id));
            const tr = tbody.createEl("tr", { cls });
            const nameCell = tr.createEl("td", { cls: "nlm-td-name" });
            if (onOpen) nameCell.createEl("a", { text: name }).onclick = onOpen;
            else nameCell.setText(name);
            tr.createEl("td", { cls: "nlm-td-new", text: String(c.fresh) });
            tr.createEl("td", { cls: "nlm-td-learning", text: String(c.learning) });
            tr.createEl("td", { cls: "nlm-td-due", text: String(c.due) });
            tr.createEl("td", { text: String(items.length) });
            const ret = this.deckRetention(new Set(items.map(i => i.id)));
            tr.createEl("td", { cls: "nlm-td-ret", text: ret === null ? "—" : `${Math.round(ret * 100)}%` });
            const pct = items.length ? Math.round((c.review / items.length) * 100) : 0;
            const learned = tr.createEl("td", { cls: "nlm-td-progress" });
            const bar = learned.createDiv({ cls: "nlm-mini-progress" });
            bar.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
            learned.createSpan({ cls: "nlm-small", text: `${pct}%` });
            const act = tr.createEl("td");
            if (items.length) {
                const b = act.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Study {name}", { name }) } });
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
        this.reset();
        const items = this.plugin.studyableItems(filter);
        const sched = this.plugin.scheduler;
        const now = Date.now();
        const dayEnd = sched.dayEnd(now);
        const stats = sched.stats(now);
        const s = this.plugin.settings;
        // An explicit selection (e.g. "study these" from a mind map) ignores daily limits.
        const explicit = !!filter.ids;

        const learning: Session["learning"] = [];
        const reviews: StudyItem[] = [];
        const fresh: StudyItem[] = [];
        for (const item of items) {
            const st = sched.stored(item.id);
            if (!st || st.state === State.New) fresh.push(item);
            else if (st.state === State.Review) { if (explicit || st.due < dayEnd) reviews.push(item); }
            else if (explicit || st.due < dayEnd) learning.push({ item, due: st.due });
        }

        reviews.sort((a, b) => sched.stored(a.id)!.due - sched.stored(b.id)!.due);
        const reviewCap = explicit ? Infinity : Math.max(0, s.maxReviewsPerDay - (stats.reviewedToday - stats.newToday));
        const newCap = explicit ? Infinity : Math.max(0, s.newPerDay - stats.newToday);
        let queue = interleave(reviews.slice(0, reviewCap), fresh.slice(0, newCap));

        if (!queue.length && !learning.length) {
            queue = items
                .filter(i => sched.has(i.id))
                .sort((a, b) => sched.stored(a.id)!.due - sched.stored(b.id)!.due)
                .slice(0, 20);
            if (!queue.length) queue = fresh.slice(0, 20);
        }

        const title = filter.title ?? (filter.path
            ? this.plugin.index.decks.get(filter.path)?.title ?? t("Note")
            : filter.deck ?? t("All decks"));
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
        const back = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Back to dashboard") } });
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
        counts.createSpan({ cls: "nlm-count-new", text: String(left.fresh), attr: { "aria-label": t("New") } });
        counts.createSpan({ cls: "nlm-count-learning", text: String(left.learning), attr: { "aria-label": t("Learning") } });
        counts.createSpan({ cls: "nlm-count-due", text: String(left.review), attr: { "aria-label": t("Review") } });
        if (s.history.length) {
            const undo = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Undo (U)") } });
            setIcon(undo, "undo-2");
            undo.onclick = () => this.undo();
        }

        if (!s.current) {
            await this.plugin.saveSettings();
            const done = page.createDiv({ cls: "nlm-session-done" });
            setIcon(done.createDiv({ cls: "nlm-done-icon" }), "party-popper");
            done.createEl("h2", { text: t("Session complete") });
            const acc = s.done ? Math.round(((s.done - s.again) / s.done) * 100) : 0;
            const summary = done.createDiv({ cls: "nlm-done-stats" });
            doneStat(summary, String(s.done), t("reviewed"));
            doneStat(summary, `${acc}%`, t("remembered"));
            doneStat(summary, String(s.learning.length), t("due again later"));
            const row = done.createDiv({ cls: "nlm-actions" });
            row.createEl("button", { cls: "mod-cta", text: t("Back to dashboard") }).onclick = () => this.renderDashboard();
            if (s.filter.path) {
                const path = s.filter.path;
                row.createEl("button", { text: t("Open note") }).onclick = () => void this.app.workspace.openLinkText(path, "", false);
            }
            return;
        }

        const item = s.current;
        const card = page.createDiv({ cls: "nlm-review-card" + (s.revealed ? " is-revealed" : "") });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        const st = this.plugin.scheduler.stored(item.id)?.state;
        meta.createSpan({ cls: `nlm-state nlm-state-${stateKey(st)}`, text: stateName(st) });
        if (item.kind === "cloze") meta.createSpan({ cls: "nlm-state", text: t("Cloze") });
        if (item.kind === "flashcard" && item.reversed) meta.createSpan({ cls: "nlm-state", text: t("Reversed") });
        meta.createSpan({ cls: "nlm-review-deck", text: item.deck });
        const open = meta.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Open in note") } });
        setIcon(open, "file-symlink");
        open.onclick = () => void this.openAt(item);
        const suspend = meta.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Suspend this card") } });
        setIcon(suspend, "pause-circle");
        suspend.onclick = () => this.suspendCurrent();

        const body = card.createDiv({ cls: "nlm-review-body" });

        if (item.kind === "flashcard" || item.kind === "cloze") {
            card.addClass("is-flashcard");
            const front = body.createDiv({ cls: "nlm-review-front" });
            if (item.kind === "cloze" && item.cloze.title) body.prepend(createDiv({ cls: "nlm-cloze-title", text: item.cloze.title }));
            const frontMd = item.kind === "cloze" ? renderCloze(item.cloze.text, item.group, s.revealed ? "back" : "front") : item.card.front;
            await MarkdownRenderer.render(this.app, frontMd, front, item.path, comp);
            if (s.revealed && item.kind === "flashcard") {
                body.createDiv({ cls: "nlm-divider" });
                const backEl = body.createDiv({ cls: "nlm-review-back" });
                await MarkdownRenderer.render(this.app, item.card.back, backEl, item.path, comp);
            }
            if (s.revealed) this.renderGrades(page, null);
            else {
                const btn = page.createEl("button", { cls: "mod-cta nlm-reveal" });
                btn.createSpan({ text: t("Show answer") });
                btn.createSpan({ cls: "nlm-kbd", text: t("Space") });
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
                page.createDiv({ cls: "nlm-hint-keys", text: t("Click an answer or press A–{last}", { last: String.fromCharCode(64 + item.question.options.length) }) });
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
            const b = row.createEl("button", { cls: `nlm-grade nlm-grade-${GRADE_CLS[g]}` });
            if (g === suggested) b.addClass("is-suggested");
            b.createDiv({ cls: "nlm-grade-ivl", text: formatInterval(now, preview[g].getTime()) });
            b.createDiv({ cls: "nlm-grade-label", text: gradeLabel(g) });
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

    private suspendCurrent() {
        const s = this.session;
        if (!s?.current) return;
        this.plugin.scheduler.setSuspended(s.current.id, true);
        this.plugin.requestSave();
        this.plugin.index.trigger("reviewed");
        new Notice(t("Card suspended. Unsuspend it from the card browser."));
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
        this.reset();
        const deck = this.plugin.index.decks.get(path);
        const questions = (deck?.items ?? []).flatMap(i => (i.kind === "quiz" ? [i.question] : []));
        this.quiz = {
            path,
            title: deck?.title ?? t("Quiz"),
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
        const top = this.sessionTop(page, t("Quiz · {name}", { name: q.title }), q.pos, q.order.length, () => this.renderDashboard());
        top.createDiv({ cls: "nlm-session-score", text: `${q.correct} / ${q.pos}` });

        if (!q.questions.length) {
            page.createDiv({ cls: "nlm-empty", text: t("This note has no quiz questions.") });
            return;
        }

        if (q.pos >= q.order.length) {
            const total = q.order.length;
            const pct = Math.round((q.correct / total) * 100);
            const done = page.createDiv({ cls: "nlm-session-done" });
            scoreRing(done, pct);
            done.createEl("h2", { text: verdict(pct) });
            done.createDiv({ cls: "nlm-muted", text: t("{c} of {n} correct", { c: q.correct, n: total }) });
            const row = done.createDiv({ cls: "nlm-actions" });
            if (q.missed.length) {
                const missed = [...q.missed];
                row.createEl("button", { cls: "mod-cta", text: t("Retry {n} missed", { n: missed.length }) }).onclick = () => this.startQuiz(q.path, missed);
            }
            row.createEl("button", { text: t("Restart") }).onclick = () => this.startQuiz(q.path);
            row.createEl("button", { text: t("Shuffle") }).onclick = () => this.startQuiz(q.path, shuffle(q.questions.map((_, i) => i)));
            row.createEl("button", { text: t("Back to note") }).onclick = () => void this.app.workspace.openLinkText(q.path, "", false);
            return;
        }

        const index = q.order[q.pos];
        const card = page.createDiv({ cls: "nlm-review-card is-quiz" });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        meta.createSpan({ cls: "nlm-state", text: t("Question {i} of {n}", { i: q.pos + 1, n: q.order.length }) });
        const body = card.createDiv({ cls: "nlm-review-body" });
        q.answered = false;
        const { answerWith } = await renderQuizQuestion(this.plugin, body, q.questions[index], q.path, comp, correct => {
            q.answered = true;
            if (correct) q.correct++;
            else q.missed.push(index);
            card.addClass(correct ? "is-correct" : "is-wrong");
            const next = page.createEl("button", { cls: "mod-cta nlm-reveal" });
            next.createSpan({ text: q.pos + 1 < q.order.length ? t("Next question") : t("See results") });
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

    // --- Exam -----------------------------------------------------------------

    /** Choose quizzes, number of questions and time limit. */
    renderExamSetup(paths?: string[]) {
        this.reset();
        const notes = this.plugin.index.list().filter(d => d.items.some(i => i.kind === "quiz"));
        if (paths) this.examSetupPaths = new Set(paths);
        if (!this.examSetupPaths) this.examSetupPaths = new Set(notes.map(n => n.path));
        const sel = this.examSetupPaths;

        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page nlm-session" });
        this.sessionTop(page, t("Exam"), 0, 1, () => this.renderDashboard());
        const panel = page.createDiv({ cls: "nlm-panel" });
        panel.createEl("h2", { text: t("Mock exam") });
        panel.createDiv({ cls: "nlm-muted", text: t("Questions from several quizzes, mixed, with a time limit. You see the results at the end.") });

        if (!notes.length) {
            panel.createDiv({ cls: "nlm-empty", text: t("No quiz questions in the vault yet.") });
            return;
        }

        const listHead = panel.createDiv({ cls: "nlm-panel-head" });
        listHead.createDiv({ cls: "nlm-panel-title", text: t("Quizzes") });
        const toggleAll = listHead.createEl("a", { text: sel.size === notes.length ? t("Select none") : t("Select all") });
        toggleAll.onclick = () => {
            if (sel.size === notes.length) sel.clear();
            else notes.forEach(n => sel.add(n.path));
            this.renderExamSetup();
        };
        const list = panel.createDiv({ cls: "nlm-exam-pick" });
        for (const n of notes) {
            const count = n.items.filter(i => i.kind === "quiz").length;
            const row = list.createEl("label", { cls: "nlm-exam-pick-row" });
            const cb = row.createEl("input", { type: "checkbox" });
            cb.checked = sel.has(n.path);
            cb.onchange = () => { cb.checked ? sel.add(n.path) : sel.delete(n.path); this.renderExamSetup(); };
            row.createSpan({ cls: "nlm-exam-pick-title", text: n.title });
            row.createSpan({ cls: "nlm-muted nlm-small", text: tn(count, "{n} question", "{n} questions") });
        }

        const available = notes.filter(n => sel.has(n.path)).reduce((a, n) => a + n.items.filter(i => i.kind === "quiz").length, 0);
        const opts = panel.createDiv({ cls: "nlm-exam-opts" });
        const countLabel = opts.createEl("label");
        countLabel.createSpan({ text: t("Questions") });
        const count = countLabel.createEl("input", { type: "number", attr: { min: "1", max: String(Math.max(1, available)) } });
        count.value = String(Math.min(this.examCount, Math.max(1, available)));
        count.oninput = () => (this.examCount = Math.max(1, Number(count.value) || 1));
        const timeLabel = opts.createEl("label");
        timeLabel.createSpan({ text: t("Time limit (minutes, 0 = none)") });
        const minutes = timeLabel.createEl("input", { type: "number", attr: { min: "0", max: "600" } });
        minutes.value = String(this.examMinutes);
        minutes.oninput = () => (this.examMinutes = Math.max(0, Number(minutes.value) || 0));
        opts.createDiv({ cls: "nlm-muted nlm-small", text: tn(available, "{n} question available", "{n} questions available") });

        const go = panel.createEl("button", { cls: "mod-cta nlm-reveal", text: t("Start exam") });
        go.disabled = !available;
        go.onclick = () => this.startExam([...sel], Math.min(this.examCount, available), this.examMinutes);
    }

    startExam(paths: string[], count: number, minutes: number, only?: { path: string; question: QuizQuestion }[]) {
        this.reset();
        const pool = only ?? paths.flatMap(path =>
            (this.plugin.index.decks.get(path)?.items ?? []).flatMap(i => (i.kind === "quiz" ? [{ path, question: i.question }] : [])));
        const picked = shuffle([...pool]).slice(0, count);
        const now = Date.now();
        this.exam = {
            questions: picked.map(q => ({ ...q, order: shuffle(q.question.options.map((_, i) => i)), chosen: null })),
            pos: 0,
            startedAt: now,
            deadline: minutes > 0 ? now + minutes * 60_000 : null,
            finished: null,
        };
        this.stopTimer();
        this.timer = window.setInterval(() => this.tick(), 1000);
        this.registerInterval(this.timer);
        void this.renderExam();
    }

    private stopTimer() {
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
    }

    private tick() {
        const e = this.exam;
        if (!e || e.finished) { this.stopTimer(); return; }
        const clock = this.contentEl.querySelector(".nlm-exam-clock");
        if (e.deadline) {
            const left = e.deadline - Date.now();
            if (left <= 0) { this.finishExam(); return; }
            clock?.setText(formatClock(left));
            clock?.toggleClass("is-low", left < 60_000);
        } else {
            clock?.setText(formatClock(Date.now() - e.startedAt));
        }
    }

    private async renderExam() {
        const e = this.exam!;
        if (e.finished) { this.renderExamResult(); return; }
        const comp = this.freshComponent();
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page nlm-session" });
        const answered = e.questions.filter(q => q.chosen !== null).length;
        const top = this.sessionTop(page, t("Exam · {a} of {n} answered", { a: answered, n: e.questions.length }), answered, e.questions.length, () => {
            if (confirm(t("Leave the exam? Your answers will be lost."))) this.renderDashboard();
        });
        const clock = top.createDiv({ cls: "nlm-exam-clock" });
        clock.setText(formatClock(e.deadline ? e.deadline - Date.now() : Date.now() - e.startedAt));

        const q = e.questions[e.pos];
        const card = page.createDiv({ cls: "nlm-review-card is-quiz" });
        const meta = card.createDiv({ cls: "nlm-review-meta" });
        meta.createSpan({ cls: "nlm-state", text: t("Question {i} of {n}", { i: e.pos + 1, n: e.questions.length }) });
        meta.createSpan({ cls: "nlm-review-deck", text: this.plugin.index.decks.get(q.path)?.title ?? "" });
        const body = card.createDiv({ cls: "nlm-review-body" });
        const qEl = body.createDiv({ cls: "nlm-quiz-question" });
        await MarkdownRenderer.render(this.app, q.question.question, qEl, q.path, comp);
        const opts = body.createDiv({ cls: "nlm-quiz-options" });
        q.order.forEach((optIndex, shown) => {
            const o = q.question.options[optIndex];
            const b = opts.createEl("button", { cls: "nlm-quiz-option" + (q.chosen === optIndex ? " is-chosen" : "") });
            b.createSpan({ cls: "nlm-option-key", text: String.fromCharCode(65 + shown) });
            const label = b.createSpan({ cls: "nlm-option-text" });
            void MarkdownRenderer.render(this.app, o.text, label, q.path, comp);
            b.onclick = () => this.chooseExam(optIndex);
        });

        const nav = page.createDiv({ cls: "nlm-exam-nav" });
        const prev = nav.createEl("button", { text: t("Previous") });
        prev.disabled = e.pos === 0;
        prev.onclick = () => { e.pos--; void this.renderExam(); };
        const palette = nav.createDiv({ cls: "nlm-exam-palette" });
        e.questions.forEach((qq, i) => {
            const dot = palette.createEl("button", { cls: "nlm-exam-dot", text: String(i + 1) });
            if (qq.chosen !== null) dot.addClass("is-answered");
            if (i === e.pos) dot.addClass("is-current");
            dot.onclick = () => { e.pos = i; void this.renderExam(); };
        });
        if (e.pos < e.questions.length - 1) {
            const next = nav.createEl("button", { cls: "mod-cta", text: t("Next") });
            next.onclick = () => { e.pos++; void this.renderExam(); };
        } else {
            const finish = nav.createEl("button", { cls: "mod-cta", text: t("Finish exam") });
            finish.onclick = () => {
                const missing = e.questions.filter(x => x.chosen === null).length;
                if (missing && !confirm(tn(missing, "{n} question is unanswered. Finish anyway?", "{n} questions are unanswered. Finish anyway?"))) return;
                this.finishExam();
            };
        }
        page.createDiv({ cls: "nlm-hint-keys", text: t("A–H choose · ← → move between questions") });
        this.contentEl.focus({ preventScroll: true });
    }

    private chooseExam(optIndex: number) {
        const e = this.exam;
        if (!e || e.finished) return;
        e.questions[e.pos].chosen = optIndex;
        // Move on automatically, except on the last question.
        if (e.pos < e.questions.length - 1) e.pos++;
        void this.renderExam();
    }

    private finishExam() {
        const e = this.exam;
        if (!e || e.finished) return;
        this.stopTimer();
        const byNote: ExamResult["byNote"] = {};
        let correct = 0;
        for (const q of e.questions) {
            const ok = q.chosen !== null && q.question.options[q.chosen].correct;
            if (ok) correct++;
            const r = byNote[q.path] ?? (byNote[q.path] = { correct: 0, total: 0 });
            r.total++;
            if (ok) r.correct++;
        }
        const end = e.deadline ? Math.min(Date.now(), e.deadline) : Date.now();
        e.finished = { t: Date.now(), durationMs: end - e.startedAt, correct, total: e.questions.length, byNote };
        this.plugin.srs.exams.push(e.finished);
        if (this.plugin.srs.exams.length > 200) this.plugin.srs.exams.shift();
        this.plugin.requestSave();
        this.renderExamResult();
    }

    private renderExamResult() {
        const e = this.exam!;
        const r = e.finished!;
        const comp = this.freshComponent();
        const el = this.contentEl;
        el.empty();
        const page = el.createDiv({ cls: "nlm-page nlm-session" });
        this.sessionTop(page, t("Exam results"), 1, 1, () => this.renderDashboard());

        const pct = Math.round((r.correct / r.total) * 100);
        const done = page.createDiv({ cls: "nlm-session-done" });
        scoreRing(done, pct);
        done.createEl("h2", { text: verdict(pct) });
        const stats = done.createDiv({ cls: "nlm-done-stats" });
        doneStat(stats, `${r.correct}/${r.total}`, t("correct"));
        doneStat(stats, formatDuration(r.durationMs), t("time"));
        const prev = this.plugin.srs.exams.slice(0, -1).slice(-1)[0];
        if (prev) {
            const diff = pct - Math.round((prev.correct / prev.total) * 100);
            doneStat(stats, `${diff >= 0 ? "+" : ""}${diff}`, t("vs. last exam"));
        }

        // Per topic
        const topics = page.createDiv({ cls: "nlm-panel" });
        topics.createDiv({ cls: "nlm-panel-title", text: t("By topic") });
        const entries = Object.entries(r.byNote).sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total);
        for (const [path, v] of entries) {
            const row = topics.createDiv({ cls: "nlm-exam-row" });
            const a = row.createEl("a", { cls: "nlm-exam-topic", text: this.plugin.index.decks.get(path)?.title ?? path });
            a.onclick = () => void this.app.workspace.openLinkText(path, "", false);
            const p = Math.round((v.correct / v.total) * 100);
            const bar = row.createDiv({ cls: "nlm-mini-progress" });
            const fill = bar.createDiv({ cls: "nlm-mini-progress-bar" });
            fill.style.width = `${p}%`;
            fill.toggleClass("is-low", p < 60);
            row.createSpan({ cls: "nlm-exam-score", text: `${v.correct}/${v.total}` });
        }

        // Mistakes
        const wrong = e.questions.filter(q => q.chosen === null || !q.question.options[q.chosen].correct);
        const actions = page.createDiv({ cls: "nlm-actions nlm-center" });
        if (wrong.length) {
            actions.createEl("button", { cls: "mod-cta", text: t("Retry {n} mistakes", { n: wrong.length }) }).onclick = () =>
                this.startExam([], wrong.length, 0, wrong.map(w => ({ path: w.path, question: w.question })));
        }
        actions.createEl("button", { text: t("New exam") }).onclick = () => this.renderExamSetup();
        actions.createEl("button", { text: t("Back to dashboard") }).onclick = () => this.renderDashboard();

        if (wrong.length) {
            const review = page.createDiv({ cls: "nlm-panel" });
            review.createDiv({ cls: "nlm-panel-title", text: t("Review your mistakes") });
            for (const q of wrong) {
                const item = review.createDiv({ cls: "nlm-exam-mistake" });
                const qEl = item.createDiv({ cls: "nlm-quiz-question" });
                void MarkdownRenderer.render(this.app, q.question.question, qEl, q.path, comp);
                const right = q.question.options.find(o => o.correct);
                if (q.chosen !== null) {
                    const yours = q.question.options[q.chosen];
                    const y = item.createDiv({ cls: "nlm-exam-answer is-wrong" });
                    y.createSpan({ cls: "nlm-exam-answer-label", text: t("Your answer") });
                    y.createSpan({ text: yours.text });
                    if (yours.rationale) item.createDiv({ cls: "nlm-rationale", text: yours.rationale });
                } else {
                    item.createDiv({ cls: "nlm-exam-answer is-wrong", text: t("Not answered") });
                }
                if (right) {
                    const c = item.createDiv({ cls: "nlm-exam-answer is-correct" });
                    c.createSpan({ cls: "nlm-exam-answer-label", text: t("Correct answer") });
                    c.createSpan({ text: right.text });
                    if (right.rationale) item.createDiv({ cls: "nlm-rationale", text: right.rationale });
                }
            }
        }
    }

    // --- Keyboard -------------------------------------------------------------

    private onKey(e: KeyboardEvent) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        const key = e.key.toLowerCase();

        if (this.exam && !this.exam.finished) {
            const ex = this.exam;
            const q = ex.questions[ex.pos];
            if (/^[a-h]$/.test(key)) {
                const shown = key.charCodeAt(0) - 97;
                if (shown < q.order.length) { e.preventDefault(); this.chooseExam(q.order[shown]); }
            } else if (key === "arrowright" && ex.pos < ex.questions.length - 1) { e.preventDefault(); ex.pos++; void this.renderExam(); }
            else if (key === "arrowleft" && ex.pos > 0) { e.preventDefault(); ex.pos--; void this.renderExam(); }
            return;
        }

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
            if (s.current.kind !== "quiz" && (key === " " || key === "enter")) {
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
    const el = parent.createDiv({ cls: "nlm-tile" });
    setIcon(el.createDiv({ cls: "nlm-tile-icon" }), icon);
    const text = el.createDiv();
    text.createDiv({ cls: "nlm-tile-value", text: value });
    text.createDiv({ cls: "nlm-tile-label", text: label });
    if (sub) text.createDiv({ cls: "nlm-tile-sub", text: sub });
}

function doneStat(parent: HTMLElement, value: string, label: string) {
    const d = parent.createDiv({ cls: "nlm-done-stat" });
    d.createDiv({ cls: "nlm-done-value", text: value });
    d.createDiv({ cls: "nlm-muted", text: label });
}

function scoreRing(parent: HTMLElement, pct: number) {
    const ring = parent.createDiv({ cls: "nlm-score-ring" });
    ring.style.setProperty("--pct", String(pct));
    ring.createSpan({ text: `${pct}%` });
}

function verdict(pct: number): string {
    return pct >= 90 ? t("Excellent!") : pct >= 70 ? t("Well done") : pct >= 50 ? t("Getting there") : t("Keep practicing");
}

function stateKey(state: State | undefined): string {
    switch (state) {
        case State.Learning: return "learning";
        case State.Review: return "review";
        case State.Relearning: return "relearning";
        default: return "new";
    }
}

function stateName(state: State | undefined): string {
    switch (state) {
        case State.Learning: return t("Learning");
        case State.Review: return t("Review");
        case State.Relearning: return t("Relearning");
        default: return t("New");
    }
}

function formatClock(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, "0");
    return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
    const m = Math.round(ms / 60000);
    return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
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
