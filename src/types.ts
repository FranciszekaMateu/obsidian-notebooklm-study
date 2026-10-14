export type ContentType = "flashcards" | "quiz" | "mindmap";

export interface Flashcard {
    id?: string;
    front: string;
    back: string;
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

/** A reviewable item found in the vault. Quiz questions are reviewable too. */
export type StudyItem =
    | { kind: "flashcard"; id: string; path: string; deck: string; card: Flashcard }
    | { kind: "quiz"; id: string; path: string; deck: string; question: QuizQuestion };
