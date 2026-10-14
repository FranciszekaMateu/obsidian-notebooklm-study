/**
 * NotebookLM fields are sometimes plain strings and sometimes rich content,
 * e.g. flashcards now arrive as
 *   { "flashcardContentBlock": [{ "type": "text", "content": "…" }] }
 * This flattens any of those shapes into Markdown.
 */
export function richText(v: unknown, depth = 0): string {
    if (depth > 8 || v === null || v === undefined) return "";
    if (typeof v === "string") return normalizeMath(v).trim();
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(b => block(b, depth + 1)).filter(Boolean).join("\n\n").trim();
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        // A list of blocks under some "...ContentBlock(s)" / "blocks" / "content" key.
        for (const [k, val] of Object.entries(o)) {
            if (Array.isArray(val) && /contentblocks?$|^blocks$|^content$|^parts$/i.test(k)) return richText(val, depth + 1);
        }
        for (const k of ["text", "content", "value", "markdown"]) {
            if (k in o) return richText(o[k], depth + 1);
        }
    }
    return "";
}

function block(b: unknown, depth: number): string {
    if (typeof b === "string") return normalizeMath(b).trim();
    if (!b || typeof b !== "object") return "";
    const o = b as Record<string, unknown>;
    const type = String(o.type ?? "text").toLowerCase();
    const body = richText(o.content ?? o.text ?? o.value ?? o.latex ?? "", depth + 1);
    if (!body) return "";
    if (/latex|math|equation|formula/.test(type)) {
        return /^\$/.test(body) ? body : body.includes("\n") ? `$$\n${body}\n$$` : `$${body}$`;
    }
    if (/code/.test(type)) {
        const lang = typeof o.language === "string" ? o.language : "";
        return "```" + lang + "\n" + body + "\n```";
    }
    return body;
}

/** \( … \) → $…$ and \[ … \] → $$…$$ (also when the backslashes arrive doubled). */
export function normalizeMath(s: string): string {
    return s
        .replace(/\\{1,2}\[([\s\S]+?)\\{1,2}\]/g, (_m, x: string) => `$$${x.trim()}$$`)
        .replace(/\\{1,2}\(([\s\S]+?)\\{1,2}\)/g, (_m, x: string) => `$${x.trim()}$`);
}
