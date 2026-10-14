import { App, Modal, Notice, Setting } from "obsidian";
import type NotebookLMStudy from "../main";
import { parseCSV } from "../parsers/csv";
import { parseJSON } from "../parsers/json";
import { parseOutline } from "../mindmap";
import { ParsedContent } from "../types";

/** Import a CSV / JSON / Markdown-outline export from disk. Works on mobile too. */
export class ImportModal extends Modal {
    private title = "";
    private deck = "";
    private parsed: ParsedContent | null = null;
    private error = "";

    constructor(app: App, private plugin: NotebookLMStudy) {
        super(app);
    }

    onOpen() {
        this.setTitle("Import NotebookLM export");
        this.render();
    }

    onClose() {
        this.contentEl.empty();
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("p", {
            cls: "setting-item-description",
            text: "Flashcards or quizzes as CSV or JSON, or a mind map as JSON or a Markdown outline.",
        });

        new Setting(contentEl)
            .setName("File")
            .addButton(b => b.setButtonText(this.parsed ? "Choose another file" : "Choose file").setCta().onClick(() => this.pick()));

        if (this.error) contentEl.createDiv({ cls: "nlm-error", text: this.error });
        if (!this.parsed) return;

        new Setting(contentEl)
            .setName("Title")
            .setDesc("Note name.")
            .addText(t => t.setValue(this.title).onChange(v => (this.title = v.trim())));

        if (this.parsed.type !== "mindmap") {
            new Setting(contentEl)
                .setName("Deck")
                .setDesc("Groups notes in the study dashboard.")
                .addText(t => t.setPlaceholder(this.title).setValue(this.deck).onChange(v => (this.deck = v.trim())));
        }

        this.renderPreview(contentEl, this.parsed);

        new Setting(contentEl).addButton(b => b.setButtonText("Import").setCta().onClick(() => void this.import()));
    }

    private renderPreview(el: HTMLElement, p: ParsedContent) {
        const box = el.createDiv({ cls: "nlm-preview" });
        if (p.type === "flashcards") {
            box.createEl("strong", { text: `${p.cards.length} flashcards` });
            const ul = box.createEl("ul");
            p.cards.slice(0, 5).forEach(c => {
                const li = ul.createEl("li");
                li.createEl("b", { text: truncate(c.front, 80) });
                li.appendText(` → ${truncate(c.back, 60)}`);
            });
        } else if (p.type === "quiz") {
            box.createEl("strong", { text: `${p.questions.length} quiz questions` });
            const ul = box.createEl("ul");
            p.questions.slice(0, 5).forEach(q => ul.createEl("li", { text: `${truncate(q.question, 80)} (${q.options.length} options)` }));
        } else {
            box.createEl("strong", { text: `Mind map: ${p.root.name}` });
            const ul = box.createEl("ul");
            p.root.children.slice(0, 8).forEach(c => ul.createEl("li", { text: c.name }));
        }
    }

    private pick() {
        const input = createEl("input", { type: "file", attr: { accept: ".csv,.json,.md,.txt" } });
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const name = file.name.replace(/\.[^/.]+$/, "");
            const text = await file.text();
            try {
                this.parsed = parseFile(file.name, text, name);
                this.error = "";
                this.title = this.parsed.title || name;
                const empty = this.parsed.type === "flashcards" ? !this.parsed.cards.length
                    : this.parsed.type === "quiz" ? !this.parsed.questions.length : false;
                if (empty) {
                    this.error = "No items found in this file. Check that it's a NotebookLM export.";
                    this.parsed = null;
                }
            } catch (e) {
                this.parsed = null;
                this.error = (e as Error).message;
            }
            this.render();
        };
        input.click();
    }

    private async import() {
        if (!this.parsed) return;
        if (!this.title) { new Notice("Enter a title."); return; }
        try {
            const res = await this.plugin.writer.write({
                content: this.parsed,
                title: this.title,
                deck: this.deck || undefined,
                origin: { source: "file" },
            });
            new Notice(`${res.created ? "Imported" : "Updated"} ${res.file.basename}.`);
            this.close();
            if (this.plugin.settings.openAfterImport) await this.app.workspace.getLeaf(false).openFile(res.file);
        } catch (e) {
            console.error("NotebookLM study: import failed", e);
            new Notice(`Import failed: ${(e as Error).message}`);
        }
    }
}

export function parseFile(fileName: string, text: string, fallbackTitle: string): ParsedContent {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext === "json") return parseJSON(text);
    if (ext === "md" || ext === "txt") {
        const root = parseOutline(text.replace(/^---[\s\S]*?---\s*/, ""), fallbackTitle);
        if (!root.children.length) throw new Error("No nested list found in this file.");
        return { type: "mindmap", title: root.name, root };
    }
    return parseCSV(text);
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
