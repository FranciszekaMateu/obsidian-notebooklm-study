import { Platform, TFile, setIcon } from "obsidian";
import { CardSource, pageOf } from "./card-maker";
import { t } from "./i18n";
import type NotebookLMStudy from "./main";

export interface TextSelection {
    text: string;
    source?: CardSource;
}

/**
 * Remembers the last text selected in a note or PDF (clicking into the
 * sidebar would otherwise lose it) and, in the PDF viewer, shows a small
 * floating bar to turn the selection into a card or ask NotebookLM about it.
 */
export class SelectionToolbar {
    private last: TextSelection = { text: "" };
    private bar: HTMLElement | null = null;

    constructor(private plugin: NotebookLMStudy) {
        plugin.registerDomEvent(document, "mouseup", e => window.setTimeout(() => this.onSelect(e), 10));
        plugin.registerDomEvent(document, "keyup", e => { if (e.shiftKey) this.capture(); });
        plugin.registerDomEvent(document, "mousedown", e => { if (!this.bar?.contains(e.target as Node)) this.hide(); });
        plugin.registerDomEvent(document, "scroll", () => this.hide(), { capture: true });
        plugin.register(() => this.hide());
    }

    /** The current selection, else the last one made in a note or PDF. */
    selection(): TextSelection {
        return this.capture() ?? this.last;
    }

    /** Read the DOM selection and, if it is inside a note or PDF, remember it. */
    private capture(): TextSelection | null {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || !sel.anchorNode) return null;
        const file = this.fileAt(sel.anchorNode);
        if (!file) return null;
        this.last = { text, source: { file, page: file.extension === "pdf" ? pageOf(sel) : undefined } };
        return this.last;
    }

    /** The note or PDF whose view contains this node. */
    private fileAt(node: Node): TFile | null {
        let found: TFile | null = null;
        this.plugin.app.workspace.iterateAllLeaves(leaf => {
            const file = (leaf.view as { file?: TFile | null }).file;
            if (!found && file && leaf.view.containerEl.contains(node)) found = file;
        });
        return found;
    }

    private onSelect(e: MouseEvent) {
        if (this.bar?.contains(e.target as Node)) return;
        const sel = this.capture();
        if (!sel || sel.source?.file.extension !== "pdf") return;
        const range = window.getSelection()?.getRangeAt(0);
        if (range) this.show(range.getBoundingClientRect(), sel);
    }

    private show(rect: DOMRect, sel: TextSelection) {
        this.hide();
        const bar = document.body.createDiv({ cls: "nlm-sel-bar" });
        const button = (icon: string, label: string, fn: () => void) => {
            const b = bar.createEl("button");
            setIcon(b.createSpan({ cls: "nlm-btn-icon" }), icon);
            b.createSpan({ text: label });
            b.onmousedown = ev => ev.preventDefault(); // keep the selection
            b.onclick = () => { this.hide(); fn(); };
        };
        button("square-plus", t("Card"), () => void this.plugin.openSidebar("card", { selection: sel }));
        if (Platform.isDesktopApp) button("message-circle-question", t("Ask"), () => void this.plugin.openSidebar("ask", { question: sel.text }));

        const top = rect.top - 40 < 8 ? rect.bottom + 8 : rect.top - 40;
        bar.style.top = `${top}px`;
        bar.style.left = `${Math.max(8, Math.min(window.innerWidth - 220, rect.left + rect.width / 2 - 80))}px`;
        this.bar = bar;
    }

    private hide() {
        this.bar?.remove();
        this.bar = null;
    }
}
