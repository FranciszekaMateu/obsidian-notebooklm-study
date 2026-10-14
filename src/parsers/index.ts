import { parseOutline } from "../mindmap";
import { ParsedContent } from "../types";
import { parseCSV } from "./csv";
import { parseJSON } from "./json";

/** Parse a NotebookLM export picked from disk: CSV, nlm JSON, or a Markdown outline (mind map). */
export function parseFile(fileName: string, text: string, fallbackTitle: string): ParsedContent {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext === "json") return parseJSON(text);
    if (ext === "md" || ext === "txt") {
        const root = parseOutline(text.replace(/^---[\s\S]*?---\s*/, ""), fallbackTitle);
        if (!root.children.length) throw new Error("No nested list found in this file.");
        return { type: "mindmap", title: root.name, root };
    }
    return parseCSV(text);
}
