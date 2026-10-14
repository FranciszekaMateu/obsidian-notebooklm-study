import { Editor, MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { State } from "ts-fsrs";
import { registerBlocks } from "./blocks";
import { flashcardCallout, quizCallout } from "./callouts";
import { Artifact, NlmCli, Notebook } from "./nlm-cli";
import { NoteToolbars } from "./note-toolbar";
import { NoteWriter } from "./note-writer";
import { DEFAULT_SETTINGS, NotebookLMStudySettings, NotebookLMStudySettingTab } from "./settings";
import { DeckIndex } from "./srs/deck-index";
import { Scheduler, SrsData } from "./srs/scheduler";
import { hasLegacyBlocks } from "./study-content";
import { StudyItem } from "./types";
import { SIDEBAR_VIEW, SidebarView } from "./views/sidebar-view";
import { STUDY_VIEW, StudyFilter, StudyView } from "./views/study-view";

interface PluginData {
    settings: NotebookLMStudySettings;
    srs: SrsData;
}

export interface StateCounts {
    /** Never studied. */
    fresh: number;
    /** In (re)learning steps and due today. */
    learning: number;
    /** In review and due today. */
    due: number;
    /** In review state (due or not): "learned". */
    review: number;
}

export default class NotebookLMStudy extends Plugin {
    settings!: NotebookLMStudySettings;
    srs!: SrsData;
    scheduler!: Scheduler;
    index!: DeckIndex;
    writer!: NoteWriter;
    private statusEl: HTMLElement | null = null;

    requestSave = debounce(() => void this.persist(), 1500, true);

    async onload() {
        await this.loadPluginData();
        this.scheduler = new Scheduler(this.srs, this.schedulerOptions());
        this.index = new DeckIndex(this.app);
        this.writer = new NoteWriter(this.app, this.settings, this.index);

        this.registerView(STUDY_VIEW, leaf => new StudyView(leaf, this));
        this.registerView(SIDEBAR_VIEW, leaf => new SidebarView(leaf, this));
        registerBlocks(this);
        this.addSettingTab(new NotebookLMStudySettingTab(this.app, this));

        this.addRibbonIcon("graduation-cap", "NotebookLM Study", () => void this.openSidebar());
        this.registerCommands();

        if (!Platform.isMobile) {
            this.statusEl = this.addStatusBarItem();
            this.statusEl.addClass("nlm-status-bar", "mod-clickable");
            this.statusEl.onclick = () => void this.openStudy({});
            const update = () => this.updateStatusBar();
            this.registerEvent(this.index.on("changed", update));
            this.registerEvent(this.index.on("reviewed", update));
            this.registerInterval(window.setInterval(update, 60_000));
        }

        this.app.workspace.onLayoutReady(async () => {
            await this.index.rebuild();
            this.registerEvent(this.app.metadataCache.on("changed", file => void this.index.indexFile(file)));
            this.registerEvent(this.app.vault.on("delete", file => this.index.remove(file)));
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.index.rename(file, oldPath)));
            new NoteToolbars(this).register();
            // First run: put the panel in the right sidebar without stealing focus.
            if (!this.app.workspace.getLeavesOfType(SIDEBAR_VIEW).length) {
                await this.app.workspace.getRightLeaf(false)?.setViewState({ type: SIDEBAR_VIEW, active: false });
            }
        });
    }

    async onunload() {
        await this.persist();
    }

    private registerCommands() {
        this.addCommand({ id: "open-panel", name: "Open panel", callback: () => void this.openSidebar() });
        this.addCommand({ id: "open-dashboard", name: "Open study dashboard", callback: () => void this.openStudy() });
        this.addCommand({ id: "study-all", name: "Study all due cards", callback: () => void this.openStudy({}) });
        this.addCommand({
            id: "study-current-note",
            name: "Study current note",
            checkCallback: checking => {
                const file = this.app.workspace.getActiveFile();
                const deck = file && this.index.decks.get(file.path);
                if (!deck?.items.length) return false;
                if (!checking) void this.openStudy({ path: deck.path });
                return true;
            },
        });
        this.addCommand({
            id: "practice-quiz",
            name: "Practice quiz in current note",
            checkCallback: checking => {
                const file = this.app.workspace.getActiveFile();
                const deck = file && this.index.decks.get(file.path);
                if (!deck?.items.some(i => i.kind === "quiz")) return false;
                if (!checking) void this.openQuizPractice(deck.path);
                return true;
            },
        });
        this.addCommand({
            id: "insert-flashcard",
            name: "Insert flashcard",
            editorCallback: (editor: Editor) => insertBlock(editor, flashcardCallout({ front: "Question", back: "Answer" })),
        });
        this.addCommand({
            id: "insert-quiz",
            name: "Insert quiz question",
            editorCallback: (editor: Editor) => insertBlock(editor, quizCallout({
                question: "Question",
                options: [{ text: "Wrong option", correct: false }, { text: "Right option", correct: true }],
                hint: "Optional hint",
            })),
        });
        this.addCommand({
            id: "convert-legacy",
            name: "Convert current note to callout format",
            checkCallback: checking => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view?.file || !hasLegacyBlocks(view.getViewData())) return false;
                if (!checking) void this.writer.convertLegacy(view.file);
                return true;
            },
        });
        this.addCommand({
            id: "convert-legacy-all",
            name: "Convert all notes to callout format",
            callback: async () => {
                let n = 0;
                for (const d of this.index.list()) {
                    const file = this.app.vault.getAbstractFileByPath(d.path);
                    if (file instanceof TFile && await this.writer.convertLegacy(file)) n++;
                }
                new Notice(n ? `Converted ${n} note${n === 1 ? "" : "s"} to callouts.` : "No notes use the old format.");
            },
        });
        this.addCommand({ id: "import-file", name: "Import CSV / JSON export", callback: () => void this.openSidebar("import") });

        if (Platform.isDesktopApp) {
            this.addCommand({ id: "sync-notebook", name: "Add from NotebookLM", callback: () => void this.openSidebar("sync") });
            this.addCommand({ id: "resync-all", name: "Update all synced notes from NotebookLM", callback: () => void this.resyncAll() });
            this.addCommand({
                id: "resync-current-note",
                name: "Update current note from NotebookLM",
                checkCallback: checking => {
                    const file = this.app.workspace.getActiveFile();
                    const deck = file && this.index.decks.get(file.path);
                    if (!deck?.notebookId || !deck.artifactId) return false;
                    if (!checking) void this.resyncAll([deck.path]);
                    return true;
                },
            });
        }
    }

    // --- Persistence --------------------------------------------------------

    private async loadPluginData() {
        const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
        this.srs = { cards: data.srs?.cards ?? {}, log: data.srs?.log ?? [] };
    }

    private async persist() {
        const data: PluginData = { settings: this.settings, srs: this.srs };
        await this.saveData(data);
    }

    async saveSettings() {
        this.scheduler?.setOptions(this.schedulerOptions());
        await this.persist();
        this.index?.trigger("reviewed");
    }

    private schedulerOptions() {
        const s = this.settings;
        return {
            desiredRetention: s.desiredRetention,
            maximumInterval: s.maximumInterval,
            enableFuzz: s.enableFuzz,
            dayStartHour: s.dayStartHour,
        };
    }

    // --- Counting -----------------------------------------------------------

    nlm(): NlmCli {
        return new NlmCli(this.settings.nlmPath || NlmCli.detectBinary(), this.settings.nlmProfile);
    }

    filterStudyable(items: StudyItem[]): StudyItem[] {
        return this.settings.includeQuizInReview ? items : items.filter(i => i.kind === "flashcard");
    }

    studyableItems(filter: StudyFilter = {}): StudyItem[] {
        return this.filterStudyable(this.index.items(d =>
            d.type !== "mindmap" && (!filter.path || d.path === filter.path) && (!filter.deck || d.deck === filter.deck)
        ));
    }

    stateCounts(ids: string[]): StateCounts {
        const end = this.scheduler.dayEnd();
        const c: StateCounts = { fresh: 0, learning: 0, due: 0, review: 0 };
        for (const id of ids) {
            const s = this.scheduler.stored(id);
            if (!s || s.state === State.New) c.fresh++;
            else if (s.state === State.Review) {
                c.review++;
                if (s.due < end) c.due++;
            } else if (s.due < end) c.learning++;
        }
        return c;
    }

    newLeftToday(): number {
        return Math.max(0, this.settings.newPerDay - this.scheduler.stats().newToday);
    }

    /** Cards to study right now, with the daily new-card limit applied. */
    todoCount(items = this.studyableItems()): number {
        const c = this.stateCounts(items.map(i => i.id));
        return c.due + c.learning + Math.min(c.fresh, this.newLeftToday());
    }

    private updateStatusBar() {
        const el = this.statusEl;
        if (!el || !this.index.ready) return;
        const n = this.todoCount();
        el.empty();
        setIcon(el.createSpan({ cls: "nlm-status-icon" }), "graduation-cap");
        el.createSpan({ text: n ? `${n} to study` : "Up to date" });
        el.setAttr("aria-label", n ? "Start reviewing" : "Nothing due — open NotebookLM Study");
        el.toggleClass("has-due", n > 0);
    }

    // --- Navigation ---------------------------------------------------------

    async openSidebar(section?: "sync" | "import") {
        let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW)[0] ?? null;
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            if (!leaf) return;
            await leaf.setViewState({ type: SIDEBAR_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
        if (section && leaf.view instanceof SidebarView) leaf.view.reveal(section);
    }

    private async studyView(): Promise<StudyView | null> {
        let leaf = this.app.workspace.getLeavesOfType(STUDY_VIEW)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: STUDY_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
        return leaf.view instanceof StudyView ? leaf.view : null;
    }

    async openStudy(filter?: StudyFilter) {
        const view = await this.studyView();
        if (!view) return;
        if (filter) view.startSession(filter);
        else view.renderDashboard();
    }

    async openQuizPractice(path: string) {
        const view = await this.studyView();
        view?.startQuiz(path);
    }

    openSettings() {
        const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
        setting.open();
        setting.openTabById(this.manifest.id);
    }

    // --- NotebookLM -----------------------------------------------------------

    async importArtifacts(nb: Notebook, chosen: Artifact[], progress: (msg: string) => void): Promise<TFile[]> {
        const files: TFile[] = [];
        const failures: string[] = [];
        const cli = this.nlm();
        for (const [i, a] of chosen.entries()) {
            progress(`Downloading ${i + 1}/${chosen.length}: ${a.title}`);
            try {
                const content = await cli.download(nb.id, a);
                const res = await this.writer.write({
                    content,
                    title: a.title,
                    origin: { source: "notebooklm", notebookId: nb.id, notebookTitle: nb.title, artifactId: a.id },
                });
                files.push(res.file);
            } catch (e) {
                console.error("NotebookLM Study: download failed", a, e);
                failures.push(`${a.title}: ${(e as Error).message}`);
            }
        }
        if (failures.length) new Notice(`Some items failed:\n${failures.join("\n")}`, 10000);
        if (files.length) new Notice(`Imported ${files.length} item${files.length > 1 ? "s" : ""} from ${nb.title}.`);
        return files;
    }

    /** Re-download every note linked to a NotebookLM artifact (or just the given paths). */
    async resyncAll(paths?: string[], progress?: (msg: string) => void) {
        const decks = this.index.list().filter(d =>
            d.notebookId && d.artifactId && (!paths || paths.includes(d.path))
        );
        if (!decks.length) {
            new Notice("No notes linked to NotebookLM yet.");
            return;
        }
        const notice = progress ? null : new Notice(`Updating ${decks.length} note(s) from NotebookLM…`, 0);
        const report = (msg: string) => (progress ? progress(msg) : notice?.setMessage(msg));
        const cli = this.nlm();
        let ok = 0;
        const failures: string[] = [];
        for (const [i, d] of decks.entries()) {
            const file = this.app.vault.getAbstractFileByPath(d.path);
            if (!(file instanceof TFile)) continue;
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
            if (fm["nlm-lock"] === true) continue;
            try {
                report(`Updating ${i + 1}/${decks.length}: ${d.title}`);
                const kind = d.type === "mindmap" ? "mind_map" : d.type;
                const content = await cli.download(d.notebookId!, { id: d.artifactId!, kind });
                await this.writer.write({
                    content,
                    title: d.title,
                    deck: d.deck,
                    origin: { source: "notebooklm", notebookId: d.notebookId, notebookTitle: d.notebookTitle, artifactId: d.artifactId },
                });
                ok++;
            } catch (e) {
                failures.push(`${d.title}: ${(e as Error).message}`);
            }
        }
        notice?.hide();
        new Notice(`Updated ${ok} note(s).${failures.length ? `\nFailed:\n${failures.join("\n")}` : ""}`, failures.length ? 10000 : 4000);
    }
}

function insertBlock(editor: Editor, block: string) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const prefix = line.trim() ? "\n\n" : "";
    editor.replaceRange(`${prefix}${block}\n`, { line: cursor.line, ch: line.length });
}
