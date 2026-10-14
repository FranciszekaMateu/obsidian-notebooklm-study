import { Component, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, TFile, setIcon } from "obsidian";
import type NotebookLMStudy from "./main";
import { countNodes, parseOutline } from "./mindmap";
import { parseFlashcards, parseQuiz } from "./notes";
import { MindMapNode, QuizQuestion } from "./types";

export function registerBlocks(plugin: NotebookLMStudy) {
    plugin.registerMarkdownCodeBlockProcessor("nlm-flashcards", (src, el, ctx) => {
        ctx.addChild(new FlashcardsBlock(plugin, el, src, ctx));
    });
    plugin.registerMarkdownCodeBlockProcessor("nlm-quiz", (src, el, ctx) => {
        ctx.addChild(new QuizBlock(plugin, el, src, ctx));
    });
    plugin.registerMarkdownCodeBlockProcessor("nlm-mindmap", (src, el, ctx) => {
        ctx.addChild(new MindMapBlock(plugin, el, src, ctx));
    });
}

async function renderMd(plugin: NotebookLMStudy, md: string, el: HTMLElement, sourcePath: string, owner: Component) {
    el.empty();
    await MarkdownRenderer.render(plugin.app, md, el, sourcePath, owner);
}

// --- Flashcards -------------------------------------------------------------

class FlashcardsBlock extends MarkdownRenderChild {
    private index = 0;
    private flipped = false;

    constructor(private plugin: NotebookLMStudy, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) {
        super(el);
    }

    onload() {
        this.render();
        // Refresh due counts after reviews.
        this.registerEvent(this.plugin.index.on("changed", () => this.renderHeader()));
        this.registerEvent(this.plugin.index.on("reviewed", () => this.renderHeader()));
    }

    private header!: HTMLElement;

    private render() {
        const cards = parseFlashcards(this.src);
        const root = this.containerEl.createDiv({ cls: "nlm-block nlm-deck" });
        this.header = root.createDiv({ cls: "nlm-block-header" });
        this.renderHeader();

        if (!cards.length) {
            root.createDiv({ cls: "nlm-empty", text: "No cards. Add them as Q: / A: lines." });
            return;
        }

        const card = root.createDiv({ cls: "nlm-flipcard", attr: { tabindex: "0", "aria-label": "Flip card" } });
        const face = card.createDiv({ cls: "nlm-flipcard-face" });
        const side = card.createDiv({ cls: "nlm-flipcard-side" });

        const nav = root.createDiv({ cls: "nlm-nav" });
        const prev = nav.createEl("button", { attr: { "aria-label": "Previous card" } });
        setIcon(prev, "chevron-left");
        const counter = nav.createSpan({ cls: "nlm-counter" });
        const next = nav.createEl("button", { attr: { "aria-label": "Next card" } });
        setIcon(next, "chevron-right");

        const show = async () => {
            const c = cards[this.index];
            side.setText(this.flipped ? "Answer" : "Question");
            card.toggleClass("is-flipped", this.flipped);
            counter.setText(`${this.index + 1} / ${cards.length}`);
            await renderMd(this.plugin, this.flipped ? c.back : c.front, face, this.ctx.sourcePath, this);
        };
        const go = (delta: number) => {
            this.index = (this.index + delta + cards.length) % cards.length;
            this.flipped = false;
            void show();
        };

        card.onclick = (e) => {
            if ((e.target as HTMLElement).closest("a")) return;
            this.flipped = !this.flipped;
            void show();
        };
        card.onkeydown = (e) => {
            if (e.key === " " || e.key === "Enter") { e.preventDefault(); card.click(); }
            if (e.key === "ArrowRight") go(1);
            if (e.key === "ArrowLeft") go(-1);
        };
        prev.onclick = () => go(-1);
        next.onclick = () => go(1);
        void show();
    }

    private renderHeader() {
        if (!this.header) return;
        const h = this.header;
        h.empty();
        const deck = this.plugin.index.decks.get(this.ctx.sourcePath);
        const ids = deck?.items.map(i => i.id) ?? parseFlashcards(this.src).map(c => c.id as string);
        const { fresh, due } = this.plugin.countDue(ids);

        const title = h.createDiv({ cls: "nlm-block-title" });
        setIcon(title.createSpan(), "layers");
        title.createSpan({ text: `${ids.length} flashcards` });

        const counts = h.createDiv({ cls: "nlm-counts" });
        counts.createSpan({ cls: "nlm-count-new", text: `${fresh} new` });
        counts.createSpan({ cls: "nlm-count-due", text: `${due} due` });

        const btn = h.createEl("button", { cls: "mod-cta", text: "Study" });
        btn.onclick = () => this.plugin.openStudy({ path: this.ctx.sourcePath });
    }
}

// --- Quiz -------------------------------------------------------------------

class QuizBlock extends MarkdownRenderChild {
    private questions: QuizQuestion[] = [];
    private order: number[] = [];
    private pos = 0;
    private correct = 0;
    private missed: number[] = [];

    constructor(private plugin: NotebookLMStudy, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) {
        super(el);
    }

    onload() {
        this.questions = parseQuiz(this.src);
        this.start(this.questions.map((_, i) => i));
    }

    private start(order: number[]) {
        this.order = order;
        this.pos = 0;
        this.correct = 0;
        this.missed = [];
        void this.renderQuestion();
    }

    private shell(): HTMLElement {
        this.containerEl.empty();
        const root = this.containerEl.createDiv({ cls: "nlm-block nlm-quiz" });
        const header = root.createDiv({ cls: "nlm-block-header" });
        const title = header.createDiv({ cls: "nlm-block-title" });
        setIcon(title.createSpan(), "list-checks");
        title.createSpan({ text: `Quiz · ${this.questions.length} questions` });
        if (this.plugin.settings.includeQuizInReview) {
            const btn = header.createEl("button", { text: "Review with SRS" });
            btn.onclick = () => this.plugin.openStudy({ path: this.ctx.sourcePath });
        }
        return root;
    }

    private async renderQuestion() {
        const root = this.shell();
        if (!this.questions.length) {
            root.createDiv({ cls: "nlm-empty", text: "No questions. Add them as Q: lines with - [x] / - [ ] options." });
            return;
        }
        if (this.pos >= this.order.length) {
            this.renderResult(root);
            return;
        }

        const q = this.questions[this.order[this.pos]];
        const progress = root.createDiv({ cls: "nlm-progress" });
        progress.createDiv({ cls: "nlm-progress-bar" }).style.width = `${(this.pos / this.order.length) * 100}%`;
        root.createDiv({ cls: "nlm-quiz-meta", text: `Question ${this.pos + 1} of ${this.order.length} · ${this.correct} correct` });

        await renderQuizQuestion(this.plugin, root, q, this.ctx.sourcePath, this, (wasCorrect) => {
            if (wasCorrect) this.correct++;
            else this.missed.push(this.order[this.pos]);
            const next = root.createEl("button", {
                cls: "mod-cta nlm-next",
                text: this.pos + 1 < this.order.length ? "Next question" : "See results",
            });
            next.onclick = () => { this.pos++; void this.renderQuestion(); };
            next.focus();
        });
    }

    private renderResult(root: HTMLElement) {
        const total = this.order.length;
        const pct = Math.round((this.correct / total) * 100);
        const result = root.createDiv({ cls: "nlm-quiz-result" });
        result.createDiv({ cls: "nlm-quiz-score", text: `${pct}%` });
        result.createDiv({ text: `${this.correct} of ${total} correct` });

        const actions = result.createDiv({ cls: "nlm-actions" });
        actions.createEl("button", { text: "Restart" }).onclick = () => this.start(this.questions.map((_, i) => i));
        actions.createEl("button", { text: "Shuffle" }).onclick = () => this.start(shuffle(this.questions.map((_, i) => i)));
        if (this.missed.length) {
            actions.createEl("button", { cls: "mod-cta", text: `Retry ${this.missed.length} missed` })
                .onclick = () => this.start([...this.missed]);
        }
    }
}

/**
 * Shared by the quiz block and the review session: renders a question with
 * clickable options and reveals correctness + rationales on answer.
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
        hintBtn = parent.createEl("button", { cls: "nlm-hint-btn", text: "Show hint" });
        hintBtn.onclick = () => {
            hintBtn?.replaceWith(createDiv({ cls: "nlm-hint", text: hint }));
            hintBtn = null;
        };
    }

    return { answerWith };
}

function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
