/** Study notes hold flashcards / quizzes / mind maps; media notes wrap other NotebookLM outputs. */
export type ContentType = "flashcards" | "quiz" | "mindmap" | MediaType;
export type MediaType = "audio" | "report" | "infographic" | "slides";
export const MEDIA_TYPES: MediaType[] = ["audio", "report", "infographic", "slides"];

export interface Flashcard {
    id?: string;
    front: string;
    back: string;
    /** Also study it back-to-front (adds a second item with id "<id>-r"). */
    reverse?: boolean;
}

export interface QuizOption {
    text: string;
    correct: boolean;
    rationale?: string;
}

export interface QuizQuestion {
    id?: string;
    question: string;
    options: QuizOption[];
    hint?: string;
}

/** A cloze note: text with {{deletions}}; each deletion group becomes one card. */
export interface ClozeNote {
    id?: string;
    title: string;
    text: string;
}

export interface MindMapNode {
    name: string;
    children: MindMapNode[];
}

export type ParsedContent =
    | { type: "flashcards"; title?: string; cards: Flashcard[] }
    | { type: "quiz"; title?: string; questions: QuizQuestion[] }
    | { type: "mindmap"; title?: string; root: MindMapNode };

/** Where a note came from, written to its frontmatter so it can be re-synced. */
export interface NoteOrigin {
    notebookId?: string;
    notebookTitle?: string;
    artifactId?: string;
    source: "notebooklm" | "file";
}

interface ItemBase {
    id: string;
    path: string;
    deck: string;
    line?: number;
}

/** A reviewable item found in the vault. */
export type StudyItem =
    | (ItemBase & { kind: "flashcard"; card: Flashcard; reversed?: boolean })
    | (ItemBase & { kind: "quiz"; question: QuizQuestion })
    | (ItemBase & { kind: "cloze"; cloze: ClozeNote; group: number });

/** Plain-text prompt of an item, for lists and search. */
export function itemPrompt(item: StudyItem): string {
    switch (item.kind) {
        case "flashcard": return item.card.front;
        case "quiz": return item.question.question;
        case "cloze": return item.cloze.text;
    }
}

export function itemAnswer(item: StudyItem): string {
    switch (item.kind) {
        case "flashcard": return item.card.back;
        case "quiz": return item.question.options.filter(o => o.correct).map(o => o.text).join(" / ");
        case "cloze": return item.cloze.text;
    }
}
