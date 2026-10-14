import { Component, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, TFile, setIcon } from "obsidian";
import { QUIZ_CALLOUT } from "./callouts";
import type NotebookLMStudy from "./main";
import { countNodes, parseOutline } from "./mindmap";
import { MindMapNode, QuizQuestion } from "./types";

export function registerBlocks(plugin: NotebookLMStudy) {
    plugin.registerMarkdownPostProcessor(el => {
        el.querySelectorAll<HTMLElement>(`.callout[data-callout="${QUIZ_CALLOUT}"]`).forEach(enhanceQuizCallout);
    });

    // Notes written by 2.0.0 keep their code blocks until converted.
    for (const lang of ["nlm-flashcards", "nlm-quiz"]) {
        plugin.registerMarkdownCodeBlockProcessor(lang, (_src, el, ctx) => {
            ctx.addChild(new LegacyBlock(plugin, el, ctx));
        });
    }
    plugin.registerMarkdownCodeBlockProcessor("nlm-mindmap", (src, el, ctx) => {
        ctx.addChild(new MindMapBlock(plugin, el, src, ctx));
    });
}

async function renderMd(plugin: NotebookLMStudy, md: string, el: HTMLElement, sourcePath: string, owner: Component) {
    el.empty();
    await MarkdownRenderer.render(plugin.app, md, el, sourcePath, owner);
}

/** Stop a click from reaching the editor (Live Preview would otherwise jump into the callout's source). */
function swallow(e: Event) {
    e.preventDefault();
    e.stopPropagation();
}

// --- Quiz callouts ----------------------------------------------------------

/**
 * Turns the task list inside a `> [!quiz]` callout into clickable answers.
 * The note itself is never modified: correctness is read from the rendered
 * checkboxes once, then the checkboxes are hidden.
 */
function enhanceQuizCallout(callout: HTMLElement) {
    if (callout.dataset.nlmQuiz) return;
    const content = callout.querySelector<HTMLElement>(".callout-content");
    const list = content?.querySelector<HTMLElement>("ul.contains-task-list, ul:has(> li.task-list-item)");
    if (!content || !list) return;
    const options = Array.from(list.children).filter((li): li is HTMLElement => li instanceof HTMLElement && li.matches("li.task-list-item"));
    if (!options.length) return;
    callout.dataset.nlmQuiz = "1";
    callout.addClass("nlm-quiz-callout");

    const correct = options.map(li => li.dataset.task === "x" || li.dataset.task === "X" || li.hasClass("is-checked"));
    options.forEach((li, i) => {
        li.removeClass("is-checked");
        li.removeAttribute("data-task");
        li.addClass("nlm-q-option");
        li.querySelector("input.task-list-item-checkbox")?.remove();
        li.prepend(createSpan({ cls: "nlm-option-key", text: String.fromCharCode(65 + i) }));
    });

    // Hide a "Hint:" paragraph behind a button.
    const hintP = Array.from(content.querySelectorAll("p")).find(p => /^\s*(hint|pista)\s*:/i.test(p.textContent ?? ""));
    let hintBtn: HTMLButtonElement | null = null;
    if (hintP) {
        hintP.addClass("nlm-hint", "is-hidden");
        hintBtn = createEl("button", { cls: "nlm-chip-btn", text: "Show hint" });
        hintP.before(hintBtn);
        hintBtn.addEventListener("mousedown", swallow, true);
        hintBtn.addEventListener("click", e => {
            swallow(e);
            hintP.removeClass("is-hidden");
            hintBtn?.remove();
        }, true);
    }

    const footer = content.createDiv({ cls: "nlm-q-footer" });
    const result = footer.createSpan({ cls: "nlm-q-result" });
    const reset = footer.createEl("button", { cls: "nlm-chip-btn", text: "Try again" });
    reset.hide();

    const answer = (index: number) => {
        if (callout.hasClass("is-answered")) return;
        callout.addClass("is-answered");
        options.forEach((li, i) => {
            li.addClass(correct[i] ? "is-correct" : i === index ? "is-wrong" : "is-dim");
        });
        const ok = correct[index];
        result.setText(ok ? "Correct" : "Not quite");
        result.toggleClass("is-ok", ok);
        result.toggleClass("is-bad", !ok);
        reset.show();
    };

    options.forEach((li, i) => {
        li.addEventListener("mousedown", swallow, true);
        li.addEventListener("click", e => {
            if ((e.target as HTMLElement).closest("a")) return;
            swallow(e);
            answer(i);
        }, true);
    });
    reset.addEventListener("mousedown", swallow, true);
    reset.addEventListener("click", e => {
        swallow(e);
        callout.removeClass("is-answered");
        options.forEach(li => li.removeClass("is-correct", "is-wrong", "is-dim"));
        result.setText("");
        reset.hide();
    }, true);
}

/**
 * Quiz question with clickable options, used by the study view for both the
 * SRS session and quiz practice.
 */
export async function renderQuizQuestion(
    plugin: NotebookLMStudy,
    parent: HTMLElement,
    q: QuizQuestion,
    sourcePath: string,
    owner: Component,
    onAnswer: (correct: boolean) => void,
): Promise<{ answerWith: (index: number) => void }> {
    const qEl = parent.createDiv({ cls: "nlm-quiz-question" });
    await renderMd(plugin, q.question, qEl, sourcePath, owner);

    const optionsEl = parent.createDiv({ cls: "nlm-quiz-options" });
    const buttons: HTMLButtonElement[] = [];
    let answered = false;
    let hintBtn: HTMLButtonElement | null = null;

    const answerWith = (index: number) => {
        if (answered || index < 0 || index >= q.options.length) return;
        answered = true;
        const chosen = q.options[index];
        q.options.forEach((o, i) => {
            const b = buttons[i];
            b.disabled = true;
            b.addClass(o.correct ? "is-correct" : i === index ? "is-wrong" : "is-dim");
            if (o.rationale && (o.correct || i === index)) {
                b.createDiv({ cls: "nlm-rationale", text: o.rationale });
            }
        });
        hintBtn?.remove();
        onAnswer(chosen.correct);
    };

    q.options.forEach((o, i) => {
        const b = optionsEl.createEl("button", { cls: "nlm-quiz-option" });
        b.createSpan({ cls: "nlm-option-key", text: String.fromCharCode(65 + i) });
        const label = b.createSpan({ cls: "nlm-option-text" });
        void renderMd(plugin, o.text, label, sourcePath, owner);
        b.onclick = () => answerWith(i);
        buttons.push(b);
    });

    if (q.hint) {
        const hint = q.hint;
        hintBtn = parent.createEl("button", { cls: "nlm-chip-btn", text: "Show hint" });
        hintBtn.onclick = () => {
            hintBtn?.replaceWith(createDiv({ cls: "nlm-hint", text: hint }));
            hintBtn = null;
        };
    }

    return { answerWith };
}

// --- Legacy code blocks -----------------------------------------------------

class LegacyBlock extends MarkdownRenderChild {
    constructor(private plugin: NotebookLMStudy, el: HTMLElement, private ctx: MarkdownPostProcessorContext) {
        super(el);
    }

    onload() {
        const bar = this.containerEl.createDiv({ cls: "nlm-legacy" });
        setIcon(bar.createSpan(), "info");
        bar.createSpan({ text: "These cards use the old code-block format." });
        const btn = bar.createEl("button", { cls: "mod-cta", text: "Convert to callouts" });
        btn.onclick = async () => {
            const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
            if (file instanceof TFile) await this.plugin.writer.convertLegacy(file);
        };
    }
}

// --- Mind map ---------------------------------------------------------------

class MindMapBlock extends MarkdownRenderChild {
    constructor(private plugin: NotebookLMStudy, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) {
        super(el);
    }

    onload() {
        const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
        const fallback = file instanceof TFile ? file.basename : "Mind map";
        const tree = parseOutline(this.src, fallback);

        const root = this.containerEl.createDiv({ cls: "nlm-block nlm-mindmap" });
        const header = root.createDiv({ cls: "nlm-block-header" });
        const title = header.createDiv({ cls: "nlm-block-title" });
        setIcon(title.createSpan(), "network");
        title.createSpan({ text: `Mind map · ${countNodes(tree)} nodes` });

        const actions = header.createDiv({ cls: "nlm-actions" });
        const expand = actions.createEl("button", { text: "Expand all" });
        const collapse = actions.createEl("button", { text: "Collapse" });
        const canvasPath = this.ctx.sourcePath.replace(/\.md$/, ".canvas");
        if (this.plugin.app.vault.getAbstractFileByPath(canvasPath)) {
            actions.createEl("button", { text: "Open canvas" }).onclick = () =>
                this.plugin.app.workspace.openLinkText(canvasPath, this.ctx.sourcePath, true);
        }

        const viewport = root.createDiv({ cls: "nlm-mm-viewport" });
        const treeEl = viewport.createDiv({ cls: "nlm-mm-tree" });
        this.renderNode(tree, treeEl, 0);

        expand.onclick = () => treeEl.querySelectorAll(".nlm-mm-node").forEach(n => n.removeClass("is-collapsed"));
        collapse.onclick = () => treeEl.querySelectorAll<HTMLElement>(".nlm-mm-node").forEach(n => {
            n.toggleClass("is-collapsed", Number(n.dataset.depth) >= 1 && n.hasClass("has-children"));
        });
    }

    private renderNode(node: MindMapNode, parent: HTMLElement, depth: number) {
        const wrap = parent.createDiv({ cls: "nlm-mm-node" });
        wrap.dataset.depth = String(depth);
        wrap.addClass(`nlm-mm-depth-${Math.min(depth, 5)}`);

        const label = wrap.createDiv({ cls: "nlm-mm-label" });
        label.createSpan({ text: node.name });

        if (node.children.length) {
            wrap.addClass("has-children");
            if (depth >= 2) wrap.addClass("is-collapsed");
            const badge = label.createSpan({ cls: "nlm-mm-badge", text: String(node.children.length) });
            badge.setAttr("aria-hidden", "true");
            label.onclick = () => wrap.toggleClass("is-collapsed", !wrap.hasClass("is-collapsed"));
            label.setAttr("role", "button");
            label.setAttr("tabindex", "0");
            label.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); label.click(); } };

            const kids = wrap.createDiv({ cls: "nlm-mm-children" });
            node.children.forEach(c => this.renderNode(c, kids, depth + 1));
        }
    }
}
