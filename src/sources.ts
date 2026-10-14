import { App, FileSystemAdapter, TFile, TFolder } from "obsidian";

/** Vault files NotebookLM can take as a source. Markdown is uploaded as text, the rest as files. */
export const SOURCE_EXTENSIONS = ["md", "pdf", "txt", "docx", "pptx", "mp3", "m4a", "wav"];

export function isSourceFile(f: unknown): f is TFile {
    return f instanceof TFile && SOURCE_EXTENSIONS.includes(f.extension.toLowerCase());
}

export function collectSources(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    for (const child of folder.children) {
        if (isSourceFile(child)) out.push(child);
        else if (child instanceof TFolder) out.push(...collectSources(child));
    }
    return out;
}

/** Absolute path on disk (desktop only), needed to hand a PDF to the nlm CLI. */
export function fullPath(app: App, file: TFile): string {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Uploading files needs the desktop app");
    return adapter.getFullPath(file.path);
}

/** Read `nlm-sources: ["[[file.pdf]]", …]` from frontmatter into vault files. */
export function sourceLinks(app: App, value: unknown, from: string): TFile[] {
    const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const out: TFile[] = [];
    for (const v of list) {
        const link = String(v).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
        const file = app.metadataCache.getFirstLinkpathDest(link, from);
        if (file) out.push(file);
    }
    return out;
}
