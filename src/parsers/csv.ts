import { Flashcard, ParsedContent, QuizQuestion } from "../types";

/**
 * Parses the CSV exports NotebookLM produces. Three shapes are auto-detected:
 *  A) standard CSV: "Question","Answer"
 *  B) "Q: question; A: answer" lines
 *  C) multiple choice: "Q: question; A: option; isCorrect: true" (one line per option)
 */
export function parseCSV(content: string): ParsedContent {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return { type: "flashcards", cards: [] };

    if (content.includes("; isCorrect:")) {
        return { type: "quiz", questions: parseQuizLines(lines) };
    }
    if (lines[0].includes("Q:") && lines[0].includes("; A:")) {
        return { type: "flashcards", cards: parseQALines(lines) };
    }
    return { type: "flashcards", cards: parseStandardCSV(content) };
}

function stripIndex(line: string): string {
    return line.replace(/^\d+:\s*/, "");
}

function parseQuizLines(lines: string[]): QuizQuestion[] {
    const questions: QuizQuestion[] = [];
    let current: QuizQuestion | null = null;

    for (const line of lines) {
        const parts = stripIndex(line).split("; A:");
        if (parts.length < 2) continue;
        const q = parts[0].replace(/^Q:\s*/, "").trim();
        const subParts = parts.slice(1).join("; A:").split("; isCorrect:");
        if (subParts.length < 2) continue;

        if (!current || current.question !== q) {
            current = { question: q, options: [] };
            questions.push(current);
        }
        current.options.push({
            text: subParts[0].trim(),
            correct: subParts[1].trim().toLowerCase() === "true",
        });
    }
    return questions;
}

function parseQALines(lines: string[]): Flashcard[] {
    const cards: Flashcard[] = [];
    for (const line of lines) {
        const parts = stripIndex(line).split("; A:");
        if (parts.length < 2) continue;
        const front = parts[0].replace(/^Q:\s*/, "").trim();
        const back = parts.slice(1).join("; A:").trim();
        if (front && back) cards.push({ front, back });
    }
    return cards;
}

function parseStandardCSV(content: string): Flashcard[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const next = content[i + 1];

        if (inQuotes) {
            if (char === '"' && next === '"') {
                field += '"';
                i++;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            if (char === "\r" && next === "\n") i++;
        } else {
            field += char;
        }
    }
    if (field || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    const cards: Flashcard[] = [];
    for (const r of rows) {
        if (r.length < 2) continue;
        const front = stripIndex(r[0].trim());
        const back = r[1].trim();
        if (front && back && !isHeader(front, back)) cards.push({ front, back });
    }
    return cards;
}

function isHeader(q: string, a: string): boolean {
    const headers = ["question", "answer", "front", "back", "pregunta", "respuesta"];
    return headers.includes(q.toLowerCase()) && headers.includes(a.toLowerCase());
}
