import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import NotebookLMImporter from "./main";
import { Flashcard, parseCSV } from "./csv-parser";
import { convertToMarkdown } from "./converter";

export class ImportModal extends Modal {
    plugin: NotebookLMImporter;
    deckName: string = "";
    csvContent: string = "";
    flashcards: Flashcard[] = [];
    fileName: string = "";

    constructor(app: App, plugin: NotebookLMImporter) {
        super(app, plugin);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle("Import NotebookLM Flashcards");

        contentEl.createEl("p", { 
            text: "Select a CSV file exported from NotebookLM to convert it to Obsidian Spaced Repetition format." 
        });

        const deckSetting = new Setting(contentEl)
            .setName("Deck name")
            .setDesc("The name of the deck (used for the tag and filename).")
            .addText((text) =>
                text
                    .setPlaceholder("e.g. History")
                    .setValue(this.deckName)
                    .onChange((value) => {
                        this.deckName = value;
                    })
            );

        const fileSetting = new Setting(contentEl)
            .setName("CSV file")
            .setDesc("Choose the CSV file to import.")
            .addButton((button) =>
                button
                    .setButtonText("Select CSV")
                    .onClick(() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = ".csv";
                        input.onchange = async (e) => {
                            const file = (e.target as HTMLInputElement).files?.[0];
                            if (file) {
                                this.fileName = file.name.replace(/\.[^/.]+$/, "");
                                if (!this.deckName) {
                                    this.deckName = this.fileName;
                                    deckSetting.components[0].setDisabled(false);
                                    (deckSetting.components[0] as any).setValue(this.deckName);
                                }
                                
                                this.csvContent = await file.text();
                                this.flashcards = parseCSV(this.csvContent);
                                this.updatePreview(contentEl);
                            }
                        };
                        input.click();
                    })
            );

        this.updatePreview(contentEl);
    }

    updatePreview(contentEl: HTMLElement) {
        // Remove old preview if exists
        const oldPreview = contentEl.querySelector(".notebooklm-importer-preview");
        if (oldPreview) oldPreview.remove();
        const oldImportBtn = contentEl.querySelector(".notebooklm-import-btn");
        if (oldImportBtn) oldImportBtn.remove();

        if (this.flashcards.length > 0) {
            const previewEl = contentEl.createDiv({ cls: "notebooklm-importer-preview" });
            previewEl.createEl("strong", { text: `Detected ${this.flashcards.length} flashcards.` });
            
            if (this.flashcards.length > 0) {
                const list = previewEl.createEl("ul", { attr: { style: "max-height: 150px; overflow-y: auto; font-size: 0.8em; margin-top: 10px;" } });
                this.flashcards.slice(0, 5).forEach(card => {
                    const li = list.createEl("li");
                    li.createEl("span", { text: card.question, attr: { style: "font-weight: bold;" } });
                    li.createSpan({ text: " -> " });
                    li.createSpan({ text: card.answer.substring(0, 50) + (card.answer.length > 50 ? "..." : "") });
                });
                if (this.flashcards.length > 5) {
                    list.createEl("li", { text: "...", attr: { style: "list-style: none;" } });
                }
            }

            const importBtnSetting = new Setting(contentEl)
                .setClass("notebooklm-import-btn")
                .addButton((button) =>
                    button
                        .setButtonText("Import Flashcards")
                        .setCta()
                        .onClick(() => this.handleImport())
                );
        } else if (this.csvContent) {
            const errorEl = contentEl.createDiv({ cls: "notebooklm-importer-preview notebooklm-importer-error" });
            errorEl.createEl("span", { text: "No flashcards detected in the file. Please check the format." });
        }
    }

    async handleImport() {
        if (!this.deckName) {
            new Notice("Please enter a deck name.");
            return;
        }

        if (this.flashcards.length === 0) {
            new Notice("No flashcards to import.");
            return;
        }

        const markdown = convertToMarkdown(
            this.flashcards,
            this.deckName,
            this.plugin.settings.cardSeparator,
            this.plugin.settings.deckPrefix
        );

        const folderPath = this.plugin.settings.outputFolder;
        const fileName = `${this.deckName}.md`;
        const filePath = folderPath ? `${folderPath}/${fileName}` : fileName;

        try {
            // Ensure folder exists
            if (folderPath) {
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folder) {
                    await this.app.vault.createFolder(folderPath);
                } else if (!(folder instanceof TFolder)) {
                    new Notice(`Error: ${folderPath} is not a folder.`);
                    return;
                }
            }

            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            let file;
            if (existingFile) {
                // If exists, overwrite (or could append, but overwrite is cleaner for a fresh import)
                await this.app.vault.modify(existingFile as any, markdown);
                file = existingFile;
                new Notice(`Updated ${fileName} with ${this.flashcards.length} cards.`);
            } else {
                file = await this.app.vault.create(filePath, markdown);
                new Notice(`Imported ${this.flashcards.length} cards to ${fileName}.`);
            }

            if (this.plugin.settings.openAfterImport && file) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(file as any);
            }

            this.close();
        } catch (err) {
            console.error("Import failed", err);
            new Notice(`Import failed: ${err.message}`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
