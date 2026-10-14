import { Notice, Platform, Plugin, TFile, debounce } from "obsidian";
import { State } from "ts-fsrs";
import { registerBlocks } from "./blocks";
import { ImportModal } from "./modals/import-modal";
import { SyncModal } from "./modals/sync-modal";
import { NlmCli } from "./nlm-cli";
import { NoteWriter } from "./note-writer";
import { DEFAULT_SETTINGS, NotebookLMStudySettings, NotebookLMStudySettingTab } from "./settings";
import { DeckIndex } from "./srs/deck-index";
import { Scheduler, SrsData } from "./srs/scheduler";
import { STUDY_VIEW, StudyFilter, StudyView } from "./views/study-view";
import { StudyItem } from "./types";

interface PluginData {
    settings: NotebookLMStudySettings;
    srs: SrsData;
}

export default class NotebookLMStudy extends Plugin {
    settings!: NotebookLMStudySettings;
    srs!: SrsData;
    scheduler!: Scheduler;
    index!: DeckIndex;
    writer!: NoteWriter;

    requestSave = debounce(() => void this.persist(), 1500, true);

    async onload() {
        await this.loadPluginData();
        this.scheduler = new Scheduler(this.srs, this.schedulerOptions());
        this.index = new DeckIndex(this.app);
        this.writer = new NoteWriter(this.app, this.settings, this.index);

        this.registerView(STUDY_VIEW, leaf => new StudyView(leaf, this));
        registerBlocks(this);
        this.addSettingTab(new NotebookLMStudySettingTab(this.app, this));

        this.addRibbonIcon("graduation-cap", "NotebookLM study", () => void this.openStudy());

        this.addCommand({ id: "open-dashboard", name: "Open study dashboard", callback: () => void this.openStudy() });
        this.addCommand({ id: "study-all", name: "Study all due cards", callback: () => void this.openStudy({}) });
        this.addCommand({
            id: "study-current-note",
            name: "Study current note",
            checkCallback: checking => {
                const file = this.app.workspace.getActiveFile();
                const deck = file && this.index.decks.get(file.path);
                if (!deck || deck.type === "mindmap") return false;
                if (!checking) void this.openStudy({ path: file.path });
                return true;
            },
        });
        this.addCommand({ id: "import-file", name: "Import CSV / JSON export", callback: () => this.openImportModal() });

        if (Platform.isDesktopApp) {
            this.addCommand({ id: "sync-notebook", name: "Sync from NotebookLM", callback: () => this.openSyncModal() });
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

        this.app.workspace.onLayoutReady(async () => {
            await this.index.rebuild();
            this.registerEvent(this.app.metadataCache.on("changed", file => void this.index.indexFile(file)));
            this.registerEvent(this.app.vault.on("delete", file => this.index.remove(file)));
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.index.rename(file, oldPath)));
        });
    }

    async onunload() {
        await this.persist();
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

    // --- Helpers used by views and blocks ----------------------------------

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

    /** New / due counts for display, with the daily new-card limit applied. */
    countAvailable(items: StudyItem[]): { fresh: number; due: number } {
        return this.countDue(items.map(i => i.id));
    }

    countDue(ids: string[]): { fresh: number; due: number } {
        const end = this.scheduler.dayEnd();
        let fresh = 0;
        let due = 0;
        for (const id of ids) {
            const s = this.scheduler.stored(id);
            if (!s || s.state === State.New) fresh++;
            else if (s.due < end) due++;
        }
        const newLeft = Math.max(0, this.settings.newPerDay - this.scheduler.stats().newToday);
        return { fresh: Math.min(fresh, newLeft), due };
    }

    async openStudy(filter?: StudyFilter) {
        let leaf = this.app.workspace.getLeavesOfType(STUDY_VIEW)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: STUDY_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
        const view = leaf.view;
        if (!(view instanceof StudyView)) return;
        if (filter) view.startSession(filter);
        else view.renderDashboard();
    }

    openSyncModal() {
        if (!NlmCli.available) {
            new Notice("NotebookLM sync needs the desktop app.");
            return;
        }
        new SyncModal(this.app, this).open();
    }

    openImportModal() {
        new ImportModal(this.app, this).open();
    }

    /** Re-download every note linked to a NotebookLM artifact (or just the given paths). */
    async resyncAll(paths?: string[]) {
        const decks = this.index.list().filter(d =>
            d.notebookId && d.artifactId && (!paths || paths.includes(d.path))
        );
        if (!decks.length) {
            new Notice("No notes linked to NotebookLM yet.");
            return;
        }
        const notice = new Notice(`Updating ${decks.length} note(s) from NotebookLM…`, 0);
        const cli = this.nlm();
        let ok = 0;
        const failures: string[] = [];
        for (const d of decks) {
            const file = this.app.vault.getAbstractFileByPath(d.path);
            if (!(file instanceof TFile)) continue;
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
            if (fm["nlm-lock"] === true) continue;
            try {
                notice.setMessage(`Updating ${d.title}…`);
                const kind = d.type === "mindmap" ? "mind_map" : d.type;
                const content = await cli.download(d.notebookId!, { id: d.artifactId!, kind });
                await this.writer.write({
                    content,
                    title: d.title,
                    deck: d.deck,
                    origin: {
                        source: "notebooklm",
                        notebookId: d.notebookId,
                        notebookTitle: fm["nlm-notebook-title"],
                        artifactId: d.artifactId,
                    },
                });
                ok++;
            } catch (e) {
                failures.push(`${d.title}: ${(e as Error).message}`);
            }
        }
        notice.hide();
        new Notice(`Updated ${ok} note(s).${failures.length ? `\nFailed:\n${failures.join("\n")}` : ""}`, failures.length ? 10000 : 4000);
    }
}
