import { App, TFile, TFolder, normalizePath } from "obsidian";
import { safeFileName } from "./ids";
import {
    BLOCK_LANG, NoteOptions, buildFlashcardsNote, buildMindMapNote, buildQuizNote, carryOverIds,
    findBlock, parseFlashcards, parseQuiz, replaceBlock, serializeFlashcards, serializeQuiz,
} from "./notes";
import { toOutline, toCanvas } from "./mindmap";
import type { DeckIndex } from "./srs/deck-index";
import type { NotebookLMStudySettings } from "./settings";
import { NoteOrigin, ParsedContent } from "./types";

export interface WriteRequest {
    content: ParsedContent;
    title: string;
    /** Deck name shown in the study dashboard. Defaults to the notebook title, then the note title. */
    deck?: string;
    origin: NoteOrigin;
}

export interface WriteResult {
    file: TFile;
    created: boolean;
    count: number;
}

export class NoteWriter {
    constructor(private app: App, private settings: NotebookLMStudySettings, private index: DeckIndex) {}

    async write(req: WriteRequest): Promise<WriteResult> {
        const { content } = req;
        const count = content.type === "flashcards" ? content.cards.length
            : content.type === "quiz" ? content.questions.length : 1;

        const existing = this.findExisting(req);
        if (existing) {
            await this.update(existing, req);
            return { file: existing, created: false, count };
        }

        const folder = this.folderFor(req.origin);
        await this.ensureFolder(folder);
        const path = this.uniquePath(folder, safeFileName(req.title), "md");
        const opts: NoteOptions = {
            title: req.title,
            deck: req.deck ?? req.origin.notebookTitle ?? req.title,
            origin: req.origin,
        };

        let body: string;
        if (content.type === "flashcards") {
            body = buildFlashcardsNote(content.cards, opts);
        } else if (content.type === "quiz") {
            body = buildQuizNote(content.questions, opts);
        } else {
            opts.includeOutline = this.settings.mindmapOutline;
            if (this.settings.mindmapCanvas) {
                opts.canvasPath = await this.writeCanvas(path.replace(/\.md$/, ".canvas"), toCanvas(content.root));
            }
            body = buildMindMapNote(content.root, opts);
        }

        const file = await this.app.vault.create(path, body);
        return { file, created: true, count };
    }

    /** A note previously imported from the same artifact, or (for file imports) a note of the same type at the target path. */
    private findExisting(req: WriteRequest): TFile | null {
        const type = req.content.type;
        if (req.origin.artifactId) {
            const deck = this.index.list(type).find(d => d.artifactId === req.origin.artifactId);
            const file = deck && this.app.vault.getAbstractFileByPath(deck.path);
            if (file instanceof TFile) return file;
        }
        if (req.origin.source === "file") {
            const path = normalizePath(`${this.folderFor(req.origin)}/${safeFileName(req.title)}.md`);
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && this.index.decks.get(path)?.type === type) return file;
        }
        return null;
    }

    private async update(file: TFile, req: WriteRequest) {
        const { content } = req;
        await this.app.vault.process(file, data => {
            let body: string;
            if (content.type === "flashcards") {
                const old = findBlock(data, BLOCK_LANG.flashcards);
                const cards = old ? carryOverIds(content.cards, parseFlashcards(old.body), c => c.front) : content.cards;
                body = serializeFlashcards(cards);
            } else if (content.type === "quiz") {
                const old = findBlock(data, BLOCK_LANG.quiz);
                const qs = old ? carryOverIds(content.questions, parseQuiz(old.body), q => q.question) : content.questions;
                body = serializeQuiz(qs);
            } else {
                body = toOutline(content.root);
            }
            const replaced = replaceBlock(data, content.type, body);
            // The user deleted the managed block: put a fresh one at the end rather than lose the sync.
            return replaced ?? `${data.trimEnd()}\n\n\`\`\`${BLOCK_LANG[content.type]}\n${body}\n\`\`\`\n`;
        });

        if (content.type === "mindmap" && this.settings.mindmapCanvas) {
            await this.writeCanvas(file.path.replace(/\.md$/, ".canvas"), toCanvas(content.root));
        }
    }

    folderFor(origin: NoteOrigin): string {
        const parts = [this.settings.rootFolder];
        if (this.settings.folderPerNotebook && origin.notebookTitle) parts.push(safeFileName(origin.notebookTitle));
        return normalizePath(parts.filter(Boolean).join("/") || "/");
    }

    private async ensureFolder(path: string) {
        if (!path || path === "/") return;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFolder) return;
        if (existing) throw new Error(`${path} exists and is not a folder`);
        await this.app.vault.createFolder(path);
    }

    private uniquePath(folder: string, base: string, ext: string): string {
        const prefix = folder && folder !== "/" ? `${folder}/` : "";
        let path = normalizePath(`${prefix}${base}.${ext}`);
        for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
            path = normalizePath(`${prefix}${base} (${i}).${ext}`);
        }
        return path;
    }

    private async writeCanvas(path: string, json: string): Promise<string> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await this.app.vault.modify(existing, json);
        else await this.app.vault.create(path, json);
        return path;
    }
}
