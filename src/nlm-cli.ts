import { Platform } from "obsidian";
import { parseJSON } from "./parsers/json";
import { ParsedContent } from "./types";

export interface Notebook {
    id: string;
    title: string;
    sourceCount?: number;
    updatedAt?: string;
}

export type ArtifactKind = "flashcards" | "quiz" | "mind_map";

export interface Artifact {
    id: string;
    kind: ArtifactKind;
    title: string;
    status: string;
    createdAt?: string;
}

const STUDY_KINDS: ArtifactKind[] = ["flashcards", "quiz", "mind_map"];

/**
 * Thin wrapper around the `nlm` CLI (notebooklm-mcp-cli). Desktop only:
 * Node modules are required lazily so the plugin still loads on mobile.
 */
export class NlmCli {
    constructor(private binary: string, private profile: string) {}

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

    async listStudyArtifacts(notebookId: string): Promise<Artifact[]> {
        // --full is needed for titles and creation dates.
        const data = this.parseOutput(await this.run(["studio", "status", notebookId, "--json", "--full"]));
        const list = Array.isArray(data) ? data : (data as { artifacts?: unknown[] })?.artifacts;
        if (!Array.isArray(list)) throw new Error("Unexpected output from `nlm studio status`");

        return list
            .map((a: Record<string, unknown>) => ({
                id: String(a.artifact_id ?? a.id ?? ""),
                kind: String(a.type ?? "") as ArtifactKind,
                title: String(a.title ?? a.type ?? "Untitled"),
                status: String(a.status ?? "unknown"),
                createdAt: typeof a.created_at === "string" ? a.created_at : undefined,
            }))
            .filter(a => a.id && STUDY_KINDS.includes(a.kind));
    }

    /** Download one artifact as JSON and parse it. */
    async download(notebookId: string, artifact: Pick<Artifact, "id" | "kind">): Promise<ParsedContent> {
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const os = require("os") as typeof import("os");

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlm-obsidian-"));
        const out = path.join(dir, `${artifact.kind}.json`);
        try {
            const sub = artifact.kind === "mind_map" ? "mind-map" : artifact.kind;
            const args = ["download", sub, notebookId, "--id", artifact.id, "--output", out];
            if (artifact.kind !== "mind_map") args.push("--format", "json");
            await this.run(args);
            const content = fs.readFileSync(out, "utf8");
            const hint = artifact.kind === "mind_map" ? "mindmap" : artifact.kind;
            return parseJSON(content, hint);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    private parseOutput(stdout: string): unknown {
        // Some versions print notices before the JSON; start at the first bracket.
        const start = stdout.search(/[[{]/);
        if (start < 0) throw new Error(stdout.trim() || "Empty output from nlm");
        const data = JSON.parse(stdout.slice(start));
        if (data && typeof data === "object" && !Array.isArray(data) && data.status === "error") {
            throw new Error(String(data.error ?? "nlm reported an error"));
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
        const env = {
            ...process.env,
            PATH: [process.env.PATH ?? "", ...extraPath].join(path.delimiter),
            // Without these, Python on Windows writes notebook titles in the console codepage.
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            NO_COLOR: "1",
        };

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
                        const msg = (stderr || stdout || err.message).toString().trim();
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
    if (/auth|login|cookie|expired/i.test(msg)) {
        return `NotebookLM session expired. Run "nlm login" in a terminal, then try again.\n\n${msg}`;
    }
    return msg.split(/\r?\n/).slice(-6).join("\n");
}
