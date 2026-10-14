import { contentId } from "./ids";
import { toOutline } from "./mindmap";
import { ContentType, Flashcard, MindMapNode, NoteOrigin, QuizQuestion } from "./types";

export const BLOCK_LANG: Record<ContentType, string> = {
    flashcards: "nlm-flashcards",
    quiz: "nlm-quiz",
    mindmap: "nlm-mindmap",
};

const ID_LINE = /^id:\s*([a-z]{2}-[a-z0-9]+)\s*$/i;

// --- Flashcards block -------------------------------------------------------
//
//   Q: front (may span lines)
//   A: back (may span lines)
//   id: fc-xxxxxxxx            <- optional, generated from content when missing
//
// A new "Q:" line starts the next card.

export function serializeFlashcards(cards: Flashcard[]): string {
    return cards
        .map(c => {
            const id = c.id ?? flashcardId(c);
            return `Q: ${c.front.trim()}\nA: ${c.back.trim()}\nid: ${id}`;
        })
        .join("\n\n");
}

export function parseFlashcards(source: string): Flashcard[] {
    const cards: Flashcard[] = [];
    let cur: { front: string[]; back: string[]; id?: string } | null = null;
    let field: "front" | "back" = "front";

    const flush = () => {
        if (!cur) return;
        const front = cur.front.join("\n").trim();
        const back = cur.back.join("\n").trim();
        if (front && back) cards.push({ front, back, id: cur.id ?? flashcardId({ front, back }) });
        cur = null;
    };

    for (const line of source.split(/\r?\n/)) {
        const idMatch = line.match(ID_LINE);
        if (idMatch && cur) {
            cur.id = idMatch[1];
            continue;
        }
        const q = line.match(/^Q:\s?(.*)$/);
        if (q) {
            flush();
            cur = { front: [q[1]], back: [] };
            field = "front";
            continue;
        }
        const a = line.match(/^A:\s?(.*)$/);
        if (a && cur) {
            cur.back.push(a[1]);
            field = "back";
            continue;
        }
        if (cur) cur[field].push(line);
    }
    flush();
    return cards;
}

export function flashcardId(c: Flashcard): string {
    return contentId("fc", c.front);
}

// --- Quiz block -------------------------------------------------------------
//
//   Q: question (may span lines)
//   - [ ] wrong option
//     > why it is wrong          <- optional rationale
//   - [x] correct option
//   hint: optional hint
//   id: qz-xxxxxxxx

export function serializeQuiz(questions: QuizQuestion[]): string {
    return questions
        .map(q => {
            const lines = [`Q: ${q.question.trim()}`];
            for (const o of q.options) {
                lines.push(`- [${o.correct ? "x" : " "}] ${oneLine(o.text)}`);
                if (o.rationale) lines.push(`  > ${oneLine(o.rationale)}`);
            }
            if (q.hint) lines.push(`hint: ${oneLine(q.hint)}`);
            lines.push(`id: ${q.id ?? quizId(q)}`);
            return lines.join("\n");
        })
        .join("\n\n");
}

export function parseQuiz(source: string): QuizQuestion[] {
    const questions: QuizQuestion[] = [];
    let cur: QuizQuestion | null = null;
    let inQuestion = false;

    const flush = () => {
        if (cur && cur.question.trim() && cur.options.length) {
            cur.question = cur.question.trim();
            if (!cur.id) cur.id = quizId(cur);
            questions.push(cur);
        }
        cur = null;
    };

    for (const line of source.split(/\r?\n/)) {
        const q = line.match(/^Q:\s?(.*)$/);
        if (q) {
            flush();
            cur = { question: q[1], options: [] };
            inQuestion = true;
            continue;
        }
        if (!cur) continue;
        const question: QuizQuestion = cur;

        const opt = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (opt) {
            question.options.push({ text: opt[2].trim(), correct: opt[1].toLowerCase() === "x" });
            inQuestion = false;
            continue;
        }
        const rationale = line.match(/^\s+>\s?(.*)$/);
        if (rationale && question.options.length) {
            const last = question.options[question.options.length - 1];
            last.rationale = last.rationale ? `${last.rationale} ${rationale[1]}` : rationale[1];
            continue;
        }
        const hint = line.match(/^hint:\s*(.*)$/i);
        if (hint) {
            question.hint = hint[1].trim();
            inQuestion = false;
            continue;
        }
        const id = line.match(ID_LINE);
        if (id) {
            question.id = id[1];
            continue;
        }
        if (inQuestion) question.question += `\n${line}`;
    }
    flush();
    return questions;
}

export function quizId(q: QuizQuestion): string {
    return contentId("qz", q.question);
}

function oneLine(s: string): string {
    return s.replace(/\s*\n\s*/g, " ").trim();
}

// --- Whole notes ------------------------------------------------------------

export interface NoteOptions {
    title: string;
    deck: string;
    origin: NoteOrigin;
    /** Only for mind maps: link to the generated canvas file. */
    canvasPath?: string;
    /** Only for mind maps: also include a plain nested list (Markmap-compatible). */
    includeOutline?: boolean;
}

function frontmatter(type: ContentType, opts: NoteOptions): string {
    const o = opts.origin;
    const lines = ["---", `nlm-type: ${type}`, `nlm-deck: ${yamlString(opts.deck)}`];
    if (o.notebookId) lines.push(`nlm-notebook: ${o.notebookId}`);
    if (o.notebookTitle) lines.push(`nlm-notebook-title: ${yamlString(o.notebookTitle)}`);
    if (o.artifactId) lines.push(`nlm-artifact: ${o.artifactId}`);
    lines.push(`nlm-source: ${o.source}`);
    lines.push(`nlm-synced: ${new Date().toISOString()}`);
    lines.push(`tags:`, `  - nlm/${type}`);
    if (type === "mindmap") lines.push(`markmap:`, `  initialExpandLevel: 2`);
    lines.push("---");
    return lines.join("\n");
}

function yamlString(s: string): string {
    return JSON.stringify(s);
}

function fence(lang: string, body: string): string {
    // Pick a fence longer than any backtick run inside the content.
    const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map(m => m.length));
    const ticks = "`".repeat(longest + 1);
    return `${ticks}${lang}\n${body}\n${ticks}`;
}

export function buildFlashcardsNote(cards: Flashcard[], opts: NoteOptions): string {
    return [
        frontmatter("flashcards", opts),
        "",
        `# ${opts.title}`,
        "",
        fence(BLOCK_LANG.flashcards, serializeFlashcards(cards)),
        "",
    ].join("\n");
}

export function buildQuizNote(questions: QuizQuestion[], opts: NoteOptions): string {
    return [
        frontmatter("quiz", opts),
        "",
        `# ${opts.title}`,
        "",
        fence(BLOCK_LANG.quiz, serializeQuiz(questions)),
        "",
    ].join("\n");
}

export function buildMindMapNote(root: MindMapNode, opts: NoteOptions): string {
    const parts = [
        frontmatter("mindmap", opts),
        "",
        `# ${opts.title}`,
        "",
        fence(BLOCK_LANG.mindmap, toOutline(root)),
        "",
    ];
    if (opts.canvasPath) parts.push(`Canvas: [[${opts.canvasPath}]]`, "");
    if (opts.includeOutline) parts.push("## Outline", "",toOutline(root), "");
    return parts.join("\n");
}

/** Find the body of the first fenced block with the given language. */
export function findBlock(content: string, lang: string): { start: number; end: number; body: string } | null {
    const re = new RegExp("^(`{3,}|~{3,})" + lang + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$", "m");
    const m = re.exec(content);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length, body: m[2] };
}

/**
 * Replace the managed block (and refresh nlm-synced) while keeping anything
 * the user wrote around it. Returns null when the note has no such block.
 */
export function replaceBlock(content: string, type: ContentType, body: string): string | null {
    const block = findBlock(content, BLOCK_LANG[type]);
    if (!block) return null;
    const updated = content.slice(0, block.start) + fence(BLOCK_LANG[type], body) + content.slice(block.end);
    return updated.replace(/^nlm-synced: .*$/m, `nlm-synced: ${new Date().toISOString()}`);
}

/**
 * Keep ids of items that already existed (matched by content) so review
 * history carries over even if the user had renamed an id by hand.
 */
export function carryOverIds<T extends { id?: string }>(fresh: T[], existing: T[], key: (t: T) => string): T[] {
    const byKey = new Map(existing.filter(e => e.id).map(e => [normalizeKey(key(e)), e.id as string]));
    return fresh.map(f => {
        const id = byKey.get(normalizeKey(key(f)));
        return id ? { ...f, id } : f;
    });
}

function normalizeKey(s: string): string {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
}
