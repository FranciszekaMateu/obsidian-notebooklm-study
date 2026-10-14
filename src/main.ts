import { Editor, MarkdownView, Menu, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { State } from "ts-fsrs";
import { AutoSync } from "./autosync";
import { registerBlocks } from "./blocks";
import { clozeCallout, flashcardCallout, quizCallout } from "./callouts";
import { Generator } from "./generate";
import { setLanguage, t, tn } from "./i18n";
import { Artifact, MEDIA_KIND_TYPE, MediaKind, NlmCli, Notebook, STUDY_KINDS, StudyKind } from "./nlm-cli";
import { NoteToolbars } from "./note-toolbar";
import { NoteWriter } from "./note-writer";
import { DEFAULT_SETTINGS, NotebookLMStudySettings, NotebookLMStudySettingTab } from "./settings";
import { DeckIndex } from "./srs/deck-index";
import { Scheduler, SrsData, emptySrs } from "./srs/scheduler";
import { hasLegacyBlocks } from "./study-content";
import { StudyItem } from "./types";
import { BROWSER_VIEW, BrowserView } from "./views/browser-view";
import { SIDEBAR_VIEW, SidebarSection, SidebarView } from "./views/sidebar-view";
import { STUDY_VIEW, StudyFilter, StudyView } from "./views/study-view";

interface SyncState {
    /** Artifact id -> time it was first imported. */
    imported: Record<string, number>;
    lastRun: number;
}

interface PluginData {
    settings: NotebookLMStudySettings;
    srs: SrsData;
    sync: SyncState;
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
    syncState!: SyncState;
    scheduler!: Scheduler;
    index!: DeckIndex;
    writer!: NoteWriter;
    generator!: Generator;
    autoSync!: AutoSync;
    private statusEl: HTMLElement | null = null;

    requestSave = debounce(() => void this.persist(), 1500, true);

    async onload() {
        await this.loadPluginData();
        setLanguage(this.settings.language);
        this.scheduler = new Scheduler(this.srs, this.schedulerOptions());
        this.index = new DeckIndex(this.app);
        this.writer = new NoteWriter(this.app, this.settings, this.index);
        this.generator = new Generator(this);
        this.autoSync = new AutoSync(this);

        this.registerView(STUDY_VIEW, leaf => new StudyView(leaf, this));
        this.registerView(SIDEBAR_VIEW, leaf => new SidebarView(leaf, this));
        this.registerView(BROWSER_VIEW, leaf => new BrowserView(leaf, this));
        registerBlocks(this);
        this.addSettingTab(new NotebookLMStudySettingTab(this.app, this));

        this.addRibbonIcon("graduation-cap", "NotebookLM Study", () => void this.openSidebar());
        this.registerCommands();
        this.registerMenus();

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
            if (!this.app.workspace.getLeavesOfType(SIDEBAR_VIEW).length) {
                await this.app.workspace.getRightLeaf(false)?.setViewState({ type: SIDEBAR_VIEW, active: false });
            }
            this.autoSync.schedule();
            if (this.settings.autoSyncOnStartup && Platform.isDesktopApp) {
                window.setTimeout(() => void this.autoSync.run(true), 15_000);
            }
        });
    }

    async onunload() {
        this.autoSync?.stop();
        await this.persist();
    }

    private registerCommands() {
        this.addCommand({ id: "open-panel", name: t("Open panel"), callback: () => void this.openSidebar() });
        this.addCommand({ id: "open-dashboard", name: t("Open study dashboard"), callback: () => void this.openStudy() });
        this.addCommand({ id: "open-browser", name: t("Open card browser"), callback: () => void this.openBrowser() });
        this.addCommand({ id: "study-all", name: t("Study all due cards"), callback: () => void this.openStudy({}) });
        this.addCommand({ id: "start-exam", name: t("Start an exam"), callback: () => void this.openExamSetup() });
        this.addCommand({
            id: "study-current-note",
            name: t("Study current note"),
            checkCallback: checking => {
                const deck = this.activeDeck();
                if (!deck?.items.length) return false;
                if (!checking) void this.openStudy({ path: deck.path });
                return true;
            },
        });
        this.addCommand({
            id: "practice-quiz",
            name: t("Practice quiz in current note"),
            checkCallback: checking => {
                const deck = this.activeDeck();
                if (!deck?.items.some(i => i.kind === "quiz")) return false;
                if (!checking) void this.openQuizPractice(deck.path);
                return true;
            },
        });
        this.addCommand({
            id: "insert-flashcard",
            name: t("Insert flashcard"),
            editorCallback: (editor: Editor) => insertBlock(editor, flashcardCallout({ front: t("Question"), back: t("Answer") })),
        });
        this.addCommand({
            id: "insert-reversible-flashcard",
            name: t("Insert reversible flashcard"),
            editorCallback: (editor: Editor) => insertBlock(editor, flashcardCallout({ front: t("Term"), back: t("Definition"), reverse: true })),
        });
        this.addCommand({
            id: "insert-cloze",
            name: t("Insert cloze card"),
            editorCallback: (editor: Editor) => {
                const sel = editor.getSelection();
                const text = sel ? sel.replace(/\*\*(.+?)\*\*|==(.+?)==/g, (_m, a, b) => `{{${a ?? b}}}`) : t("The {{answer}} goes inside double braces.");
                insertBlock(editor, clozeCallout({ title: "", text }), !!sel);
            },
        });
        this.addCommand({
            id: "insert-quiz",
            name: t("Insert quiz question"),
            editorCallback: (editor: Editor) => insertBlock(editor, quizCallout({
                question: t("Question"),
                options: [{ text: t("Wrong option"), correct: false }, { text: t("Right option"), correct: true }],
                hint: t("Optional hint"),
            })),
        });
        this.addCommand({
            id: "convert-legacy",
            name: t("Convert current note to callout format"),
            checkCallback: checking => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view?.file || !hasLegacyBlocks(view.getViewData())) return false;
                if (!checking) void this.writer.convertLegacy(view.file);
                return true;
            },
        });
        this.addCommand({
            id: "convert-legacy-all",
            name: t("Convert all notes to callout format"),
            callback: async () => {
                let n = 0;
                for (const d of this.index.list()) {
                    const file = this.app.vault.getAbstractFileByPath(d.path);
                    if (file instanceof TFile && await this.writer.convertLegacy(file)) n++;
                }
                new Notice(n ? tn(n, "Converted {n} note to callouts.", "Converted {n} notes to callouts.") : t("No notes use the old format."));
            },
        });
        this.addCommand({ id: "import-file", name: t("Import CSV / JSON export"), callback: () => void this.openSidebar("import") });

        if (Platform.isDesktopApp) {
            this.addCommand({ id: "sync-notebook", name: t("Add from NotebookLM"), callback: () => void this.openSidebar("sync") });
            this.addCommand({ id: "check-new", name: t("Check NotebookLM for new items"), callback: () => void this.autoSync.run(false) });
            this.addCommand({ id: "resync-all", name: t("Update all synced notes from NotebookLM"), callback: () => void this.resyncAll() });
            this.addCommand({
                id: "generate-current-note",
                name: t("Generate study material from current note"),
                checkCallback: checking => {
                    const file = this.app.workspace.getActiveFile();
                    if (!file || file.extension !== "md") return false;
                    if (!checking) void this.openSidebar("generate", [file]);
                    return true;
                },
            });
            this.addCommand({ id: "ask-notebook", name: t("Ask a notebook"), callback: () => void this.openSidebar("ask") });
            this.addCommand({
                id: "resync-current-note",
                name: t("Update current note from NotebookLM"),
                checkCallback: checking => {
                    const deck = this.activeDeck();
                    if (!deck?.notebookId || !deck.artifactId) return false;
                    if (!checking) void this.resyncAll([deck.path]);
                    return true;
                },
            });
        }
    }

    private registerMenus() {
        if (!Platform.isDesktopApp) return;
        this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
            const notes = file instanceof TFolder ? collectNotes(file) : file instanceof TFile && file.extension === "md" ? [file] : [];
            if (!notes.length) return;
            menu.addItem(item => item
                .setTitle(t("Generate with NotebookLM"))
                .setIcon("sparkles")
                .onClick(() => void this.openSidebar("generate", notes)));
        }));
        this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
            const sel = editor.getSelection().trim();
            if (!sel) return;
            menu.addItem(item => item
                .setTitle(t("Ask NotebookLM about this"))
                .setIcon("message-circle-question")
                .onClick(() => void this.openSidebar("ask", undefined, sel)));
            menu.addItem(item => item
                .setTitle(t("Turn into cloze card"))
                .setIcon("brackets")
                .onClick(() => {
                    const text = sel.includes("{{") ? sel : sel.replace(/\*\*(.+?)\*\*|==(.+?)==/g, (_m, a, b) => `{{${a ?? b}}}`);
                    editor.replaceSelection(clozeCallout({ title: "", text: text.includes("{{") ? text : `{{${text}}}` }));
                }));
        }));
    }

    private activeDeck() {
        const file = this.app.workspace.getActiveFile();
        return file ? this.index.decks.get(file.path) : undefined;
    }

    // --- Persistence --------------------------------------------------------

    private async loadPluginData() {
        const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
        this.srs = Object.assign(emptySrs(), data.srs);
        this.syncState = Object.assign({ imported: {}, lastRun: 0 }, data.sync);
    }

    private async persist() {
        const data: PluginData = { settings: this.settings, srs: this.srs, sync: this.syncState };
        await this.saveData(data);
    }

    async saveSettings() {
        this.scheduler?.setOptions(this.schedulerOptions());
        await this.persist();
        this.index?.trigger("reviewed");
    }

    /** Apply a language change to everything that is on screen. */
    refreshLanguage() {
        setLanguage(this.settings.language);
        this.index.trigger("changed");
        for (const type of [STUDY_VIEW, SIDEBAR_VIEW, BROWSER_VIEW]) {
            this.app.workspace.getLeavesOfType(type).forEach(l => (l.view as unknown as { refresh?: () => void }).refresh?.());
        }
        this.updateStatusBar();
    }

    private schedulerOptions() {
        const s = this.settings;
        return {
            desiredRetention: s.desiredRetention,
            maximumInterval: s.maximumInterval,
            enableFuzz: s.enableFuzz,
            dayStartHour: s.dayStartHour,
            weights: s.fsrsWeights,
        };
    }

    // --- Counting -----------------------------------------------------------

    nlm(): NlmCli {
        return new NlmCli(this.settings.nlmPath || NlmCli.detectBinary(), this.settings.nlmProfile, this.settings.nlmLanguage);
    }

    /** Drop suspended cards, and quiz questions when they are not reviewed. */
    filterStudyable(items: StudyItem[]): StudyItem[] {
        const quiz = this.settings.includeQuizInReview;
        return items.filter(i => (quiz || i.kind !== "quiz") && !this.scheduler.isSuspended(i.id));
    }

    studyableItems(filter: StudyFilter = {}): StudyItem[] {
        const ids = filter.ids ? new Set(filter.ids) : null;
        const items = this.filterStudyable(this.index.items(d =>
            (!filter.path || d.path === filter.path) && (!filter.deck || d.deck === filter.deck)
        ));
        return ids ? items.filter(i => ids.has(i.id)) : items;
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
        el.createSpan({ text: n ? t("{n} to study", { n }) : t("Up to date") });
        el.setAttr("aria-label", n ? t("Start reviewing") : t("Nothing due"));
        el.toggleClass("has-due", n > 0);
    }

    // --- Navigation ---------------------------------------------------------

    async openSidebar(section?: SidebarSection, notes?: TFile[], question?: string) {
        let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW)[0] ?? null;
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            if (!leaf) return;
            await leaf.setViewState({ type: SIDEBAR_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
        if (section && leaf.view instanceof SidebarView) leaf.view.reveal(section, { notes, question });
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
        (await this.studyView())?.startQuiz(path);
    }

    async openExamSetup(paths?: string[]) {
        (await this.studyView())?.renderExamSetup(paths);
    }

    async openBrowser(query?: string) {
        let leaf = this.app.workspace.getLeavesOfType(BROWSER_VIEW)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: BROWSER_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
        if (query !== undefined && leaf.view instanceof BrowserView) leaf.view.search(query);
    }

    openSettings() {
        const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
        setting.open();
        setting.openTabById(this.manifest.id);
    }

    // --- NotebookLM -----------------------------------------------------------

    wasImported(artifactId: string): boolean {
        return artifactId in this.syncState.imported;
    }

    markImported(artifactId: string) {
        this.syncState.imported[artifactId] = Date.now();
        this.requestSave();
    }

    /** Download one artifact into the vault. Returns the note, or null on failure (already reported). */
    async importArtifact(nb: Pick<Notebook, "id" | "title">, a: Artifact): Promise<TFile | null> {
        const cli = this.nlm();
        const origin = { source: "notebooklm" as const, notebookId: nb.id, notebookTitle: nb.title, artifactId: a.id };
        try {
            let file: TFile;
            if ((STUDY_KINDS as string[]).includes(a.kind)) {
                const content = await cli.download(nb.id, { id: a.id, kind: a.kind as StudyKind });
                file = (await this.writer.write({ content, title: a.title, origin })).file;
            } else {
                const kind = a.kind as MediaKind;
                const { data, ext } = await cli.downloadMedia(nb.id, { id: a.id, kind });
                file = (await this.writer.writeMedia({ type: MEDIA_KIND_TYPE[kind], title: a.title, origin, data, ext })).file;
            }
            this.markImported(a.id);
            return file;
        } catch (e) {
            console.error("NotebookLM Study: import failed", a, e);
            new Notice(`${a.title}: ${(e as Error).message}`, 8000);
            return null;
        }
    }

    async importArtifacts(nb: Notebook, chosen: Artifact[], progress: (msg: string) => void): Promise<TFile[]> {
        const files: TFile[] = [];
        for (const [i, a] of chosen.entries()) {
            progress(t("Downloading {i}/{n}: {name}", { i: i + 1, n: chosen.length, name: a.title }));
            const file = await this.importArtifact(nb, a);
            if (file) files.push(file);
        }
        if (files.length) new Notice(tn(files.length, "Imported {n} item from {name}.", "Imported {n} items from {name}.", { name: nb.title }));
        return files;
    }

    /** Re-download every note linked to a flashcards / quiz / mind map artifact (or just the given paths). */
    async resyncAll(paths?: string[], progress?: (msg: string) => void) {
        const decks = this.index.list().filter(d =>
            d.notebookId && d.artifactId && ["flashcards", "quiz", "mindmap"].includes(d.type) && (!paths || paths.includes(d.path))
        );
        if (!decks.length) {
            new Notice(t("No notes linked to NotebookLM yet."));
            return;
        }
        const notice = progress ? null : new Notice(t("Updating {n} note(s) from NotebookLM…", { n: decks.length }), 0);
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
                report(t("Updating {i}/{n}: {name}", { i: i + 1, n: decks.length, name: d.title }));
                const kind: StudyKind = d.type === "mindmap" ? "mind_map" : d.type as StudyKind;
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
        new Notice(t("Updated {n} note(s).", { n: ok }) + (failures.length ? `\n${t("Failed:")}\n${failures.join("\n")}` : ""), failures.length ? 10000 : 4000);
    }
}

function collectNotes(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") out.push(child);
        else if (child instanceof TFolder) out.push(...collectNotes(child));
    }
    return out;
}

function insertBlock(editor: Editor, block: string, replaceSelection = false) {
    if (replaceSelection) {
        editor.replaceSelection(block);
        return;
    }
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const prefix = line.trim() ? "\n\n" : "";
    editor.replaceRange(`${prefix}${block}\n`, { line: cursor.line, ch: line.length });
}
