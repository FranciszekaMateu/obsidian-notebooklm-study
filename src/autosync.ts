import { Events, Notice, Platform } from "obsidian";
import { t, tn } from "./i18n";
import type NotebookLMStudy from "./main";
import { ArtifactKind, MEDIA_KINDS, STUDY_KINDS } from "./nlm-cli";

/**
 * Periodically looks at every NotebookLM notebook that already has notes in
 * the vault and imports artifacts that were never imported before (so a note
 * the user deleted is not brought back). Emits "changed" when its state moves.
 */
export class AutoSync extends Events {
    running = false;
    lastError = "";
    private timer: number | null = null;

    constructor(private plugin: NotebookLMStudy) {
        super();
    }

    /** (Re)arm the timer from the current settings. */
    schedule() {
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
        const hours = this.plugin.settings.autoSyncHours;
        if (!Platform.isDesktopApp || hours <= 0) return;
        this.timer = window.setInterval(() => void this.run(true), hours * 3600_000);
        this.plugin.registerInterval(this.timer);
    }

    stop() {
        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;
    }

    /** Kinds that the auto import is allowed to bring in. */
    private kinds(): ArtifactKind[] {
        const s = this.plugin.settings;
        return [...STUDY_KINDS, ...(s.autoSyncMedia ? MEDIA_KINDS : [])];
    }

    async run(silent: boolean): Promise<number> {
        if (this.running || !Platform.isDesktopApp) return 0;
        this.running = true;
        this.lastError = "";
        this.trigger("changed");

        const p = this.plugin;
        const notebooks = new Map<string, string>();
        for (const d of p.index.list()) {
            if (d.notebookId) notebooks.set(d.notebookId, d.notebookTitle ?? d.deck);
        }

        let imported = 0;
        try {
            const cli = p.nlm();
            const kinds = this.kinds();
            for (const [id, title] of notebooks) {
                const artifacts = await cli.listArtifacts(id);
                for (const a of artifacts) {
                    if (a.status !== "completed" || !kinds.includes(a.kind) || p.wasImported(a.id)) continue;
                    // Already in the vault from before import tracking existed.
                    if (p.index.list().some(d => d.artifactId === a.id)) {
                        p.markImported(a.id);
                        continue;
                    }
                    const file = await p.importArtifact({ id, title }, a);
                    if (file) imported++;
                }
            }
            p.syncState.lastRun = Date.now();
            await p.saveSettings();
            if (imported || !silent) new Notice(imported ? tn(imported, "Imported {n} new item from NotebookLM.", "Imported {n} new items from NotebookLM.") : t("NotebookLM: nothing new."));
        } catch (e) {
            this.lastError = (e as Error).message;
            if (!silent) new Notice(this.lastError, 8000);
        } finally {
            this.running = false;
            this.trigger("changed");
        }
        return imported;
    }
}
