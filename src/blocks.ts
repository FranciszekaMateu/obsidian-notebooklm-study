import { Component, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, TFile, setIcon } from "obsidian";
import { CLOZE_CALLOUT, QUIZ_CALLOUT } from "./callouts";
import { findClozes } from "./cloze";
import { t, tn } from "./i18n";
import type NotebookLMStudy from "./main";
import { countNodes, parseOutline } from "./mindmap";
import { MindMapNode, QuizQuestion, StudyItem, itemAnswer, itemPrompt } from "./types";

export function registerBlocks(plugin: NotebookLMStudy) {
    plugin.registerMarkdownPostProcessor(el => {
        el.querySelectorAll<HTMLElement>(`.callout[data-callout="${QUIZ_CALLOUT}"]`).forEach(enhanceQuizCallout);
        el.querySelectorAll<HTMLElement>(`.callout[data-callout="${CLOZE_CALLOUT}"]`).forEach(enhanceClozeCallout);
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

function onPress(el: HTMLElement, handler: (e: MouseEvent) => void) {
    el.addEventListener("mousedown", swallow, true);
    el.addEventListener("click", e => { swallow(e); handler(e); }, true);
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

    const hintP = Array.from(content.querySelectorAll("p")).find(p => /^\s*(hint|pista)\s*:/i.test(p.textContent ?? ""));
    if (hintP) {
        hintP.addClass("nlm-hint", "is-hidden");
        const hintBtn = createEl("button", { cls: "nlm-chip-btn", text: t("Show hint") });
        hintP.before(hintBtn);
        onPress(hintBtn, () => {
            hintP.removeClass("is-hidden");
            hintBtn.remove();
        });
    }

    const footer = content.createDiv({ cls: "nlm-q-footer" });
    const result = footer.createSpan({ cls: "nlm-q-result" });
    const reset = footer.createEl("button", { cls: "nlm-chip-btn", text: t("Try again") });
    reset.hide();

    options.forEach((li, i) => {
        li.addEventListener("mousedown", swallow, true);
        li.addEventListener("click", e => {
            if ((e.target as HTMLElement).closest("a")) return;
            swallow(e);
            if (callout.hasClass("is-answered")) return;
            callout.addClass("is-answered");
            options.forEach((o, j) => o.addClass(correct[j] ? "is-correct" : j === i ? "is-wrong" : "is-dim"));
            result.setText(correct[i] ? t("Correct") : t("Not quite"));
            result.toggleClass("is-ok", correct[i]);
            result.toggleClass("is-bad", !correct[i]);
            reset.show();
        }, true);
    });
    onPress(reset, () => {
        callout.removeClass("is-answered");
        options.forEach(li => li.removeClass("is-correct", "is-wrong", "is-dim"));
        result.setText("");
        reset.hide();
    });
}

// --- Cloze callouts ---------------------------------------------------------

/** Hide {{deletions}} inside `> [!cloze]` callouts; click one to reveal it. */
function enhanceClozeCallout(callout: HTMLElement) {
    if (callout.dataset.nlmCloze) return;
    const content = callout.querySelector<HTMLElement>(".callout-content");
    if (!content) return;
    callout.dataset.nlmCloze = "1";

    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let found = 0;
    for (const node of nodes) {
        const spans = findClozes(node.data);
        if (!spans.length) continue;
        const frag = document.createDocumentFragment();
        let pos = 0;
        for (const s of spans) {
            frag.append(node.data.slice(pos, s.start));
            const el = createSpan({ cls: "nlm-cloze", text: s.answer, attr: { "data-group": String(s.group), "aria-label": s.hint ?? t("Click to reveal") } });
            onPress(el, () => el.toggleClass("is-revealed", !el.hasClass("is-revealed")));
            frag.append(el);
            pos = s.end;
            found++;
        }
        frag.append(node.data.slice(pos));
        node.replaceWith(frag);
    }
    if (!found) return;
    const footer = content.createDiv({ cls: "nlm-q-footer" });
    const toggle = footer.createEl("button", { cls: "nlm-chip-btn", text: t("Reveal all") });
    onPress(toggle, () => {
        const hidden = content.querySelectorAll(".nlm-cloze:not(.is-revealed)").length > 0;
        content.querySelectorAll(".nlm-cloze").forEach(c => c.toggleClass("is-revealed", hidden));
        toggle.setText(hidden ? t("Hide all") : t("Reveal all"));
    });
}

// --- Quiz question for the study view ----------------------------------------

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
        hintBtn = parent.createEl("button", { cls: "nlm-chip-btn", text: t("Show hint") });
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
        bar.createSpan({ text: t("These cards use the old code-block format.") });
        const btn = bar.createEl("button", { cls: "mod-cta", text: t("Convert to callouts") });
        btn.onclick = async () => {
            const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
            if (file instanceof TFile) await this.plugin.writer.convertLegacy(file);
        };
    }
}

// --- Mind map ---------------------------------------------------------------

const STOPWORDS = new Set([
    "para", "como", "with", "from", "that", "this", "these", "their", "between", "sobre", "entre", "desde", "hasta",
    "donde", "cuando", "porque", "pero", "tiene", "tienen", "esta", "este", "estos", "estas", "other", "otros", "otras",
    "the", "and", "las", "los", "del", "una", "uno", "unos", "unas", "por", "con", "sin", "más", "into", "used", "using",
]);

function words(s: string): string[] {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .split(/[^a-z0-9ñ]+/).filter(w => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * Interactive mind map: collapsible tree with zoom (Ctrl+wheel or buttons),
 * drag to pan, full screen, and per-node links to related cards.
 */
class MindMapBlock extends MarkdownRenderChild {
    private scale = 1;
    private userZoomed = false;
    private x = 0;
    private y = 0;
    private treeEl!: HTMLElement;
    private viewport!: HTMLElement;
    private related!: HTMLElement;
    private corpus: { item: StudyItem; words: Set<string> }[] = [];

    constructor(private plugin: NotebookLMStudy, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) {
        super(el);
    }

    onload() {
        const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
        const fallback = file instanceof TFile ? file.basename : t("Mind map");
        const tree = parseOutline(this.src, fallback);
        this.corpus = this.relatedCorpus();

        const root = this.containerEl.createDiv({ cls: "nlm-block nlm-mindmap" });
        const header = root.createDiv({ cls: "nlm-block-header" });
        const title = header.createDiv({ cls: "nlm-block-title" });
        setIcon(title.createSpan(), "network");
        title.createSpan({ text: t("Mind map · {n} nodes", { n: countNodes(tree) }) });

        const actions = header.createDiv({ cls: "nlm-actions" });
        const tool = (icon: string, label: string, fn: () => void) => {
            const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
            setIcon(b, icon);
            onPress(b, fn);
        };
        tool("zoom-out", t("Zoom out"), () => this.zoom(1 / 1.2));
        tool("zoom-in", t("Zoom in"), () => this.zoom(1.2));
        tool("scan", t("Fit to width"), () => { this.userZoomed = false; this.fit(); });
        tool("chevrons-down-up", t("Collapse"), () => this.treeEl.querySelectorAll<HTMLElement>(".nlm-mm-node").forEach(n => {
            n.toggleClass("is-collapsed", Number(n.dataset.depth) >= 1 && n.hasClass("has-children"));
        }));
        tool("chevrons-up-down", t("Expand all"), () => this.treeEl.querySelectorAll(".nlm-mm-node").forEach(n => n.removeClass("is-collapsed")));
        tool("maximize", t("Full screen"), () => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void root.requestFullscreen?.();
        });
        const canvasPath = this.ctx.sourcePath.replace(/\.md$/, ".canvas");
        if (this.plugin.app.vault.getAbstractFileByPath(canvasPath)) {
            tool("layout-dashboard", t("Open canvas"), () => void this.plugin.app.workspace.openLinkText(canvasPath, this.ctx.sourcePath, "tab"));
        }

        const body = root.createDiv({ cls: "nlm-mm-body" });
        this.viewport = body.createDiv({ cls: "nlm-mm-viewport" });
        this.treeEl = this.viewport.createDiv({ cls: "nlm-mm-tree" });
        this.related = body.createDiv({ cls: "nlm-mm-related" });
        this.related.hide();
        this.renderNode(tree, this.treeEl, 0);
        this.enablePanZoom();
        // Fit whenever the note is resized (or first shown), until the user zooms by hand.
        const ro = new ResizeObserver(() => { if (!this.userZoomed) this.fit(); });
        ro.observe(this.viewport);
        this.register(() => ro.disconnect());
        root.createDiv({ cls: "nlm-muted nlm-small nlm-mm-help", text: t("Drag to move · Ctrl + wheel to zoom · click a node to fold it · the card badge shows related cards") });
    }

    /** Cards from the same notebook (or, failing that, the same folder) as this mind map. */
    private relatedCorpus(): { item: StudyItem; words: Set<string> }[] {
        const idx = this.plugin.index;
        const me = idx.decks.get(this.ctx.sourcePath);
        const folder = this.ctx.sourcePath.split("/").slice(0, -1).join("/");
        const decks = idx.list().filter(d => d.items.length && (me?.notebookId ? d.notebookId === me.notebookId : d.path.startsWith(`${folder}/`)));
        return decks.flatMap(d => d.items).map(item => ({ item, words: new Set(words(`${itemPrompt(item)} ${itemAnswer(item)}`)) }));
    }

    private relatedTo(name: string): StudyItem[] {
        const w = [...new Set(words(name))];
        if (!w.length) return [];
        const need = Math.max(1, Math.ceil(w.length * 0.5));
        return this.corpus
            .map(c => ({ item: c.item, score: w.filter(x => c.words.has(x)).length }))
            .filter(s => s.score >= need)
            .sort((a, b) => b.score - a.score)
            .map(s => s.item);
    }

    private renderNode(node: MindMapNode, parent: HTMLElement, depth: number) {
        const wrap = parent.createDiv({ cls: "nlm-mm-node" });
        wrap.dataset.depth = String(depth);
        wrap.addClass(`nlm-mm-depth-${Math.min(depth, 5)}`);

        const label = wrap.createDiv({ cls: "nlm-mm-label" });
        label.createSpan({ text: node.name });

        const cards = depth > 0 ? this.relatedTo(node.name) : [];
        if (cards.length) {
            const badge = label.createSpan({ cls: "nlm-mm-cards", attr: { "aria-label": tn(cards.length, "{n} related card", "{n} related cards") } });
            setIcon(badge.createSpan(), "layers");
            badge.createSpan({ text: String(cards.length) });
            onPress(badge, () => this.showRelated(node.name, cards));
        }

        if (node.children.length) {
            wrap.addClass("has-children");
            if (depth >= 2) wrap.addClass("is-collapsed");
            label.createSpan({ cls: "nlm-mm-badge", text: String(node.children.length), attr: { "aria-hidden": "true" } });
            label.setAttr("role", "button");
            label.setAttr("tabindex", "0");
            onPress(label, e => {
                if ((e.target as HTMLElement).closest(".nlm-mm-cards")) return;
                wrap.toggleClass("is-collapsed", !wrap.hasClass("is-collapsed"));
            });
            label.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wrap.toggleClass("is-collapsed", !wrap.hasClass("is-collapsed")); } };

            const kids = wrap.createDiv({ cls: "nlm-mm-children" });
            node.children.forEach(c => this.renderNode(c, kids, depth + 1));
        }
    }

    private showRelated(topic: string, cards: StudyItem[]) {
        const el = this.related;
        el.empty();
        el.show();
        const head = el.createDiv({ cls: "nlm-mm-related-head" });
        head.createDiv({ cls: "nlm-panel-title", text: topic });
        const close = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("Close") } });
        setIcon(close, "x");
        onPress(close, () => el.hide());
        el.createDiv({ cls: "nlm-muted nlm-small", text: tn(cards.length, "{n} related card", "{n} related cards") });
        const list = el.createEl("ul");
        for (const c of cards.slice(0, 12)) {
            const li = list.createEl("li");
            const a = li.createEl("a", { text: truncate(itemPrompt(c), 90) });
            onPress(a, () => {
                const f = this.plugin.app.vault.getAbstractFileByPath(c.path);
                if (f instanceof TFile) void this.plugin.app.workspace.getLeaf("split").openFile(f, c.line !== undefined ? { eState: { line: c.line } } : undefined);
            });
        }
        if (cards.length > 12) list.createEl("li", { cls: "nlm-muted", text: t("and {n} more", { n: cards.length - 12 }) });
        const study = el.createEl("button", { cls: "mod-cta", text: t("Study these ({n})", { n: cards.length }) });
        onPress(study, () => void this.plugin.openStudy({ ids: cards.map(c => c.id), title: topic }));
    }

    private apply() {
        this.treeEl.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    }

    /** Shrink a map wider than the note so it is all visible (never below 50%). */
    private fit() {
        const avail = this.viewport.clientWidth;
        const width = this.treeEl.scrollWidth;
        this.scale = avail > 0 && width > avail ? Math.max(0.5, avail / width) : 1;
        this.x = 0;
        this.y = 0;
        this.apply();
    }

    private zoom(factor: number) {
        this.userZoomed = true;
        this.scale = Math.min(3, Math.max(0.3, this.scale * factor));
        this.apply();
    }

    private enablePanZoom() {
        const vp = this.viewport;
        vp.addEventListener("wheel", e => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });

        let dragging = false;
        let moved = false;
        let sx = 0, sy = 0, ox = 0, oy = 0;
        vp.addEventListener("pointerdown", e => {
            if (e.button !== 0) return;
            dragging = true;
            moved = false;
            sx = e.clientX; sy = e.clientY; ox = this.x; oy = this.y;
        });
        vp.addEventListener("pointermove", e => {
            if (!dragging) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            if (!moved) { moved = true; vp.setPointerCapture(e.pointerId); vp.addClass("is-panning"); }
            this.x = ox + dx;
            this.y = oy + dy;
            this.apply();
        });
        const end = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            vp.removeClass("is-panning");
            if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
        };
        vp.addEventListener("pointerup", end);
        vp.addEventListener("pointercancel", end);
        // A drag must not also fold the node it ended on.
        vp.addEventListener("click", e => { if (moved) { swallow(e); moved = false; } }, true);
        // Keep Live Preview from entering the block's source on click.
        vp.addEventListener("mousedown", swallow);
    }
}

function truncate(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
