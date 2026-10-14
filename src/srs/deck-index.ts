import { App, Events, TAbstractFile, TFile } from "obsidian";
import { parseStudyContent } from "../study-content";
import { ContentType, StudyItem } from "../types";

export interface DeckInfo {
    path: string;
    type: ContentType;
    deck: string;
    title: string;
    notebookId?: string;
    notebookTitle?: string;
    artifactId?: string;
    synced?: string;
    items: StudyItem[];
}

const TYPES: ContentType[] = ["flashcards", "quiz", "mindmap"];

/**
 * In-memory list of every note that holds study material: notes created by
 * the plugin (frontmatter `nlm-type`) and any note with flashcard / quiz
 * callouts written by hand. Emits "changed" when that set changes and
 * "reviewed" (triggered by the study view) after each answer.
 */
export class DeckIndex extends Events {
    decks = new Map<string, DeckInfo>();
    ready = false;

    constructor(private app: App) {
        super();
    }

    async rebuild() {
        this.decks.clear();
        for (const file of this.app.vault.getMarkdownFiles()) {
            await this.indexFile(file, false);
        }
        this.ready = true;
        this.trigger("changed");
    }

    async indexFile(file: TFile, notify = true) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        const fmType = fm?.["nlm-type"] as ContentType | undefined;
        const declared = fmType && TYPES.includes(fmType) ? fmType : undefined;
        const hasCallouts = cache?.sections?.some(s => s.type === "callout") ?? false;

        if (!declared && !hasCallouts) {
            this.drop(file.path, notify);
            return;
        }

        const content = await this.app.vault.cachedRead(file);
        const deck = String(fm?.["nlm-deck"] ?? file.basename);
        const items: StudyItem[] = [];

        if (declared !== "mindmap") {
            const parsed = parseStudyContent(content);
            const seen = new Set<string>();
            for (const card of parsed.cards) {
                if (seen.has(card.id!)) continue;
                seen.add(card.id!);
                items.push({ kind: "flashcard", id: card.id!, path: file.path, deck, line: card.line, card });
            }
            for (const question of parsed.questions) {
                if (seen.has(question.id!)) continue;
                seen.add(question.id!);
                items.push({ kind: "quiz", id: question.id!, path: file.path, deck, line: question.line, question });
            }
        }

        if (!declared && !items.length) {
            this.drop(file.path, notify);
            return;
        }

        const type: ContentType = declared
            ?? (items.some(i => i.kind === "flashcard") ? "flashcards" : "quiz");

        this.decks.set(file.path, {
            path: file.path,
            type,
            deck,
            title: file.basename,
            notebookId: fm?.["nlm-notebook"],
            notebookTitle: fm?.["nlm-notebook-title"],
            artifactId: fm?.["nlm-artifact"],
            synced: fm?.["nlm-synced"],
            items,
        });
        if (notify) this.trigger("changed");
    }

    private drop(path: string, notify: boolean) {
        if (this.decks.delete(path) && notify) this.trigger("changed");
    }

    remove(file: TAbstractFile) {
        this.drop(file.path, true);
    }

    rename(file: TAbstractFile, oldPath: string) {
        this.decks.delete(oldPath);
        if (file instanceof TFile && file.extension === "md") void this.indexFile(file);
        else this.trigger("changed");
    }

    list(type?: ContentType): DeckInfo[] {
        const all = [...this.decks.values()];
        return (type ? all.filter(d => d.type === type) : all).sort((a, b) => a.deck.localeCompare(b.deck) || a.title.localeCompare(b.title));
    }

    items(filter?: (d: DeckInfo) => boolean): StudyItem[] {
        const out: StudyItem[] = [];
        for (const d of this.decks.values()) {
            if (!filter || filter(d)) out.push(...d.items);
        }
        return out;
    }
}
