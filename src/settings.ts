import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type NotebookLMStudy from "./main";
import { NlmCli } from "./nlm-cli";

export interface NotebookLMStudySettings {
    rootFolder: string;
    folderPerNotebook: boolean;
    openAfterImport: boolean;

    nlmPath: string;
    nlmProfile: string;

    mindmapCanvas: boolean;
    mindmapOutline: boolean;

    includeQuizInReview: boolean;
    newPerDay: number;
    maxReviewsPerDay: number;
    desiredRetention: number;
    maximumInterval: number;
    enableFuzz: boolean;
    dayStartHour: number;
}

export const DEFAULT_SETTINGS: NotebookLMStudySettings = {
    rootFolder: "NotebookLM",
    folderPerNotebook: true,
    openAfterImport: true,

    nlmPath: "",
    nlmProfile: "",

    mindmapCanvas: true,
    mindmapOutline: true,

    includeQuizInReview: true,
    newPerDay: 20,
    maxReviewsPerDay: 200,
    desiredRetention: 0.9,
    maximumInterval: 36500,
    enableFuzz: true,
    dayStartHour: 4,
};

export class NotebookLMStudySettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: NotebookLMStudy) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        const s = this.plugin.settings;
        const save = () => this.plugin.saveSettings();
        containerEl.empty();

        new Setting(containerEl).setName("Notes").setHeading();

        new Setting(containerEl)
            .setName("Root folder")
            .setDesc("Where imported flashcards, quizzes and mind maps are saved.")
            .addText(t => t.setPlaceholder("NotebookLM").setValue(s.rootFolder).onChange(async v => {
                s.rootFolder = v.trim().replace(/\/+$/, "");
                await save();
            }));

        new Setting(containerEl)
            .setName("One folder per notebook")
            .setDesc("Create a sub-folder named after each NotebookLM notebook.")
            .addToggle(t => t.setValue(s.folderPerNotebook).onChange(async v => {
                s.folderPerNotebook = v;
                await save();
            }));

        new Setting(containerEl)
            .setName("Open after import")
            .addToggle(t => t.setValue(s.openAfterImport).onChange(async v => {
                s.openAfterImport = v;
                await save();
            }));

        new Setting(containerEl).setName("Mind maps").setHeading();

        new Setting(containerEl)
            .setName("Create canvas")
            .setDesc("Also generate an Obsidian Canvas file laid out as a tree.")
            .addToggle(t => t.setValue(s.mindmapCanvas).onChange(async v => {
                s.mindmapCanvas = v;
                await save();
            }));

        new Setting(containerEl)
            .setName("Include outline")
            .setDesc("Add the mind map as a plain nested list (works with the Markmap plugin).")
            .addToggle(t => t.setValue(s.mindmapOutline).onChange(async v => {
                s.mindmapOutline = v;
                await save();
            }));

        if (Platform.isDesktopApp) {
            new Setting(containerEl).setName("NotebookLM sync (nlm CLI)").setHeading();

            new Setting(containerEl)
                .setName("nlm executable")
                .setDesc("Path to the nlm CLI from notebooklm-mcp-cli. Leave empty to auto-detect.")
                .addText(t => t.setPlaceholder(NlmCli.detectBinary()).setValue(s.nlmPath).onChange(async v => {
                    s.nlmPath = v.trim();
                    await save();
                }))
                .addButton(b => b.setButtonText("Test").onClick(async () => {
                    try {
                        const v = await this.plugin.nlm().version();
                        new Notice(`Found ${v}`);
                    } catch (e) {
                        new Notice((e as Error).message, 8000);
                    }
                }));

            new Setting(containerEl)
                .setName("Profile")
                .setDesc("nlm login profile to use. Leave empty for the default.")
                .addText(t => t.setValue(s.nlmProfile).onChange(async v => {
                    s.nlmProfile = v.trim();
                    await save();
                }));
        }

        new Setting(containerEl).setName("Spaced repetition (FSRS)").setHeading();

        new Setting(containerEl)
            .setName("Review quiz questions")
            .setDesc("Include quiz questions in spaced-repetition sessions, alongside flashcards.")
            .addToggle(t => t.setValue(s.includeQuizInReview).onChange(async v => {
                s.includeQuizInReview = v;
                await save();
            }));

        numberSetting(containerEl, "New cards per day", "Maximum number of new cards introduced each day.",
            s.newPerDay, 0, 9999, async v => { s.newPerDay = v; await save(); });

        numberSetting(containerEl, "Maximum reviews per day", "Cap on review cards shown each day.",
            s.maxReviewsPerDay, 0, 99999, async v => { s.maxReviewsPerDay = v; await save(); });

        new Setting(containerEl)
            .setName("Desired retention")
            .setDesc("Probability of recall FSRS aims for. Higher means more reviews.")
            .addSlider(sl => sl.setLimits(0.7, 0.98, 0.01).setValue(s.desiredRetention).setDynamicTooltip()
                .onChange(async v => { s.desiredRetention = v; await save(); }));

        numberSetting(containerEl, "Maximum interval (days)", "Longest interval a card can be scheduled.",
            s.maximumInterval, 1, 36500, async v => { s.maximumInterval = v; await save(); });

        new Setting(containerEl)
            .setName("Interval fuzz")
            .setDesc("Randomize intervals slightly so cards learned together don't stay together.")
            .addToggle(t => t.setValue(s.enableFuzz).onChange(async v => {
                s.enableFuzz = v;
                await save();
            }));

        numberSetting(containerEl, "Next day starts at (hour)", "Reviews done before this hour count for the previous day.",
            s.dayStartHour, 0, 23, async v => { s.dayStartHour = v; await save(); });

        new Setting(containerEl).setName("Data").setHeading();

        new Setting(containerEl)
            .setName("Reset all review progress")
            .setDesc("Forget scheduling and history for every card. Notes are not touched.")
            .addButton(b => b.setButtonText("Reset").setWarning().onClick(async () => {
                if (!confirm("Delete all review history? This cannot be undone.")) return;
                this.plugin.srs.cards = {};
                this.plugin.srs.log = [];
                await this.plugin.saveSettings();
                this.plugin.index.trigger("changed");
                new Notice("Review progress reset.");
            }));
    }
}

function numberSetting(
    el: HTMLElement, name: string, desc: string, value: number, min: number, max: number,
    onChange: (v: number) => Promise<void>,
) {
    new Setting(el).setName(name).setDesc(desc).addText(t => {
        t.inputEl.type = "number";
        t.setValue(String(value)).onChange(async raw => {
            const v = Number(raw);
            if (Number.isFinite(v) && v >= min && v <= max) await onChange(Math.round(v));
        });
    });
}
