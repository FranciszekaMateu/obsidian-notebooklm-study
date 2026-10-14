/*
 * Cloze deletions inside a `> [!cloze]` callout:
 *
 *   > [!cloze] Cell biology
 *   > The {{mitochondrion}} makes {{c2::ATP::energy molecule}}.
 *
 * `{{text}}` gets the next free group number; `{{cN::text}}` sets it
 * explicitly (same N = hidden together); a third part is a hint.
 */

export interface ClozeSpan {
    start: number;
    end: number;
    group: number;
    answer: string;
    hint?: string;
}

const CLOZE_RE = /\{\{(?:c(\d+)::)?([\s\S]+?)(?:::([^{}]*?))?\}\}/g;

export function findClozes(text: string): ClozeSpan[] {
    const spans: ClozeSpan[] = [];
    const explicit = new Set<number>();
    for (const m of text.matchAll(CLOZE_RE)) if (m[1]) explicit.add(Number(m[1]));

    let auto = 1;
    for (const m of text.matchAll(CLOZE_RE)) {
        let group: number;
        if (m[1]) group = Number(m[1]);
        else {
            while (explicit.has(auto)) auto++;
            group = auto++;
        }
        spans.push({ start: m.index!, end: m.index! + m[0].length, group, answer: m[2].trim(), hint: m[3]?.trim() || undefined });
    }
    return spans;
}

export function clozeGroups(text: string): number[] {
    return [...new Set(findClozes(text).map(s => s.group))].sort((a, b) => a - b);
}

/**
 * Markdown for one side of a cloze card. On the front the asked group is
 * blanked; on the back it is highlighted. Other groups always show their text.
 */
export function renderCloze(text: string, group: number, side: "front" | "back"): string {
    let out = "";
    let pos = 0;
    for (const s of findClozes(text)) {
        out += text.slice(pos, s.start);
        if (s.group !== group) out += s.answer;
        else if (side === "front") out += `<span class="nlm-cloze-blank">[${escapeHtml(s.hint ?? "…")}]</span>`;
        else out += `<span class="nlm-cloze-answer">${escapeHtml(s.answer)}</span>`;
        pos = s.end;
    }
    return out + text.slice(pos);
}

/** The text with every deletion shown plainly (for search and previews). */
export function clozePlain(text: string): string {
    let out = "";
    let pos = 0;
    for (const s of findClozes(text)) {
        out += text.slice(pos, s.start) + s.answer;
        pos = s.end;
    }
    return out + text.slice(pos);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
