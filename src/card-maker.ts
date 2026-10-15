import { TFile, normalizePath } from "obsidian";
import { clozeCallout, flashcardCallout } from "./callouts";
import { t } from "./i18n";
import { safeFileName } from "./ids";
import type NotebookLMStudy from "./main";

export type CardKind = "basic" | "reverse" | "cloze";

/** Where a card's text came from: a note, or a PDF page. */
export interface CardSource {
    file: TFile;
    page?: number;
}

export interface CardDraft {
    kind: CardKind;
    /** Question (basic / reverse) or the text with {{hidden}} parts (cloze). */
    front: string;
    /** Answer. Unused for cloze. */
    back: string;
    source?: CardSource;
}

export function pageOf(sel: Selection | null | undefined): number | undefined {
    const node = sel?.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    // Obsidian's viewer (pdf.js) marks pages with data-page-number; some PDF plugins use data-page.
    const pageEl = el?.closest<HTMLElement>("[data-page-number], [data-page]");
    const page = Number(pageEl?.dataset.pageNumber ?? pageEl?.dataset.page);
    return page > 0 ? page : undefined;
}

/** PDF selections come with hard line breaks and hyphenation from the layout. */
export function tidySelection(text: string): string {
    return text
        .replace(/(\w)-\n(\w)/g, "$1$2")
        .replace(/[ \t]*\n[ \t]*(?!\n)/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

/**
 * Saves hand-made cards. Cards from a PDF or note go to a companion note next
 * to it ("Lecture 3 - cards.md"), so they stay with the course material and
 * link back to the exact page.
 */
export class CardMaker {
    constructor(private plugin: NotebookLMStudy) {}

    notePath(source?: CardSource): string {
        if (!source) return normalizePath(`${this.plugin.settings.rootFolder || ""}/${t("My cards")}.md`);
        const dir = source.file.parent && !source.file.parent.isRoot() ? `${source.file.parent.path}/` : "";
        return normalizePath(`${dir}${safeFileName(t("{name} - cards", { name: source.file.basename }))}.md`);
    }

    /** Cards already saved for this source. */
    count(source?: CardSource): number {
        return this.plugin.index.decks.get(this.notePath(source))?.items.length ?? 0;
    }

    async add(draft: CardDraft): Promise<TFile> {
        const { app } = this.plugin;
        const path = this.notePath(draft.source);
        const link = draft.source ? this.sourceLink(draft.source, path) : "";

        let callout: string;
        if (draft.kind === "cloze") {
            callout = clozeCallout({ title: "", text: [draft.front.trim(), link].filter(Boolean).join("\n\n") });
        } else {
            callout = flashcardCallout({
                front: draft.front,
                back: [draft.back.trim(), link].filter(Boolean).join("\n\n"),
                reverse: draft.kind === "reverse",
            });
        }

        let file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) file = await this.create(path, draft.source);
        const note = file as TFile;
        await app.vault.process(note, text => `${text.replace(/\s*$/, "")}\n\n${callout}\n`);
        return note;
    }

    private async create(path: string, source?: CardSource): Promise<TFile> {
        const { app } = this.plugin;
        const folder = path.split("/").slice(0, -1).join("/");
        if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
        const title = path.split("/").pop()!.replace(/\.md$/, "");
        const file = await app.vault.create(path, `# ${title}\n`);
        const notebook = source ? this.notebookOf(source.file) : undefined;
        await app.fileManager.processFrontMatter(file, fm => {
            fm["nlm-type"] = "flashcards";
            fm["nlm-deck"] = notebook?.title ?? this.deckFor(source?.file);
            if (notebook) {
                fm["nlm-notebook"] = notebook.id;
                fm["nlm-notebook-title"] = notebook.title;
            }
            if (source) fm["nlm-sources"] = [app.fileManager.generateMarkdownLink(source.file, path)];
            fm["nlm-source"] = "manual";
            fm.tags = ["nlm/flashcards"];
        });
        return file;
    }

    private sourceLink(source: CardSource, from: string): string {
        const label = source.page ? t("{name}, p. {page}", { name: source.file.basename, page: source.page }) : source.file.basename;
        const subpath = source.page ? `#page=${source.page}` : "";
        return `${t("Source")}: ${this.plugin.app.fileManager.generateMarkdownLink(source.file, from, subpath, label)}`;
    }

    /** The NotebookLM notebook this file was uploaded to or generated from. */
    notebookOf(file: TFile): { id: string; title: string } | undefined {
        const { index, syncState } = this.plugin;
        const decks = index.list();
        const id = syncState.uploads[file.path]?.notebookId ?? index.decks.get(file.path)?.notebookId;
        if (id) {
            const deck = decks.find(d => d.notebookId === id && d.notebookTitle);
            return deck ? { id, title: deck.notebookTitle! } : undefined;
        }
        // A notebook named like a folder the file is in ("Aprendizaje Automático/…/x.pdf").
        for (let folder = file.parent; folder && !folder.isRoot(); folder = folder.parent) {
            const name = normalizeName(folder.name);
            const deck = decks.find(d => d.notebookId && d.notebookTitle && normalizeName(d.notebookTitle) === name);
            if (deck) return { id: deck.notebookId!, title: deck.notebookTitle! };
        }
        return undefined;
    }

    /** An existing deck named like a folder the file is in, else the folder's name. */
    private deckFor(file?: TFile): string {
        if (!file) return t("My cards");
        const decks = new Set(this.plugin.index.list().map(d => d.deck));
        for (let folder = file.parent; folder && !folder.isRoot(); folder = folder.parent) {
            const name = normalizeName(folder.name);
            const match = [...decks].find(d => normalizeName(d) === name);
            if (match) return match;
        }
        return file.parent && !file.parent.isRoot() ? file.parent.name : file.basename;
    }
}

/** Case- and accent-insensitive name, to match folders to notebooks and decks. */
export function normalizeName(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
