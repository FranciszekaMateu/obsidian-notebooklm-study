/**
 * Stable short ids derived from content (FNV-1a, 2x32 bits). Re-importing an
 * unchanged card yields the same id, so its review history survives a re-sync.
 */
export function contentId(prefix: string, ...parts: string[]): string {
    const text = parts.map(normalize).join("\u0000");
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    const a = (h1 >>> 0).toString(36);
    const b = (h2 >>> 0).toString(36);
    return `${prefix}-${(a + b).slice(0, 10)}`;
}

function normalize(s: string): string {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function slugify(s: string): string {
    return s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Strip characters that are invalid in vault file names. */
export function safeFileName(s: string): string {
    return s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
}
