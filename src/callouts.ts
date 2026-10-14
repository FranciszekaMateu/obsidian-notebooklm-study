import { flashcardId, quizId } from "./ids";
import { Flashcard, QuizQuestion } from "./types";

/*
 * Flashcards and quiz questions are stored as ordinary callouts, so notes read
 * well without the plugin and can be written by hand anywhere in the vault:
 *
 *   > [!flashcard|fc-1a2b3c4d5e]- What is a perceptron?
 *   > A single artificial neuron with a step activation.
 *
 *   > [!quiz|qz-9f8e7d6c5b]- Which algorithm trains an MLP?
 *   > - [ ] K-means
 *   >     - K-means is unsupervised clustering.
 *   > - [x] Backpropagation
 *   >
 *   > **Hint:** Errors flow backwards.
 *
 * The id lives in the callout metadata (after "|"), which Obsidian hides.
 * The "-" folds the callout so the answer stays hidden until opened.
 */

export const FLASHCARD_CALLOUT = "flashcard";
export const QUIZ_CALLOUT = "quiz";

export const REGION_START = "%% nlm:start — synced from NotebookLM; edits inside this region are replaced on update %%";
export const REGION_END = "%% nlm:end %%";

const CALLOUT_HEAD = /^>\s*\[!(flashcard|quiz)(?:\|([^\]]*))?\]([+-]?)[ \t]*(.*)$/i;
const ID_IN_META = /\b([a-z]{2}-[a-z0-9]{4,})\b/i;

export type Located<T> = T & { line: number };

export interface ParsedStudyContent {
    cards: Located<Flashcard>[];
    questions: Located<QuizQuestion>[];
}

// --- Serialize ----------------------------------------------------------------

function quote(text: string): string {
    return text.split("\n").map(l => (l.trim() ? `> ${l}` : ">")).join("\n");
}

function oneLine(s: string): string {
    return s.replace(/\s*\n\s*/g, " ").trim();
}

export function flashcardCallout(card: Flashcard): string {
    const id = card.id ?? flashcardId(card);
    return `> [!${FLASHCARD_CALLOUT}|${id}]- ${oneLine(card.front)}\n${quote(card.back.trim())}`;
}

export function quizCallout(q: QuizQuestion): string {
    const id = q.id ?? quizId(q);
    const lines = [`> [!${QUIZ_CALLOUT}|${id}]- ${oneLine(q.question)}`];
    for (const o of q.options) {
        lines.push(`> - [${o.correct ? "x" : " "}] ${oneLine(o.text)}`);
        if (o.rationale) lines.push(`>     - ${oneLine(o.rationale)}`);
    }
    if (q.hint) lines.push(">", `> **Hint:** ${oneLine(q.hint)}`);
    return lines.join("\n");
}

export function serializeCallouts(items: { cards?: Flashcard[]; questions?: QuizQuestion[] }): string {
    const blocks = [
        ...(items.cards ?? []).map(flashcardCallout),
        ...(items.questions ?? []).map(quizCallout),
    ];
    return blocks.join("\n\n");
}

/** Wrap content in the managed-region markers. */
export function region(body: string): string {
    return `${REGION_START}\n\n${body}\n\n${REGION_END}`;
}

// --- Parse --------------------------------------------------------------------

/** Find every flashcard / quiz callout in a note, skipping fenced code. */
export function parseCallouts(content: string): ParsedStudyContent {
    const out: ParsedStudyContent = { cards: [], questions: [] };
    const lines = content.split(/\r?\n/);
    let fence: string | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1];
            else if (line.trim().startsWith(fence)) fence = null;
            continue;
        }
        if (fence) continue;

        const head = line.match(CALLOUT_HEAD);
        if (!head) continue;

        const start = i;
        const body: string[] = [];
        while (i + 1 < lines.length && /^>/.test(lines[i + 1])) {
            i++;
            body.push(lines[i].replace(/^>\s?/, ""));
        }

        const type = head[1].toLowerCase();
        const id = head[2]?.match(ID_IN_META)?.[1];
        const title = head[4].trim();

        if (type === FLASHCARD_CALLOUT) {
            const back = body.join("\n").trim();
            if (title && back) {
                const card: Flashcard = { front: title, back };
                card.id = id ?? flashcardId(card);
                out.cards.push({ ...card, line: start });
            }
        } else {
            const q = parseQuizBody(title, body);
            if (q) {
                q.id = id ?? quizId(q);
                out.questions.push({ ...q, line: start });
            }
        }
    }
    return out;
}

function parseQuizBody(title: string, body: string[]): QuizQuestion | null {
    const q: QuizQuestion = { question: title, options: [] };
    const extra: string[] = [];

    for (const line of body) {
        const opt = line.match(/^\s{0,1}[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (opt) {
            q.options.push({ text: opt[2].trim(), correct: opt[1].toLowerCase() === "x" });
            continue;
        }
        const rationale = line.match(/^\s{2,}[-*+]\s+(.*)$/);
        if (rationale && q.options.length) {
            const last = q.options[q.options.length - 1];
            last.rationale = last.rationale ? `${last.rationale} ${rationale[1].trim()}` : rationale[1].trim();
            continue;
        }
        const hint = line.match(/^\s*(?:\*\*|__)?(?:hint|pista)\s*:\s*(?:\*\*|__)?\s*(.*)$/i);
        if (hint) {
            q.hint = hint[1].trim();
            continue;
        }
        if (!q.options.length && line.trim()) extra.push(line.trim());
    }

    if (extra.length) q.question = [q.question, ...extra].filter(Boolean).join("\n");
    if (!q.question.trim() || !q.options.length) return null;
    return q;
}

/**
 * Replace the managed region. Returns null if the note has none.
 */
export function replaceRegion(content: string, body: string): string | null {
    const start = content.indexOf("%% nlm:start");
    if (start < 0) return null;
    const endIdx = content.indexOf(REGION_END, start);
    if (endIdx < 0) return null;
    const end = endIdx + REGION_END.length;
    return content.slice(0, start) + region(body) + content.slice(end);
}
