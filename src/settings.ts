import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { default_w } from "ts-fsrs";
import { LanguagePref, t } from "./i18n";
import type NotebookLMStudy from "./main";
import { NlmCli } from "./nlm-cli";
import { MIN_REVIEWS, optimize } from "./srs/optimizer";

export interface NotebookLMStudySettings {
    language: LanguagePref;

    rootFolder: string;
    folderPerNotebook: boolean;
    attachmentsFolder: string;
    openAfterImport: boolean;

    nlmPath: string;
    nlmProfile: string;
    /** NOTEBOOKLM_HL for generated content, e.g. "es-419". Empty = nlm default. */
    nlmLanguage: string;

    autoSyncHours: number;
    autoSyncOnStartup: boolean;
    autoSyncMedia: boolean;

    genFlashcardDifficulty: "easy" | "medium" | "hard";
    genQuizCount: number;
    genQuizDifficulty: number;

    mindmapCanvas: boolean;
    mindmapOutline: boolean;

    includeQuizInReview: boolean;
    newPerDay: number;
    maxReviewsPerDay: number;
    desiredRetention: number;
    maximumInterval: number;
    enableFuzz: boolean;
    dayStartHour: number;
    fsrsWeights: number[];
}

export const DEFAULT_SETTINGS: NotebookLMStudySettings = {
    language: "auto",

    rootFolder: "NotebookLM",
    folderPerNotebook: true,
    attachmentsFolder: "",
    openAfterImport: true,

    nlmPath: "",
    nlmProfile: "",
    nlmLanguage: "",

    autoSyncHours: 0,
    autoSyncOnStartup: false,
    autoSyncMedia: false,

    genFlashcardDifficulty: "medium",
    genQuizCount: 10,
    genQuizDifficulty: 3,

    mindmapCanvas: true,
    mindmapOutline: true,

    includeQuizInReview: true,
    newPerDay: 20,
    maxReviewsPerDay: 200,
    desiredRetention: 0.9,
    maximumInterval: 36500,
    enableFuzz: true,
    dayStartHour: 4,
    fsrsWeights: [],
};

export class NotebookLMStudySettingTab extends PluginSettingTab {
    private optimizing = false;

    constructor(app: App, private plugin: NotebookLMStudy) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        const s = this.plugin.settings;
        const save = () => this.plugin.saveSettings();
        containerEl.empty();

        new Setting(containerEl)
            .setName(t("Language"))
            .setDesc(t("Language of the plugin's interface."))
            .addDropdown(d => d
                .addOption("auto", t("Same as Obsidian"))
                .addOption("en", "English")
                .addOption("es", "Español")
                .setValue(s.language)
                .onChange(async v => {
                    s.language = v as LanguagePref;
                    await save();
                    this.plugin.refreshLanguage();
                    this.display();
                }));

        new Setting(containerEl).setName(t("Notes")).setHeading();

        new Setting(containerEl)
            .setName(t("Root folder"))
            .setDesc(t("Where imported flashcards, quizzes and mind maps are saved."))
            .addText(c => c.setPlaceholder("NotebookLM").setValue(s.rootFolder).onChange(async v => {
                s.rootFolder = v.trim().replace(/\/+$/, "");
                await save();
            }));

        new Setting(containerEl)
            .setName(t("One folder per notebook"))
            .setDesc(t("Create a sub-folder named after each NotebookLM notebook."))
            .addToggle(c => c.setValue(s.folderPerNotebook).onChange(async v => {
                s.folderPerNotebook = v;
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Attachments folder"))
            .setDesc(t("Where audio, infographics and slide decks are saved. Empty = next to their note."))
            .addText(c => c.setValue(s.attachmentsFolder).onChange(async v => {
                s.attachmentsFolder = v.trim().replace(/\/+$/, "");
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Open after import"))
            .addToggle(c => c.setValue(s.openAfterImport).onChange(async v => {
                s.openAfterImport = v;
                await save();
            }));

        new Setting(containerEl).setName(t("Mind maps")).setHeading();

        new Setting(containerEl)
            .setName(t("Create canvas"))
            .setDesc(t("Also generate an Obsidian Canvas file laid out as a tree."))
            .addToggle(c => c.setValue(s.mindmapCanvas).onChange(async v => {
                s.mindmapCanvas = v;
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Include outline"))
            .setDesc(t("Add the mind map as a plain nested list (works with the Markmap plugin)."))
            .addToggle(c => c.setValue(s.mindmapOutline).onChange(async v => {
                s.mindmapOutline = v;
                await save();
            }));

        if (Platform.isDesktopApp) this.displayNotebookLM(containerEl);

        this.displayFsrs(containerEl);

        new Setting(containerEl).setName(t("Data")).setHeading();

        new Setting(containerEl)
            .setName(t("Reset all review progress"))
            .setDesc(t("Forget scheduling and history for every card. Notes are not touched."))
            .addButton(b => b.setButtonText(t("Reset")).setWarning().onClick(async () => {
                if (!confirm(t("Delete all review history? This cannot be undone."))) return;
                const srs = this.plugin.srs;
                srs.cards = {};
                srs.log = [];
                srs.suspended = {};
                srs.exams = [];
                await this.plugin.saveSettings();
                new Notice(t("Review progress reset."));
            }));
    }

    private displayNotebookLM(containerEl: HTMLElement) {
        const s = this.plugin.settings;
        const save = () => this.plugin.saveSettings();

        new Setting(containerEl).setName(t("NotebookLM (nlm CLI)")).setHeading();

        new Setting(containerEl)
            .setName(t("nlm executable"))
            .setDesc(t("Path to the nlm CLI from notebooklm-mcp-cli. Leave empty to auto-detect."))
            .addText(c => c.setPlaceholder(NlmCli.detectBinary()).setValue(s.nlmPath).onChange(async v => {
                s.nlmPath = v.trim();
                await save();
            }))
            .addButton(b => b.setButtonText(t("Test")).onClick(async () => {
                try {
                    new Notice(t("Found {version}", { version: await this.plugin.nlm().version() }));
                } catch (e) {
                    new Notice((e as Error).message, 8000);
                }
            }));

        new Setting(containerEl)
            .setName(t("Profile"))
            .setDesc(t("nlm login profile to use. Leave empty for the default."))
            .addText(c => c.setValue(s.nlmProfile).onChange(async v => {
                s.nlmProfile = v.trim();
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Language of generated content"))
            .setDesc(t("Language NotebookLM uses for new flashcards, quizzes and audio, e.g. es-419 or es-ES. Empty = nlm default."))
            .addText(c => c.setPlaceholder("es-419").setValue(s.nlmLanguage).onChange(async v => {
                s.nlmLanguage = v.trim();
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Automatic sync"))
            .setDesc(t("Check notebooks that already have notes in the vault and import anything new."))
            .addDropdown(d => d
                .addOption("0", t("Off"))
                .addOption("1", t("Every hour"))
                .addOption("3", t("Every 3 hours"))
                .addOption("6", t("Every 6 hours"))
                .addOption("24", t("Once a day"))
                .setValue(String(s.autoSyncHours))
                .onChange(async v => {
                    s.autoSyncHours = Number(v);
                    await save();
                    this.plugin.autoSync.schedule();
                }));

        new Setting(containerEl)
            .setName(t("Sync when Obsidian starts"))
            .addToggle(c => c.setValue(s.autoSyncOnStartup).onChange(async v => {
                s.autoSyncOnStartup = v;
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Also import audio, reports and infographics"))
            .setDesc(t("Automatic sync imports flashcards, quizzes and mind maps; turn this on to bring the rest too."))
            .addToggle(c => c.setValue(s.autoSyncMedia).onChange(async v => {
                s.autoSyncMedia = v;
                await save();
            }));

        new Setting(containerEl)
            .setName(t("Default flashcard difficulty"))
            .addDropdown(d => d
                .addOption("easy", t("Easy"))
                .addOption("medium", t("Medium"))
                .addOption("hard", t("Hard"))
                .setValue(s.genFlashcardDifficulty)
                .onChange(async v => {
                    s.genFlashcardDifficulty = v as NotebookLMStudySettings["genFlashcardDifficulty"];
                    await save();
                }));

        numberSetting(containerEl, t("Default quiz length"), t("Number of questions NotebookLM is asked for."),
            s.genQuizCount, 1, 50, async v => { s.genQuizCount = v; await save(); });
        numberSetting(containerEl, t("Default quiz difficulty"), t("From 1 (easy) to 5 (hard)."),
            s.genQuizDifficulty, 1, 5, async v => { s.genQuizDifficulty = v; await save(); });
    }

    private displayFsrs(containerEl: HTMLElement) {
        const s = this.plugin.settings;
        const save = () => this.plugin.saveSettings();

        new Setting(containerEl).setName(t("Spaced repetition (FSRS)")).setHeading();

        new Setting(containerEl)
            .setName(t("Review quiz questions"))
            .setDesc(t("Include quiz questions in spaced-repetition sessions, alongside flashcards."))
            .addToggle(c => c.setValue(s.includeQuizInReview).onChange(async v => {
                s.includeQuizInReview = v;
                await save();
            }));

        numberSetting(containerEl, t("New cards per day"), t("Maximum number of new cards introduced each day."),
            s.newPerDay, 0, 9999, async v => { s.newPerDay = v; await save(); });

        numberSetting(containerEl, t("Maximum reviews per day"), t("Cap on review cards shown each day."),
            s.maxReviewsPerDay, 0, 99999, async v => { s.maxReviewsPerDay = v; await save(); });

        new Setting(containerEl)
            .setName(t("Desired retention"))
            .setDesc(t("Probability of recall FSRS aims for. Higher means more reviews."))
            .addSlider(sl => sl.setLimits(0.7, 0.98, 0.01).setValue(s.desiredRetention).setDynamicTooltip()
                .onChange(async v => { s.desiredRetention = v; await save(); }));

        numberSetting(containerEl, t("Maximum interval (days)"), t("Longest interval a card can be scheduled."),
            s.maximumInterval, 1, 36500, async v => { s.maximumInterval = v; await save(); });

        new Setting(containerEl)
            .setName(t("Interval fuzz"))
            .setDesc(t("Randomize intervals slightly so cards learned together don't stay together."))
            .addToggle(c => c.setValue(s.enableFuzz).onChange(async v => {
                s.enableFuzz = v;
                await save();
            }));

        numberSetting(containerEl, t("Next day starts at (hour)"), t("Reviews done before this hour count for the previous day."),
            s.dayStartHour, 0, 23, async v => { s.dayStartHour = v; await save(); });

        // Optimizer
        const custom = s.fsrsWeights.length > 0;
        const opt = new Setting(containerEl)
            .setName(t("Optimize parameters"))
            .setDesc(custom
                ? t("Using parameters fitted to your reviews.")
                : t("Fit FSRS to your own memory using your review history (needs at least {n} reviews made on a later day).", { n: MIN_REVIEWS }));
        const status = containerEl.createDiv({ cls: "nlm-opt-status setting-item-description" });

        opt.addButton(b => b.setButtonText(this.optimizing ? t("Optimizing…") : t("Optimize")).setCta().setDisabled(this.optimizing).onClick(async () => {
            this.optimizing = true;
            b.setDisabled(true).setButtonText(t("Optimizing…"));
            try {
                const sched = this.plugin.scheduler;
                const res = await optimize(this.plugin.srs.log, ts => sched.dayStart(ts), sched.weights, f => {
                    status.setText(t("Optimizing… {pct}%", { pct: Math.round(f * 100) }));
                });
                const better = res.after.logLoss < res.before.logLoss;
                status.setText(t("Log loss {a} → {b}, RMSE {c} → {d} ({n} reviews, {m} cards).", {
                    a: res.before.logLoss.toFixed(4), b: res.after.logLoss.toFixed(4),
                    c: (res.before.rmse * 100).toFixed(1) + "%", d: (res.after.rmse * 100).toFixed(1) + "%",
                    n: res.reviews, m: res.cards,
                }));
                if (better) {
                    s.fsrsWeights = res.weights;
                    await save();
                    new Notice(t("New FSRS parameters applied."));
                } else {
                    new Notice(t("Your current parameters already fit your reviews best."));
                }
            } catch (e) {
                status.setText((e as Error).message);
            } finally {
                this.optimizing = false;
                b.setDisabled(false).setButtonText(t("Optimize"));
            }
        }));
        if (custom) {
            opt.addButton(b => b.setButtonText(t("Use defaults")).onClick(async () => {
                s.fsrsWeights = [];
                await save();
                this.display();
            }));
            const w = containerEl.createEl("details", { cls: "nlm-weights" });
            w.createEl("summary", { text: t("Current parameters") });
            w.createEl("code", { text: s.fsrsWeights.join(", ") });
            w.createDiv({ cls: "setting-item-description", text: t("Defaults: {w}", { w: default_w.join(", ") }) });
        }
    }
}

function numberSetting(
    el: HTMLElement, name: string, desc: string, value: number, min: number, max: number,
    onChange: (v: number) => Promise<void>,
) {
    new Setting(el).setName(name).setDesc(desc).addText(c => {
        c.inputEl.type = "number";
        c.setValue(String(value)).onChange(async raw => {
            const v = Number(raw);
            if (Number.isFinite(v) && v >= min && v <= max) await onChange(Math.round(v));
        });
    });
}
