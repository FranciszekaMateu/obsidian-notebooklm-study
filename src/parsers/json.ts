import { Flashcard, MindMapNode, ParsedContent, QuizOption, QuizQuestion } from "../types";

/**
 * Parses the JSON shapes the `nlm` CLI writes, plus the raw NotebookLM
 * app-data shapes it is derived from:
 *  - flashcards: {title, cards:[{front, back}]}  or  {flashcards:[{f, b}]}
 *  - quiz:       {title, questions:[{question, answerOptions, hint}]}  or  {quiz:[...]}
 *  - mind map:   {name, children:[...]}  or  {nodes:[...]}
 */
export function parseJSON(content: string, hint?: "flashcards" | "quiz" | "mindmap"): ParsedContent {
    let data: unknown;
    try {
        data = JSON.parse(content.replace(/^﻿/, ""));
    } catch (e) {
        throw new Error(`Invalid JSON: ${(e as Error).message}`);
    }
    if (!isObject(data) && !Array.isArray(data)) throw new Error("Unrecognized JSON content");

    const obj = (isObject(data) ? data : {}) as Record<string, unknown>;
    const title = str(obj.title) || undefined;

    const cardList = obj.cards ?? obj.flashcards ?? (hint === "flashcards" ? data : undefined);
    if (Array.isArray(cardList)) {
        return { type: "flashcards", title, cards: cardList.map(toFlashcard).filter(isPresent) };
    }

    const quizList = obj.questions ?? obj.quiz ?? (hint === "quiz" ? data : undefined);
    if (Array.isArray(quizList)) {
        return { type: "quiz", title, questions: quizList.map(toQuestion).filter(isPresent) };
    }

    if ("children" in obj || "nodes" in obj || "name" in obj) {
        const root = toMindMap(obj);
        if (root) return { type: "mindmap", title: root.name, root };
    }

    throw new Error("JSON does not look like NotebookLM flashcards, a quiz or a mind map");
}

function toFlashcard(raw: unknown): Flashcard | null {
    if (!isObject(raw)) return null;
    const front = str(raw.front ?? raw.f ?? raw.question ?? raw.q);
    const back = str(raw.back ?? raw.b ?? raw.answer ?? raw.a);
    return front && back ? { front, back } : null;
}

function toQuestion(raw: unknown): QuizQuestion | null {
    if (!isObject(raw)) return null;
    const question = str(raw.question);
    const rawOptions = raw.answerOptions ?? raw.options;
    if (!question || !Array.isArray(rawOptions)) return null;

    const options: QuizOption[] = [];
    for (const o of rawOptions) {
        if (!isObject(o)) continue;
        const text = str(o.text);
        if (!text) continue;
        const option: QuizOption = { text, correct: o.isCorrect === true || o.correct === true };
        const rationale = str(o.rationale);
        if (rationale) option.rationale = rationale;
        options.push(option);
    }
    if (options.length === 0) return null;

    const q: QuizQuestion = { question, options };
    const hint = str(raw.hint);
    if (hint) q.hint = hint;
    return q;
}

function toMindMap(raw: unknown, depth = 0): MindMapNode | null {
    if (!isObject(raw) || depth > 50) return null;
    const name = str(raw.name ?? raw.title ?? raw.text ?? raw.label) || "Mind map";
    const kids = raw.children ?? raw.nodes;
    const children = Array.isArray(kids)
        ? kids.map(k => toMindMap(k, depth + 1)).filter(isPresent)
        : [];
    return { name, children };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

function isPresent<T>(v: T | null): v is T {
    return v !== null;
}
