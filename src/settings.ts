import { App, PluginSettingTab, Setting } from "obsidian";
import NotebookLMImporter from "./main";

export interface NotebookLMImporterSettings {
    outputFolder: string;
    deckPrefix: string;
    cardSeparator: string;
    openAfterImport: boolean;
}

export const DEFAULT_SETTINGS: NotebookLMImporterSettings = {
    outputFolder: "Flashcards",
    deckPrefix: "flashcards",
    cardSeparator: "::",
    openAfterImport: true,
};

export class NotebookLMImporterSettingTab extends PluginSettingTab {
    plugin: NotebookLMImporter;

    constructor(app: App, plugin: NotebookLMImporter) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "NotebookLM CSV Importer Settings" });

        new Setting(containerEl)
            .setName("Output folder")
            .setDesc("The folder where imported flashcards will be saved.")
            .addText((text) =>
                text
                    .setPlaceholder("Flashcards")
                    .setValue(this.plugin.settings.outputFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.outputFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Deck prefix")
            .setDesc("The tag prefix for the flashcard deck (e.g. #flashcards/deck-name).")
            .addText((text) =>
                text
                    .setPlaceholder("flashcards")
                    .setValue(this.plugin.settings.deckPrefix)
                    .onChange(async (value) => {
                        this.plugin.settings.deckPrefix = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Card separator")
            .setDesc("The separator used between question and answer (standard is ::).")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("::", "Single-line (::)")
                    .addOption(":::", "Bidirectional (:::)")
                    .addOption("?", "Multi-line (?)")
                    .addOption("??", "Bidirectional Multi-line (??)")
                    .setValue(this.plugin.settings.cardSeparator)
                    .onChange(async (value) => {
                        this.plugin.settings.cardSeparator = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Open after import")
            .setDesc("Automatically open the generated file after import.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.openAfterImport)
                    .onChange(async (value) => {
                        this.plugin.settings.openAfterImport = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
