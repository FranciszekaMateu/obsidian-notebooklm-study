import { MarkdownView, Platform, TFile, setIcon } from "obsidian";
import { kindLabel } from "./generate";
import { t, tn } from "./i18n";
import { sourceLinks } from "./sources";
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

        if (!deck.items.length) {
            // Mind maps and media notes.
            const icon = { mindmap: "network", audio: "audio-lines", report: "file-text", infographic: "image", slides: "presentation" }[deck.type as string] ?? "file";
            setIcon(info.createSpan({ cls: "nlm-tb-icon" }), icon);
            info.createSpan({ cls: "nlm-tb-title", text: kindLabel(deck.type === "mindmap" ? "mind_map" : deck.type === "slides" ? "slide_deck" : deck.type) });
            if (deck.notebookTitle) info.createSpan({ cls: "nlm-muted", text: deck.notebookTitle });
            const actions = bar.createDiv({ cls: "nlm-tb-actions" });
            const canvas = file.path.replace(/.md$/, ".canvas");
            if (deck.type === "mindmap" && p.app.vault.getAbstractFileByPath(canvas)) {
                button(actions, "layout-dashboard", t("Open canvas"), () => void p.app.workspace.openLinkText(canvas, file.path, "tab"));
            }
            this.sourceButton(actions, file);
            this.askButton(actions, file);
            if (deck.type === "mindmap") this.syncButton(actions, file);
            return;
        }

        const count = (k: string) => deck.items.filter(i => i.kind === k).length;
        const questions = count("quiz");
        const studyable = p.filterStudyable(deck.items);
        const c = p.stateCounts(studyable.map(i => i.id));

        setIcon(info.createSpan({ cls: "nlm-tb-icon" }), "graduation-cap");
        const parts: string[] = [];
        if (count("flashcard")) parts.push(tn(count("flashcard"), "{n} flashcard", "{n} flashcards"));
        if (count("cloze")) parts.push(tn(count("cloze"), "{n} cloze", "{n} clozes"));
        if (questions) parts.push(tn(questions, "{n} quiz question", "{n} quiz questions"));
        info.createSpan({ cls: "nlm-tb-title", text: parts.join(" · ") });

        const chips = info.createDiv({ cls: "nlm-chips" });
        chip(chips, "new", c.fresh, t("New"));
        chip(chips, "learning", c.learning, t("Learning"));
        chip(chips, "due", c.due, t("Due"));

        if (studyable.length) {
            const pct = Math.round((c.review / studyable.length) * 100);
            const progress = info.createDiv({ cls: "nlm-mini-progress", attr: { "aria-label": t("{pct}% learned", { pct }) } });
            progress.createDiv({ cls: "nlm-mini-progress-bar" }).style.width = `${pct}%`;
        }

        const actions = bar.createDiv({ cls: "nlm-tb-actions" });
        if (studyable.length) {
            const n = c.due + c.learning + Math.min(c.fresh, p.newLeftToday());
            const study = button(actions, "play", n ? t("Study ({n})", { n }) : t("Study"), () => void p.openStudy({ path: file.path }));
            study.addClass("mod-cta");
        }
        if (questions) {
            button(actions, "list-checks", t("Practice quiz"), () => void p.openQuizPractice(file.path));
            button(actions, "timer", t("Exam"), () => void p.openExamSetup([file.path]));
        }
        this.sourceButton(actions, file);
        this.askButton(actions, file);
        this.syncButton(actions, file);
    }

    /** Open the PDF / note the content was generated from, next to this note. */
    private sourceButton(actions: HTMLElement, file: TFile) {
        const deck = this.plugin.index.decks.get(file.path);
        const sources = deck ? sourceLinks(this.plugin.app, deck.sourceFiles, file.path) : [];
        if (!sources.length) return;
        const first = sources[0];
        const b = button(actions, first.extension === "pdf" ? "file-type-2" : "file-text", first.extension === "pdf" ? t("Open PDF") : t("Open source"), () => {
            void this.plugin.app.workspace.getLeaf("split").openFile(first);
        });
        b.setAttr("aria-label", sources.map(s => s.name).join(", "));
    }

    /** Generate / ask buttons for notes linked to a notebook (desktop only). */
    private askButton(actions: HTMLElement, file: TFile) {
        const deck = this.plugin.index.decks.get(file.path);
        if (!Platform.isDesktopApp || !deck?.notebookId) return;
        const b = button(actions, "message-circle", "", () => void this.plugin.openSidebar("ask"));
        b.setAttr("aria-label", t("Ask this notebook"));
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
        b.setAttr("aria-label", t("Update from NotebookLM"));
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
