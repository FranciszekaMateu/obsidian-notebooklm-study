import { App, Events, TAbstractFile, TFile } from "obsidian";
import { BLOCK_LANG, findBlock, parseFlashcards, parseQuiz } from "../notes";
import { ContentType, StudyItem } from "../types";

export interface DeckInfo {
    path: string;
    type: ContentType;
    deck: string;
    title: string;
    notebookId?: string;
    artifactId?: string;
    items: StudyItem[];
}

const TYPES: ContentType[] = ["flashcards", "quiz", "mindmap"];

/**
 * Keeps an in-memory list of every note whose frontmatter has `nlm-type`.
 * Emits "changed" whenever the set of decks or their items changes.
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
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const type = fm?.["nlm-type"] as ContentType | undefined;
        if (!type || !TYPES.includes(type)) {
            if (this.decks.delete(file.path) && notify) this.trigger("changed");
            return;
        }

        const content = await this.app.vault.cachedRead(file);
        const deck = String(fm?.["nlm-deck"] ?? file.basename);
        const info: DeckInfo = {
            path: file.path,
            type,
            deck,
            title: file.basename,
            notebookId: fm?.["nlm-notebook"],
            artifactId: fm?.["nlm-artifact"],
            items: [],
        };

        const block = findBlock(content, BLOCK_LANG[type]);
        if (block && type === "flashcards") {
            info.items = dedupe(parseFlashcards(block.body).map(card => ({
                kind: "flashcard" as const, id: card.id as string, path: file.path, deck, card,
            })));
        } else if (block && type === "quiz") {
            info.items = dedupe(parseQuiz(block.body).map(question => ({
                kind: "quiz" as const, id: question.id as string, path: file.path, deck, question,
            })));
        }

        this.decks.set(file.path, info);
        if (notify) this.trigger("changed");
    }

    remove(file: TAbstractFile) {
        if (this.decks.delete(file.path)) this.trigger("changed");
    }

    rename(file: TAbstractFile, oldPath: string) {
        const info = this.decks.get(oldPath);
        if (!info) return;
        this.decks.delete(oldPath);
        if (file instanceof TFile) void this.indexFile(file);
    }

    list(type?: ContentType): DeckInfo[] {
        const all = [...this.decks.values()];
        return (type ? all.filter(d => d.type === type) : all).sort((a, b) => a.deck.localeCompare(b.deck));
    }

    items(filter?: (d: DeckInfo) => boolean): StudyItem[] {
        const out: StudyItem[] = [];
        for (const d of this.decks.values()) {
            if (!filter || filter(d)) out.push(...d.items);
        }
        return out;
    }
}

/** Two identical cards in one note would share an id; keep the first. */
function dedupe<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}
