import { App, TFile, TFolder, normalizePath } from "obsidian";
import { safeFileName } from "./ids";
import { region, replaceRegion, serializeCallouts } from "./callouts";
import {
    BLOCK_LANG, NoteOptions, buildFlashcardsNote, buildMediaNote, buildMindMapNote, buildQuizNote, carryOverIds,
    findBlock, replaceBlock, touchSynced,
} from "./notes";
import { convertLegacyContent, parseStudyContent } from "./study-content";
import { toOutline, toCanvas } from "./mindmap";
import type { DeckIndex } from "./srs/deck-index";
import type { NotebookLMStudySettings } from "./settings";
import { MediaType, NoteOrigin, ParsedContent } from "./types";

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

    /**
     * Save an audio overview / report / infographic / slide deck. The file goes
     * next to the note (or into the attachments folder) and the note embeds it.
     * NotebookLM artifacts never change, so an already imported one is returned as is.
     */
    async writeMedia(req: { type: MediaType; title: string; origin: NoteOrigin; data: ArrayBuffer; ext: string }): Promise<WriteResult> {
        const existing = req.origin.artifactId
            && this.index.list(req.type).find(d => d.artifactId === req.origin.artifactId);
        const existingFile = existing && this.app.vault.getAbstractFileByPath(existing.path);
        if (existingFile instanceof TFile) return { file: existingFile, created: false, count: 1 };

        const folder = this.folderFor(req.origin);
        await this.ensureFolder(folder);
        const base = safeFileName(req.title);
        const opts: NoteOptions = { title: req.title, deck: req.origin.notebookTitle ?? req.title, origin: req.origin };

        let body: string;
        if (req.type === "report") {
            body = buildMediaNote("report", opts, null, new TextDecoder("utf-8").decode(req.data));
        } else {
            const mediaFolder = this.settings.attachmentsFolder
                ? normalizePath(this.settings.attachmentsFolder)
                : folder;
            await this.ensureFolder(mediaFolder);
            const mediaPath = this.uniquePath(mediaFolder, base, req.ext);
            await this.app.vault.createBinary(mediaPath, req.data);
            body = buildMediaNote(req.type, opts, mediaPath);
        }
        const file = await this.app.vault.create(this.uniquePath(folder, base, "md"), body);
        return { file, created: true, count: 1 };
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
        if (content.type === "mindmap") {
            const body = toOutline(content.root);
            await this.app.vault.process(file, data =>
                replaceBlock(data, "mindmap", body) ?? `${data.trimEnd()}\n\n\`\`\`${BLOCK_LANG.mindmap}\n${body}\n\`\`\`\n`
            );
            if (this.settings.mindmapCanvas) {
                await this.writeCanvas(file.path.replace(/\.md$/, ".canvas"), toCanvas(content.root));
            }
            return;
        }

        await this.app.vault.process(file, data => {
            const old = parseStudyContent(data);
            const body = content.type === "flashcards"
                ? serializeCallouts({ cards: carryOverIds(content.cards, old.cards, c => c.front) })
                : serializeCallouts({ questions: carryOverIds(content.questions, old.questions, q => q.question) });
            return touchSynced(replaceManaged(data, body));
        });
    }

    /** Rewrite a note that still uses the 2.0.0 code-block format as callouts. Returns false if there was nothing to convert. */
    async convertLegacy(file: TFile): Promise<boolean> {
        let changed = false;
        await this.app.vault.process(file, data => {
            const converted = convertLegacyContent(data);
            changed = converted !== null;
            return converted ?? data;
        });
        return changed;
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

/** Swap the synced region (or a 2.0.0 code block) for new callouts; append a region if there is neither. */
function replaceManaged(data: string, body: string): string {
    const replaced = replaceRegion(data, body);
    if (replaced !== null) return replaced;
    for (const lang of [BLOCK_LANG.flashcards, BLOCK_LANG.quiz]) {
        const block = findBlock(data, lang);
        if (block) return data.slice(0, block.start) + region(body) + data.slice(block.end);
    }
    return `${data.trimEnd()}\n\n${region(body)}\n`;
}

