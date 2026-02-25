import { Plugin, Notice } from "obsidian";
import { NotebookLMImporterSettings, DEFAULT_SETTINGS, NotebookLMImporterSettingTab } from "./settings";
import { ImportModal } from "./import-modal";

export default class NotebookLMImporter extends Plugin {
    settings: NotebookLMImporterSettings;

    async onload() {
        console.log("Loading NotebookLM CSV Importer plugin");

        await this.loadSettings();

        // Add ribbon icon
        this.addRibbonIcon("lucide-upload", "Import NotebookLM Flashcards", () => {
            new ImportModal(this.app, this).open();
        });

        // Add command to command palette
        this.addCommand({
            id: "import-notebooklm-flashcards",
            name: "Import Flashcards from CSV",
            callback: () => {
                new ImportModal(this.app, this).open();
            },
        });

        // Add settings tab
        this.addSettingTab(new NotebookLMImporterSettingTab(this.app, this));
    }

    onunload() {
        console.log("Unloading NotebookLM CSV Importer plugin");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
