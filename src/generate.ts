import { Events, TFile } from "obsidian";
import { t } from "./i18n";
import type NotebookLMStudy from "./main";
import { Artifact, CreateRequest, Notebook } from "./nlm-cli";

export interface GenerateRequest {
    /** Notes uploaded as sources. Empty = use the notebook's existing sources. */
    notes: TFile[];
    /** An existing notebook, or a title for a new one. */
    notebook: { id: string; title: string } | { title: string };
    outputs: CreateRequest[];
}

export type JobStatus = "running" | "done" | "error";

export interface Job {
    id: number;
    title: string;
    status: JobStatus;
    step: string;
    /** 0..1 */
    progress: number;
    error?: string;
    files: TFile[];
    startedAt: number;
}

const POLL_MS = 15_000;
const TIMEOUT_MS = 25 * 60_000;

/**
 * Runs "generate with NotebookLM" jobs: upload notes as sources, ask
 * NotebookLM for flashcards / quizzes / mind maps / audio…, wait for them to
 * finish, then import them. Emits "changed" whenever a job moves.
 */
export class Generator extends Events {
    jobs: Job[] = [];
    private nextId = 1;

    constructor(private plugin: NotebookLMStudy) {
        super();
    }

    get running(): number {
        return this.jobs.filter(j => j.status === "running").length;
    }

    clearFinished() {
        this.jobs = this.jobs.filter(j => j.status === "running");
        this.trigger("changed");
    }

    start(req: GenerateRequest): Job {
        const title = "id" in req.notebook ? req.notebook.title : req.notebook.title;
        const job: Job = { id: this.nextId++, title, status: "running", step: t("Starting…"), progress: 0, files: [], startedAt: Date.now() };
        this.jobs.unshift(job);
        this.trigger("changed");
        void this.run(job, req);
        return job;
    }

    private update(job: Job, step: string, progress: number) {
        job.step = step;
        job.progress = progress;
        this.trigger("changed");
    }

    private async run(job: Job, req: GenerateRequest) {
        const cli = this.plugin.nlm();
        try {
            // 1. Notebook
            let notebook: Notebook;
            if ("id" in req.notebook) {
                notebook = { id: req.notebook.id, title: req.notebook.title };
            } else {
                this.update(job, t("Creating notebook…"), 0.05);
                notebook = await cli.createNotebook(req.notebook.title);
            }

            // 2. Sources
            const sourceIds: string[] = [];
            for (const [i, note] of req.notes.entries()) {
                this.update(job, t("Uploading {name} ({i}/{n})…", { name: note.basename, i: i + 1, n: req.notes.length }),
                    0.05 + 0.25 * (i / Math.max(1, req.notes.length)));
                const text = await this.plugin.app.vault.cachedRead(note);
                const id = await cli.addTextSource(notebook.id, note.basename, stripFrontmatter(text));
                if (id) sourceIds.push(id);
            }

            // 3. Start generation
            const started: { id: string; req: CreateRequest }[] = [];
            for (const [i, out] of req.outputs.entries()) {
                this.update(job, t("Asking NotebookLM for {what}…", { what: kindLabel(out.kind) }), 0.3 + 0.1 * (i / req.outputs.length));
                const id = await cli.createArtifact(notebook.id, out, sourceIds);
                started.push({ id, req: out });
            }

            // 4. Wait for completion
            const pending = new Set(started.map(s => s.id));
            const done = new Map<string, Artifact>();
            const failed: string[] = [];
            const deadline = Date.now() + TIMEOUT_MS;
            while (pending.size) {
                if (Date.now() > deadline) throw new Error(t("Timed out waiting for NotebookLM."));
                this.update(job, t("Generating in NotebookLM ({done}/{n} ready)…", { done: started.length - pending.size, n: started.length }),
                    0.4 + 0.4 * ((started.length - pending.size) / started.length));
                const list = await cli.listArtifacts(notebook.id).catch(() => [] as Artifact[]);
                for (const a of list) {
                    if (!pending.has(a.id)) continue;
                    if (a.status === "completed") { pending.delete(a.id); done.set(a.id, a); }
                    else if (a.status === "failed") { pending.delete(a.id); failed.push(a.title); }
                }
                if (pending.size) await sleep(POLL_MS);
            }

            // 5. Import
            let i = 0;
            for (const a of done.values()) {
                this.update(job, t("Importing {name}…", { name: a.title }), 0.8 + 0.2 * (i++ / done.size));
                const file = await this.plugin.importArtifact(notebook, a);
                if (file) job.files.push(file);
            }

            job.status = failed.length && !job.files.length ? "error" : "done";
            if (failed.length) job.error = t("NotebookLM could not generate: {names}", { names: failed.join(", ") });
            this.update(job, job.status === "done" ? t("Done") : t("Failed"), 1);
        } catch (e) {
            job.status = "error";
            job.error = (e as Error).message;
            this.update(job, t("Failed"), job.progress);
        }
    }
}

export function kindLabel(kind: string): string {
    switch (kind) {
        case "flashcards": return t("Flashcards");
        case "quiz": return t("Quiz");
        case "mind_map": return t("Mind map");
        case "audio": return t("Audio overview");
        case "report": return t("Report");
        case "infographic": return t("Infographic");
        case "slide_deck": return t("Slide deck");
        default: return kind;
    }
}

function stripFrontmatter(text: string): string {
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}
