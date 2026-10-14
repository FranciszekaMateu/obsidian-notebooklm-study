import { Platform } from "obsidian";
import { parseJSON } from "./parsers/json";
import { normalizeMath } from "./parsers/rich-text";
import { MediaType, ParsedContent } from "./types";

export interface Notebook {
    id: string;
    title: string;
    sourceCount?: number;
    updatedAt?: string;
}

/** Studio artifact types as `nlm studio status` names them. */
export type StudyKind = "flashcards" | "quiz" | "mind_map";
export type MediaKind = "audio" | "report" | "infographic" | "slide_deck";
export type ArtifactKind = StudyKind | MediaKind;

export const STUDY_KINDS: StudyKind[] = ["flashcards", "quiz", "mind_map"];
export const MEDIA_KINDS: MediaKind[] = ["audio", "report", "infographic", "slide_deck"];

export const MEDIA_KIND_TYPE: Record<MediaKind, MediaType> = {
    audio: "audio", report: "report", infographic: "infographic", slide_deck: "slides",
};

export interface Artifact {
    id: string;
    kind: ArtifactKind;
    title: string;
    status: string;
    createdAt?: string;
}

export interface QueryReference {
    sourceId: string;
    number: number;
    text: string;
}

export interface QueryAnswer {
    answer: string;
    conversationId?: string;
    references: QueryReference[];
}

/** Options for generating a study artifact in NotebookLM. */
export type CreateRequest =
    | { kind: "flashcards"; difficulty: "easy" | "medium" | "hard"; focus?: string }
    | { kind: "quiz"; count: number; difficulty: number; focus?: string }
    | { kind: "mind_map"; title?: string }
    | { kind: "audio"; format: "deep_dive" | "brief" | "critique" | "debate"; length: "short" | "default" | "long"; focus?: string }
    | { kind: "report"; format: "Briefing Doc" | "Study Guide" | "Blog Post" }
    | { kind: "infographic"; focus?: string };

const MEDIA_EXT: Record<MediaKind, string> = { audio: "m4a", report: "md", infographic: "png", slide_deck: "pdf" };

/**
 * Thin wrapper around the `nlm` CLI (notebooklm-mcp-cli). Desktop only:
 * Node modules are required lazily so the plugin still loads on mobile.
 */
export class NlmCli {
    constructor(private binary: string, private profile: string, private language = "") {}

    static get available(): boolean {
        return Platform.isDesktopApp;
    }

    /** Resolve "nlm" to a full path when it lives in a common install dir that Obsidian's PATH misses. */
    static detectBinary(): string {
        if (!Platform.isDesktopApp) return "nlm";
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const os = require("os") as typeof import("os");
        const exe = process.platform === "win32" ? "nlm.exe" : "nlm";
        const candidates = [
            path.join(os.homedir(), ".local", "bin", exe),
            path.join(os.homedir(), ".cargo", "bin", exe),
            "/opt/homebrew/bin/nlm",
            "/usr/local/bin/nlm",
        ];
        return candidates.find(p => fs.existsSync(p)) ?? "nlm";
    }

    async version(): Promise<string> {
        return (await this.run(["--version"])).trim();
    }

    // --- Notebooks and sources --------------------------------------------------

    async listNotebooks(): Promise<Notebook[]> {
        const data = this.parseOutput(await this.run(["notebook", "list", "--json"]));
        if (!Array.isArray(data)) throw new Error("Unexpected output from `nlm notebook list`");
        return data.map((n: Record<string, unknown>) => ({
            id: String(n.id),
            title: String(n.title ?? "Untitled"),
            sourceCount: typeof n.source_count === "number" ? n.source_count : undefined,
            updatedAt: typeof n.updated_at === "string" ? n.updated_at : undefined,
        }));
    }

    async createNotebook(title: string): Promise<Notebook> {
        const data = this.parseOutput(await this.run(["notebook", "create", title, "--json"])) as Record<string, unknown>;
        const id = String(data.notebook_id ?? data.id ?? "");
        if (!id) throw new Error("NotebookLM did not return a notebook id");
        return { id, title: String(data.title ?? title) };
    }

    /** Upload a file as a source and wait until NotebookLM has processed it. */
    async addFileSource(notebookId: string, filePath: string): Promise<string> {
        const data = this.parseOutput(
            await this.run(["source", "add", notebookId, "--file", filePath, "--wait", "--json"], 600000)
        ) as Record<string, unknown>;
        return String(data.source_id ?? data.id ?? "");
    }

    /** Upload text (e.g. a note) as a source, via a temporary Markdown file named after it. */
    async addTextSource(notebookId: string, title: string, text: string): Promise<string> {
        const { dir, path: tmp } = this.tempFile(`${title.replace(/[\\/:*?"<>|]/g, " ").trim() || "note"}.md`);
        const fs = require("fs") as typeof import("fs");
        try {
            fs.writeFileSync(tmp, text, "utf8");
            return await this.addFileSource(notebookId, tmp);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // --- Studio ---------------------------------------------------------------

    async listArtifacts(notebookId: string): Promise<Artifact[]> {
        // --full is needed for titles and creation dates.
        const data = this.parseOutput(await this.run(["studio", "status", notebookId, "--json", "--full"]));
        const list = Array.isArray(data) ? data : (data as { artifacts?: unknown[] })?.artifacts;
        if (!Array.isArray(list)) throw new Error("Unexpected output from `nlm studio status`");
        const known: ArtifactKind[] = [...STUDY_KINDS, ...MEDIA_KINDS];

        return list
            .map((a: Record<string, unknown>) => ({
                id: String(a.artifact_id ?? a.id ?? ""),
                kind: String(a.type ?? "") as ArtifactKind,
                title: String(a.title || a.type || "Untitled"),
                status: String(a.status ?? "unknown"),
                createdAt: typeof a.created_at === "string" ? a.created_at : undefined,
            }))
            .filter(a => a.id && known.includes(a.kind));
    }

    /** Start generating an artifact. Returns its id; poll listArtifacts for completion. */
    async createArtifact(notebookId: string, req: CreateRequest, sourceIds: string[] = []): Promise<string> {
        const sub = req.kind === "mind_map" ? "mindmap" : req.kind;
        const args = [sub, "create", notebookId, "--confirm", "--json"];
        switch (req.kind) {
            case "flashcards":
                args.push("--difficulty", req.difficulty);
                if (req.focus) args.push("--focus", req.focus);
                break;
            case "quiz":
                args.push("--count", String(req.count), "--difficulty", String(req.difficulty));
                if (req.focus) args.push("--focus", req.focus);
                break;
            case "mind_map":
                if (req.title) args.push("--title", req.title);
                break;
            case "audio":
                args.push("--format", req.format, "--length", req.length);
                if (req.focus) args.push("--focus", req.focus);
                break;
            case "report":
                args.push("--format", req.format);
                break;
            case "infographic":
                if (req.focus) args.push("--focus", req.focus);
                break;
        }
        if (sourceIds.length) args.push("--source-ids", sourceIds.join(","));
        const data = this.parseOutput(await this.run(args, 300000)) as Record<string, unknown>;
        const id = String(data.artifact_id ?? data.id ?? "");
        if (!id) throw new Error(`NotebookLM did not return an id for the new ${req.kind}`);
        return id;
    }

    /** Download a flashcards / quiz / mind map artifact and parse it. */
    async download(notebookId: string, artifact: { id: string; kind: StudyKind }): Promise<ParsedContent> {
        const fs = require("fs") as typeof import("fs");
        const { dir, path: out } = this.tempFile(`${artifact.kind}.json`);
        try {
            const sub = artifact.kind === "mind_map" ? "mind-map" : artifact.kind;
            const args = ["download", sub, notebookId, "--id", artifact.id, "--output", out];
            if (artifact.kind !== "mind_map") args.push("--format", "json");
            await this.run(args);
            const content = fs.readFileSync(out, "utf8");
            return parseJSON(content, artifact.kind === "mind_map" ? "mindmap" : artifact.kind);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    /** Download an audio overview, report, infographic or slide deck. */
    async downloadMedia(notebookId: string, artifact: { id: string; kind: MediaKind }): Promise<{ data: ArrayBuffer; ext: string }> {
        const fs = require("fs") as typeof import("fs");
        const ext = MEDIA_EXT[artifact.kind];
        const { dir, path: out } = this.tempFile(`${artifact.kind}.${ext}`);
        try {
            const sub = artifact.kind === "slide_deck" ? "slide-deck" : artifact.kind;
            await this.run(["download", sub, notebookId, "--id", artifact.id, "--output", out], 600000);
            const buf = fs.readFileSync(out);
            return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ext };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // --- Chat -----------------------------------------------------------------

    async query(notebookId: string, question: string, conversationId?: string): Promise<QueryAnswer> {
        const args = ["notebook", "query", notebookId, question, "--json"];
        if (conversationId) args.push("--conversation-id", conversationId);
        const data = this.parseOutput(await this.run(args, 300000)) as Record<string, unknown>;
        const refs = Array.isArray(data.references) ? data.references : [];
        return {
            answer: normalizeMath(String(data.answer ?? "")),
            conversationId: typeof data.conversation_id === "string" ? data.conversation_id : undefined,
            references: refs.map((r: Record<string, unknown>) => ({
                sourceId: String(r.source_id ?? ""),
                number: Number(r.citation_number ?? 0),
                text: String(r.cited_text ?? ""),
            })),
        };
    }

    // --- Process plumbing -----------------------------------------------------

    private tempFile(name: string): { dir: string; path: string } {
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const os = require("os") as typeof import("os");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlm-obsidian-"));
        return { dir, path: path.join(dir, name) };
    }

    private parseOutput(stdout: string): unknown {
        // Some versions print notices before the JSON; start at the first bracket.
        const start = stdout.search(/[[{]/);
        if (start < 0) throw new Error(stdout.trim() || "Empty output from nlm");
        const data = JSON.parse(stdout.slice(start));
        if (data && typeof data === "object" && !Array.isArray(data) && data.status === "error") {
            throw new Error(String(data.error ?? data.message ?? "nlm reported an error"));
        }
        return data;
    }

    private run(args: string[], timeoutMs = 180000): Promise<string> {
        if (!Platform.isDesktopApp) return Promise.reject(new Error("NotebookLM sync is only available on desktop"));
        const { execFile } = require("child_process") as typeof import("child_process");
        const path = require("path") as typeof import("path");
        const os = require("os") as typeof import("os");

        const fullArgs = this.profile ? [...args, "--profile", this.profile] : args;
        const extraPath = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: [process.env.PATH ?? "", ...extraPath].join(path.delimiter),
            // Without these, Python on Windows writes notebook titles in the console codepage.
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            NO_COLOR: "1",
        };
        if (this.language) env.NOTEBOOKLM_HL = this.language;

        return new Promise((resolve, reject) => {
            execFile(
                this.binary || "nlm",
                fullArgs,
                { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
                (err, stdout, stderr) => {
                    if (err) {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === "ENOENT") {
                            reject(new Error(`Could not find the nlm CLI ("${this.binary}"). Set its path in the plugin settings.`));
                            return;
                        }
                        const msg = (stdout || stderr || err.message).toString().trim();
                        reject(new Error(friendlyError(msg)));
                        return;
                    }
                    resolve(stdout.toString());
                }
            );
        });
    }
}

function friendlyError(msg: string): string {
    // JSON errors from --json commands.
    try {
        const start = msg.search(/[[{]/);
        if (start >= 0) {
            const data = JSON.parse(msg.slice(start));
            if (data?.error) msg = String(data.error);
        }
    } catch {
        // not JSON
    }
    if (/auth|login|cookie|expired/i.test(msg)) {
        return `NotebookLM session expired. Run "nlm login" in a terminal, then try again.\n\n${msg}`;
    }
    return msg.split(/\r?\n/).slice(-6).join("\n");
}
