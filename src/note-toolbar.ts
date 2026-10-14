import { MarkdownView, Platform, TFile, setIcon } from "obsidian";
import type NotebookLMStudy from "./main";

const TOOLBAR_CLS = "nlm-note-toolbar";

/**
 * Adds a slim bar under the header of every open note that holds study
 * material: counts plus Study / Practice quiz / Update buttons.
 */
export class NoteToolbars {
    constructor(private plugin: NotebookLMStudy) {}

    register() {
        const { app } = this.plugin;
        const refresh = () => this.refreshAll();
        this.plugin.registerEvent(app.workspace.on("layout-change", refresh));
        this.plugin.registerEvent(app.workspace.on("active-leaf-change", refresh));
        this.plugin.registerEvent(app.workspace.on("file-open", refresh));
        this.plugin.registerEvent(this.plugin.index.on("changed", refresh));
        this.plugin.registerEvent(this.plugin.index.on("reviewed", refresh));
        this.plugin.register(() => document.querySelectorAll(`.${TOOLBAR_CLS}`).forEach(el => el.remove()));
        refresh();
    }

    refreshAll() {
        this.plugin.app.workspace.getLeavesOfType("markdown").forEach(leaf => {
            if (leaf.view instanceof MarkdownView) this.render(leaf.view);
        });
    }

    private render(view: MarkdownView) {
        const host = view.containerEl;
        const content = host.querySelector(":scope > .view-content");
        let bar = host.querySelector<HTMLElement>(`:scope > .${TOOLBAR_CLS}`);
        const file = view.file;
        const deck = file ? this.plugin.index.decks.get(file.path) : undefined;

        if (!file || !deck || !content) {
            bar?.remove();
            return;
        }
        if (!bar) {
            bar = createDiv({ cls: TOOLBAR_CLS });
            host.insertBefore(bar, content);
        }
        bar.empty();

        const p = this.plugin;
        const info = bar.createDiv({ cls: "nlm-tb-info" });

        if (deck.type === "mindmap") {
            setIcon(info.createSpan({ cls: "nlm-tb-icon" }), "network");
            info.createSpan({ cls: "nlm-tb-title", text: "Mind map" });
            const actions = bar.createDiv({ cls: "nlm-tb-actions" });
            const canvas = file.path.replace(/\.md$/, ".canvas");
            if (p.app.vault.getAbstractFileByPath(canvas)) {
                button(actions, "layout-dashboard", "Open canvas", () => void p.app.workspace.openLinkText(canvas, file.path, "tab"));
            }
            this.syncButton(actions, file);
            return;
        }

        const cards = deck.items.filter(i => i.kind === "flashcard").length;
        const questions = deck.items.filter(i => i.kind === "quiz").length;
        const studyable = p.filterStudyable(deck.items);
        const c = p.stateCounts(studyable.map(i => i.id));

        setIcon(info.createSpan({ cls: "nlm-tb-icon" }), "graduation-cap");
        const parts: string[] = [];
        if (cards) parts.push(`${cards} flashcard${cards === 1 ? "" : "s"}`);
        if (questions) parts.push(`${questions} quiz question${questions === 1 ? "" : "s"}`);
        info.createSpan({ cls: "nlm-tb-title", text: parts.join(" · ") });

        const chips = info.createDiv({ cls: "nlm-chips" });
        chip(chips, "new", c.fresh, "New");
        chip(chips, "learning", c.learning, "Learning");
        chip(chips, "due", c.due, "Due");

        if (studyable.length) {
            const pct = Math.round((c.review / studyable.length) * 100);
            const progress = info.createDiv({ cls: "nlm-mini-progress", attr: { "aria-label": `${pct}% learned` } });
            progress.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
        }

        const actions = bar.createDiv({ cls: "nlm-tb-actions" });
        if (studyable.length) {
            const n = c.due + c.learning + Math.min(c.fresh, p.newLeftToday());
            const study = button(actions, "play", n ? `Study (${n})` : "Study", () => void p.openStudy({ path: file.path }));
            study.addClass("mod-cta");
        }
        if (questions) {
            button(actions, "list-checks", "Practice quiz", () => void p.openQuizPractice(file.path));
        }
        this.syncButton(actions, file);
    }

    private syncButton(actions: HTMLElement, file: TFile) {
        const deck = this.plugin.index.decks.get(file.path);
        if (!Platform.isDesktopApp || !deck?.notebookId || !deck.artifactId) return;
        const b = button(actions, "refresh-cw", "", async () => {
            b.addClass("is-loading");
            b.disabled = true;
            await this.plugin.resyncAll([file.path]);
            b.removeClass("is-loading");
            b.disabled = false;
        });
        b.setAttr("aria-label", "Update from NotebookLM");
    }
}

function button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "nlm-tb-btn" });
    setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
    if (label) b.createSpan({ text: label });
    b.onclick = onClick;
    return b;
}

export function chip(parent: HTMLElement, kind: string, n: number, label: string) {
    const c = parent.createSpan({ cls: `nlm-chip nlm-chip-${kind}`, attr: { "aria-label": label } });
    c.createSpan({ cls: "nlm-chip-dot" });
    c.createSpan({ text: `${n} ${label.toLowerCase()}` });
}
