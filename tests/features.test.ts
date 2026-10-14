import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { FSRSAlgorithm, FSRSState, default_w } from "ts-fsrs";
import { parseCallouts, serializeCallouts } from "../src/callouts";
import { clozeGroups, clozePlain, findClozes, renderCloze } from "../src/cloze";
import { ES } from "../src/i18n-es";
import { parseJSON } from "../src/parsers/json";
import { normalizeMath } from "../src/parsers/rich-text";
import { buildDataset, evaluate, optimize } from "../src/srs/optimizer";
import type { ReviewEntry } from "../src/srs/scheduler";

test("cloze: groups, explicit numbers, hints and rendering", () => {
    const text = "The {{mitochondrion}} makes {{c3::ATP::energy}} and {{ribosomes}} make {{c3::proteins}}.";
    const spans = findClozes(text);
    assert.deepEqual(spans.map(s => s.group), [1, 3, 2, 3]);
    assert.equal(spans[1].hint, "energy");
    assert.deepEqual(clozeGroups(text), [1, 2, 3]);
    assert.equal(clozePlain(text), "The mitochondrion makes ATP and ribosomes make proteins.");

    const front = renderCloze(text, 3, "front");
    assert.match(front, /The mitochondrion makes <span class="nlm-cloze-blank">\[energy\]<\/span>/);
    assert.match(front, /make <span class="nlm-cloze-blank">\[…\]<\/span>\.$/);
    const back = renderCloze(text, 3, "back");
    assert.match(back, /<span class="nlm-cloze-answer">ATP<\/span>/);
    assert.match(back, /ribosomes make <span class="nlm-cloze-answer">proteins<\/span>/);
});

test("cloze and reverse callouts round-trip", () => {
    const md = serializeCallouts({
        cards: [{ front: "Mitochondrion", back: "Makes ATP", reverse: true }],
        clozes: [{ title: "Cells", text: "The {{nucleus}} holds {{DNA}}." }],
    });
    assert.match(md, /^> \[!flashcard\|fc-[a-z0-9]+\|reverse\]- Mitochondrion$/m);
    assert.match(md, /^> \[!cloze\|cz-[a-z0-9]+\] Cells$/m);
    const p = parseCallouts(md);
    assert.equal(p.cards[0].reverse, true);
    assert.equal(p.clozes.length, 1);
    assert.equal(p.clozes[0].text, "The {{nucleus}} holds {{DNA}}.");

    // Hand-written, no id, no title; a cloze callout without deletions is ignored.
    const hand = parseCallouts("> [!cloze]\n> Water boils at {{100 °C}}.\n\n> [!cloze]\n> nothing to hide\n\n> [!flashcard|reverse] A\n> B");
    assert.equal(hand.clozes.length, 1);
    assert.equal(hand.clozes[0].title, "");
    assert.match(hand.clozes[0].id!, /^cz-/);
    assert.equal(hand.cards[0].reverse, true);
});

test("json: NotebookLM's block-based flashcards (real download) and math normalisation", () => {
    const raw = readFileSync(join(__dirname, "..", "tests", "fixtures-flashcards-blocks.json"), "utf8");
    const p = parseJSON(raw, "flashcards");
    assert.equal(p.type, "flashcards");
    if (p.type !== "flashcards") return;
    assert.equal(p.title, "Fotosíntesis Tarjetas");
    assert.equal(p.cards.length, 6);
    assert.equal(p.cards[0].front, "¿En qué tipo de energía se transforma la luz solar mediante la fotosíntesis?");
    assert.equal(p.cards[0].back, "Energía química");

    const mixed = parseJSON(JSON.stringify({ cards: [{
        front: { flashcardContentBlock: [{ type: "text", content: "Area of a circle?" }, { type: "latex", content: "A = \\pi r^2" }] },
        back: "It is \\\\(\\pi r^2\\\\), see \\[x^2\\]",
    }] }));
    assert.equal(mixed.type === "flashcards" && mixed.cards[0].front, "Area of a circle?\n\n$A = \\pi r^2$");
    assert.equal(mixed.type === "flashcards" && mixed.cards[0].back, "It is $\\pi r^2$, see $$x^2$$");
    assert.equal(normalizeMath("transforma CO2 (\\\\(CO_2\\\\)) y agua"), "transforma CO2 ($CO_2$) y agua");
});

/** Deterministic PRNG so the optimizer test is stable. */
function rng(seed: number) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

test("optimizer: recovers a better fit on simulated reviews", async () => {
    const DAY = 86_400_000;
    // The "true" memory: much stronger initial stability than the defaults.
    const trueW = [...default_w];
    trueW[0] = 2; trueW[1] = 6; trueW[2] = 15; trueW[3] = 40;
    const truth = new FSRSAlgorithm({ w: trueW, enable_short_term: true });
    const rand = rng(42);
    const log: ReviewEntry[] = [];
    for (let c = 0; c < 250; c++) {
        let day = c % 30;
        let g = rand() < 0.8 ? 3 : 1;
        let state: FSRSState = truth.next_state(null, 0, g);
        log.push({ id: `c${c}`, t: day * DAY, rating: g as 1 | 3, state: 0 });
        for (let k = 0; k < 5; k++) {
            // Review at a varied fraction of the stability so recall really varies.
            const ivl = Math.max(1, Math.round(state.stability * (0.5 + rand() * 2.5)));
            day += ivl;
            const r = truth.forgetting_curve(ivl, state.stability);
            g = rand() < r ? 3 : 1;
            log.push({ id: `c${c}`, t: day * DAY, rating: g as 1 | 3, state: 2 });
            state = truth.next_state(state, ivl, g);
        }
    }
    const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
    const data = buildDataset(log, dayStart);
    assert.equal(data.sequences.length, 250);
    assert.equal(data.labelled, 250 * 5);

    const trueLoss = evaluate(trueW, data).logLoss;
    const res = await optimize(log, dayStart, default_w, undefined, 40);
    assert.ok(res.after.logLoss < res.before.logLoss, `loss ${res.before.logLoss} -> ${res.after.logLoss}`);
    // Closes most of the gap to the true parameters.
    const gap = res.before.logLoss - trueLoss;
    assert.ok(res.after.logLoss - trueLoss < gap * 0.5, `before ${res.before.logLoss}, after ${res.after.logLoss}, true ${trueLoss}`);
    assert.equal(res.weights.length, default_w.length);

    await assert.rejects(() => optimize(log.slice(0, 20), dayStart), /Not enough review history/);
});

test("i18n: every UI string has a Spanish translation", () => {
    const files: string[] = [];
    const walk = (d: string) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else if (p.endsWith(".ts") && !p.endsWith("i18n-es.ts")) files.push(p);
        }
    };
    walk(join(__dirname, "..", "src"));

    const missing = new Set<string>();
    const lit = String.raw`"((?:[^"\\]|\\.)*)"`;
    const single = new RegExp(String.raw`\bt\(\s*` + lit, "g");
    const plural = new RegExp(String.raw`\btn\(\s*[^,]+,\s*` + lit + String.raw`\s*,\s*` + lit, "g");
    for (const f of files) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(single)) if (!(JSON.parse(`"${m[1]}"`) in ES)) missing.add(m[1]);
        for (const m of src.matchAll(plural)) {
            for (const s of [m[1], m[2]]) if (!(JSON.parse(`"${s}"`) in ES)) missing.add(s);
        }
    }
    assert.deepEqual([...missing].sort(), []);
});
