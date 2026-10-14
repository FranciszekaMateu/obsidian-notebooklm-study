import { Located, ParsedStudyContent, parseCallouts, region, serializeCallouts } from "./callouts";
import { BLOCK_LANG, findBlock, parseFlashcards, parseQuiz } from "./notes";

/**
 * Everything studyable in a note: callouts anywhere in it, plus the
 * code-block format written by 2.0.0 (still read so older notes keep working).
 */
export function parseStudyContent(content: string): ParsedStudyContent {
    const out = parseCallouts(content);

    const cardsBlock = findBlock(content, BLOCK_LANG.flashcards);
    if (cardsBlock) {
        const line = lineOf(content, cardsBlock.start);
        out.cards.push(...parseFlashcards(cardsBlock.body).map(c => ({ ...c, line }) as Located<typeof c>));
    }
    const quizBlock = findBlock(content, BLOCK_LANG.quiz);
    if (quizBlock) {
        const line = lineOf(content, quizBlock.start);
        out.questions.push(...parseQuiz(quizBlock.body).map(q => ({ ...q, line }) as Located<typeof q>));
    }
    return out;
}

export function hasLegacyBlocks(content: string): boolean {
    return !!(findBlock(content, BLOCK_LANG.flashcards) || findBlock(content, BLOCK_LANG.quiz));
}

function lineOf(content: string, offset: number): number {
    let n = 0;
    for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * Rewrite the 2.0.0 code blocks of a note as a callout region placed where
 * the first block was. Returns null when there is nothing to convert.
 */
export function convertLegacyContent(data: string): string | null {
    const cardsBlock = findBlock(data, BLOCK_LANG.flashcards);
    const quizBlock = findBlock(data, BLOCK_LANG.quiz);
    if (!cardsBlock && !quizBlock) return null;

    const body = serializeCallouts({
        cards: cardsBlock ? parseFlashcards(cardsBlock.body) : [],
        questions: quizBlock ? parseQuiz(quizBlock.body) : [],
    });
    // Work from the end so earlier offsets stay valid.
    const blocks = [cardsBlock, quizBlock]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => b.start - a.start);
    let out = data;
    blocks.forEach((b, i) => {
        const isFirst = i === blocks.length - 1;
        let end = b.end;
        // Removing a block: also drop the blank lines that followed it.
        if (!isFirst) while (out[end] === "\n" || out[end] === "\r") end++;
        out = out.slice(0, b.start) + (isFirst ? region(body) : "") + out.slice(end);
    });
    return out;
}
