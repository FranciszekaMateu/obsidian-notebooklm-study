import { App, Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type NotebookLMStudy from "../main";
import { Artifact, Notebook } from "../nlm-cli";

const KIND_LABEL: Record<string, string> = { flashcards: "Flashcards", quiz: "Quiz", mind_map: "Mind map" };
const KIND_ICON: Record<string, string> = { flashcards: "layers", quiz: "list-checks", mind_map: "network" };

/** Pick a NotebookLM notebook, then the flashcards / quizzes / mind maps to bring in. */
export class SyncModal extends Modal {
    private notebooks: Notebook[] = [];

    constructor(app: App, private plugin: NotebookLMStudy) {
        super(app);
    }

    onOpen() {
        this.modalEl.addClass("nlm-sync-modal");
        void this.loadNotebooks();
    }

    onClose() {
        this.contentEl.empty();
    }

    private loading(text: string) {
        this.contentEl.empty();
        const el = this.contentEl.createDiv({ cls: "nlm-loading" });
        el.createDiv({ cls: "nlm-spinner" });
        el.createSpan({ text });
    }

    private error(err: unknown, retry: () => void) {
        this.contentEl.empty();
        const box = this.contentEl.createDiv({ cls: "nlm-error" });
        box.createEl("pre", { text: (err as Error).message ?? String(err) });
        new Setting(this.contentEl)
            .addButton(b => b.setButtonText("Retry").setCta().onClick(retry))
            .addButton(b => b.setButtonText("Settings").onClick(() => {
                this.close();
                const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
                setting.open();
                setting.openTabById(this.plugin.manifest.id);
            }));
    }

    private async loadNotebooks() {
        this.setTitle("Sync from NotebookLM");
        this.loading("Loading notebooks…");
        try {
            this.notebooks = await this.plugin.nlm().listNotebooks();
        } catch (e) {
            this.error(e, () => void this.loadNotebooks());
            return;
        }
        this.renderNotebooks();
    }

    private renderNotebooks() {
        const { contentEl } = this;
        contentEl.empty();

        const search = contentEl.createEl("input", { type: "search", cls: "nlm-search", attr: { placeholder: "Search notebooks…" } });
        const list = contentEl.createDiv({ cls: "nlm-pick-list" });

        const draw = () => {
            list.empty();
            const q = search.value.toLowerCase();
            const shown = this.notebooks.filter(n => n.title.toLowerCase().includes(q));
            if (!shown.length) list.createDiv({ cls: "nlm-empty", text: "No notebooks match." });
            for (const nb of shown) {
                const linked = this.plugin.index.list().filter(d => d.notebookId === nb.id).length;
                const row = list.createDiv({ cls: "nlm-pick-row", attr: { tabindex: "0" } });
                setIcon(row.createSpan({ cls: "nlm-row-icon" }), "book-open");
                const text = row.createDiv({ cls: "nlm-pick-text" });
                text.createDiv({ cls: "nlm-pick-title", text: nb.title });
                const meta: string[] = [];
                if (nb.sourceCount !== undefined) meta.push(`${nb.sourceCount} sources`);
                if (nb.updatedAt) meta.push(`updated ${new Date(nb.updatedAt).toLocaleDateString()}`);
                if (linked) meta.push(`${linked} in vault`);
                text.createDiv({ cls: "nlm-pick-meta", text: meta.join(" · ") });
                row.onclick = () => void this.loadArtifacts(nb);
                row.onkeydown = e => { if (e.key === "Enter") row.click(); };
            }
        };
        search.oninput = draw;
        draw();
        search.focus();
    }

    private async loadArtifacts(nb: Notebook) {
        this.setTitle(nb.title);
        this.loading("Loading flashcards, quizzes and mind maps…");
        let artifacts: Artifact[];
        try {
            artifacts = await this.plugin.nlm().listStudyArtifacts(nb.id);
        } catch (e) {
            this.error(e, () => void this.loadArtifacts(nb));
            return;
        }
        this.renderArtifacts(nb, artifacts);
    }

    private renderArtifacts(nb: Notebook, artifacts: Artifact[]) {
        const { contentEl } = this;
        contentEl.empty();

        const back = contentEl.createEl("button", { cls: "nlm-back", text: "All notebooks" });
        setIcon(back.createSpan({ cls: "nlm-btn-icon" }), "arrow-left");
        back.onclick = () => { this.setTitle("Sync from NotebookLM"); this.renderNotebooks(); };

        if (!artifacts.length) {
            contentEl.createDiv({
                cls: "nlm-empty",
                text: "This notebook has no flashcards, quizzes or mind maps yet. Create them in NotebookLM's Studio panel, then sync again.",
            });
            return;
        }

        const existing = new Set(this.plugin.index.list().map(d => d.artifactId).filter(Boolean));
        const selected = new Set(artifacts.filter(a => a.status === "completed").map(a => a.id));

        const list = contentEl.createDiv({ cls: "nlm-pick-list" });
        for (const a of artifacts) {
            const ready = a.status === "completed";
            const row = list.createEl("label", { cls: "nlm-pick-row" + (ready ? "" : " is-disabled") });
            const cb = row.createEl("input", { type: "checkbox" });
            cb.checked = selected.has(a.id);
            cb.disabled = !ready;
            cb.onchange = () => (cb.checked ? selected.add(a.id) : selected.delete(a.id));
            setIcon(row.createSpan({ cls: "nlm-row-icon" }), KIND_ICON[a.kind]);
            const text = row.createDiv({ cls: "nlm-pick-text" });
            text.createDiv({ cls: "nlm-pick-title", text: a.title });
            const meta = [KIND_LABEL[a.kind]];
            if (!ready) meta.push(a.status);
            if (existing.has(a.id)) meta.push("already in vault — will update");
            text.createDiv({ cls: "nlm-pick-meta", text: meta.join(" · ") });
        }

        const status = contentEl.createDiv({ cls: "nlm-status" });
        new Setting(contentEl).addButton(b => b.setButtonText("Import selected").setCta().onClick(async () => {
            const chosen = artifacts.filter(a => selected.has(a.id));
            if (!chosen.length) { new Notice("Select at least one item."); return; }
            b.setDisabled(true);
            const files = await this.importArtifacts(nb, chosen, status);
            b.setDisabled(false);
            if (files.length) {
                this.close();
                if (this.plugin.settings.openAfterImport) await this.app.workspace.getLeaf(false).openFile(files[0]);
            }
        }));
    }

    private async importArtifacts(nb: Notebook, chosen: Artifact[], status: HTMLElement): Promise<TFile[]> {
        const files: TFile[] = [];
        const failures: string[] = [];
        for (const [i, a] of chosen.entries()) {
            status.setText(`Downloading ${i + 1}/${chosen.length}: ${a.title}…`);
            try {
                const content = await this.plugin.nlm().download(nb.id, a);
                const res = await this.plugin.writer.write({
                    content,
                    title: a.title,
                    origin: { source: "notebooklm", notebookId: nb.id, notebookTitle: nb.title, artifactId: a.id },
                });
                files.push(res.file);
            } catch (e) {
                console.error("NotebookLM study: download failed", a, e);
                failures.push(`${a.title}: ${(e as Error).message}`);
            }
        }
        status.setText("");
        if (failures.length) new Notice(`Some items failed:\n${failures.join("\n")}`, 10000);
        if (files.length) new Notice(`Imported ${files.length} item${files.length > 1 ? "s" : ""} from ${nb.title}.`);
        return files;
    }
}
