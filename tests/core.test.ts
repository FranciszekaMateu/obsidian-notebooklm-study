import { test } from "node:test";
import assert from "node:assert/strict";
import { Rating, State } from "ts-fsrs";
import { parseCSV } from "../src/parsers/csv";
import { parseJSON } from "../src/parsers/json";
import {
    buildFlashcardsNote, buildQuizNote, buildMindMapNote, carryOverIds,
    parseFlashcards, parseQuiz, serializeFlashcards, serializeQuiz,
} from "../src/notes";
import { parseCallouts, replaceRegion, serializeCallouts } from "../src/callouts";
import { convertLegacyContent, parseStudyContent } from "../src/study-content";
import { parseOutline, toCanvas, toOutline } from "../src/mindmap";
import { Scheduler, SrsData } from "../src/srs/scheduler";

const origin = { source: "notebooklm" as const, notebookId: "nb1", notebookTitle: "Bio", artifactId: "a1" };

test("csv: standard, Q/A and multiple-choice formats", () => {
    const a = parseCSV('"Question","Answer"\n"What is 2+2?","4"\n"Multi, comma","yes ""quoted"""\n');
    assert.equal(a.type, "flashcards");
    assert.deepEqual(a.type === "flashcards" && a.cards, [
        { front: "What is 2+2?", back: "4" },
        { front: "Multi, comma", back: 'yes "quoted"' },
    ]);
    const b = parseCSV("1: Q: Capital of France?; A: Paris\n2: Q: Capital of Spain?; A: Madrid");
    assert.equal(b.type === "flashcards" && b.cards.length, 2);
    const c = parseCSV("Q: Pick; A: one; isCorrect: false\nQ: Pick; A: two; isCorrect: true\nQ: Next; A: x; isCorrect: true");
    assert.equal(c.type, "quiz");
    if (c.type === "quiz") {
        assert.equal(c.questions.length, 2);
        assert.deepEqual(c.questions[0].options.map(o => o.correct), [false, true]);
    }
});

test("json: nlm flashcards, quiz, mind map and raw app-data shapes", () => {
    const f = parseJSON(JSON.stringify({ title: "Deck", cards: [{ front: "F", back: "B" }] }));
    assert.deepEqual(f, { type: "flashcards", title: "Deck", cards: [{ front: "F", back: "B" }] });
    const raw = parseJSON(JSON.stringify({ flashcards: [{ f: "x", b: "y" }] }));
    assert.equal(raw.type === "flashcards" && raw.cards[0].back, "y");
    const q = parseJSON(JSON.stringify({
        title: "Quiz",
        questions: [{ question: "Q1?", hint: "think", answerOptions: [
            { text: "A", isCorrect: false, rationale: "nope" }, { text: "B", isCorrect: true },
        ] }],
    }));
    assert.equal(q.type, "quiz");
    if (q.type === "quiz") {
        assert.equal(q.questions[0].hint, "think");
        assert.equal(q.questions[0].options[0].rationale, "nope");
        assert.equal(q.questions[0].options[1].correct, true);
    }
    const m = parseJSON(JSON.stringify({ name: "Root", children: [{ name: "A", children: [{ name: "A1" }] }, { name: "B" }] }));
    assert.equal(m.type, "mindmap");
    if (m.type === "mindmap") assert.equal(m.root.children[0].children[0].name, "A1");
    assert.throws(() => parseJSON('{"foo": 1}'));
});

test("callouts: notes are written as callouts and round-trip", () => {
    const back = "Energy currency\n\n- a list\n\n```js\nx()\n```";
    const note = buildFlashcardsNote([{ front: "What is ATP?", back }], { title: "T", deck: "Bio", origin });
    assert.match(note, /^---\nnlm-type: flashcards\nnlm-deck: "Bio"/);
    assert.match(note, /^> \[!flashcard\|fc-[a-z0-9]+\]- What is ATP\?$/m);
    assert.match(note, /^%% nlm:start/m);
    const cards = parseCallouts(note).cards;
    assert.equal(cards.length, 1);
    assert.equal(cards[0].back, back);

    const quizNote = buildQuizNote([{ question: "Which organelle?", hint: "power", options: [
        { text: "Ribosome", correct: false, rationale: "Makes proteins." }, { text: "Mitochondrion", correct: true },
    ] }], { title: "Q", deck: "Bio", origin });
    const q = parseCallouts(quizNote).questions[0];
    assert.equal(q.question, "Which organelle?");
    assert.equal(q.hint, "power");
    assert.deepEqual(q.options.map(o => o.correct), [false, true]);
    assert.equal(q.options[0].rationale, "Makes proteins.");
    assert.match(q.id!, /^qz-/);
});

test("callouts: hand-written cards anywhere in a note, code fences ignored", () => {
    const md = [
        "# My lecture notes",
        "Some text.",
        "",
        "> [!flashcard] Capital of France?",
        "> Paris",
        "",
        "```md",
        "> [!flashcard] Not a card",
        "> inside a code block",
        "```",
        "",
        "> [!quiz|qz-custom1]+ 2 + 2?",
        "> - [ ] 3",
        "> - [X] 4",
        ">     - Basic arithmetic.",
        "> Hint: count",
        "",
        "> [!note] A normal callout",
        "> ignored",
        "",
        "> [!flashcard] No answer",
    ].join("\n");
    const p = parseCallouts(md);
    assert.equal(p.cards.length, 1);
    assert.equal(p.cards[0].front, "Capital of France?");
    assert.equal(p.cards[0].back, "Paris");
    assert.equal(p.cards[0].line, 3);
    assert.equal(p.questions.length, 1);
    assert.equal(p.questions[0].id, "qz-custom1");
    assert.equal(p.questions[0].options[1].correct, true);
    assert.equal(p.questions[0].options[1].rationale, "Basic arithmetic.");
    assert.equal(p.questions[0].hint, "count");
    // Same content -> same id whether written by hand or by the plugin.
    const generated = parseCallouts(serializeCallouts({ cards: [{ front: "Capital of France?", back: "x" }] }));
    assert.equal(p.cards[0].id, generated.cards[0].id);
});

test("callouts: region replace keeps user text and carries ids over", () => {
    const note = buildFlashcardsNote([{ front: "A", back: "1" }], { title: "T", deck: "Bio", origin })
        .replace(/\|fc-\w+\]/, "|fc-custom1]") + "\nMy own notes here.\n";
    const old = parseCallouts(note).cards;
    assert.equal(old[0].id, "fc-custom1");
    const fresh = carryOverIds([{ front: "a ", back: "2" }, { front: "B", back: "3" }], old, c => c.front);
    assert.equal(fresh[0].id, "fc-custom1");
    const updated = replaceRegion(note, serializeCallouts({ cards: fresh }))!;
    assert.match(updated, /My own notes here\./);
    assert.match(updated, /^# T$/m);
    assert.deepEqual(parseCallouts(updated).cards.map(c => c.back), ["2", "3"]);
    assert.equal(replaceRegion("no region", "x"), null);
});

test("study content: 2.0 code blocks are still read next to callouts", () => {
    const legacy = "```nlm-flashcards\n" + serializeFlashcards([{ front: "Old", back: "card" }]) + "\n```\n\n"
        + "```nlm-quiz\n" + serializeQuiz([{ question: "Old q", options: [{ text: "x", correct: true }] }]) + "\n```\n"
        + "\n> [!flashcard] New\n> card\n";
    const p = parseStudyContent(legacy);
    assert.deepEqual(p.cards.map(c => c.front).sort(), ["New", "Old"]);
    assert.equal(p.questions.length, 1);
    assert.equal(parseFlashcards("Q: a\nA: b\nid: fc-abc123")[0].id, "fc-abc123");

    // Conversion keeps ids, user text and frontmatter, and leaves one region.
    const note = "---\nnlm-type: quiz\n---\n\n# T\n\nIntro\n\n" + legacy + "\nOutro\n";
    const converted = convertLegacyContent(note)!;
    assert.ok(!converted.includes("```nlm-"));
    assert.match(converted, /^---\nnlm-type: quiz\n---\n\n# T\n\nIntro\n\n%% nlm:start/);
    assert.match(converted, /Outro\n$/);
    assert.equal(converted.split("%% nlm:start").length, 2);
    const after = parseStudyContent(converted);
    assert.deepEqual(after.cards.map(c => c.id).sort(), p.cards.map(c => c.id).sort());
    assert.deepEqual(after.questions.map(q => q.id), p.questions.map(q => q.id));
    assert.equal(convertLegacyContent(converted), null);
    assert.equal(parseQuiz("Q: q\n- [x] y")[0].options.length, 1);
});

test("mind map: outline round-trip and non-overlapping canvas layout", () => {
    const root = { name: "Root", children: [
        { name: "A", children: [{ name: "A1", children: [] }, { name: "A2", children: [] }] },
        { name: "B", children: [] },
    ] };
    assert.deepEqual(parseOutline(toOutline(root)), root);
    const canvas = JSON.parse(toCanvas(root));
    assert.equal(canvas.nodes.length, 5);
    assert.equal(canvas.edges.length, 4);
    const ids = new Set(canvas.nodes.map((n: { id: string }) => n.id));
    for (const e of canvas.edges) assert.ok(ids.has(e.fromNode) && ids.has(e.toNode));
    const cols = new Map<number, { y: number; height: number }[]>();
    for (const n of canvas.nodes) cols.set(n.x, [...(cols.get(n.x) ?? []), n]);
    for (const col of cols.values()) {
        col.sort((a, b) => a.y - b.y);
        for (let i = 1; i < col.length; i++) assert.ok(col[i].y >= col[i - 1].y + col[i - 1].height);
    }
    const note = buildMindMapNote(root, { title: "M", deck: "D", origin, canvasPath: "x/M.canvas", includeOutline: true });
    assert.match(note, /```nlm-mindmap\n- Root\n {2}- A/);
    assert.match(note, /\[\[x\/M\.canvas\]\]/);
});

test("scheduler: FSRS review, undo, stats, forecast, activity and day boundary", () => {
    const data: SrsData = { cards: {}, log: [] };
    const s = new Scheduler(data, { desiredRetention: 0.9, maximumInterval: 36500, enableFuzz: false, dayStartHour: 4 });
    const now = new Date(2026, 9, 14, 12).getTime();
    assert.ok(s.isNew("c1"));
    const preview = s.preview("c1", now);
    assert.ok(preview[Rating.Again] < preview[Rating.Easy]);

    const t1 = s.review("c1", Rating.Good, now);
    assert.equal(s.stored("c1")!.state, State.Learning);
    s.review("c1", Rating.Good, now + 11 * 60000);
    assert.equal(s.stored("c1")!.state, State.Review);
    const t3 = s.review("c2", Rating.Again, now);
    s.undo(t3);
    assert.equal(s.has("c2"), false);
    assert.equal(data.log.length, 2);

    const st = s.stats(now + 12 * 60000);
    assert.equal(st.reviewedToday, 2);
    assert.equal(st.newToday, 1);
    assert.equal(st.streak, 1);
    assert.equal(s.forecast(["c1"], 30, now).reduce((a, b) => a + b, 0), 1);
    const act = s.activity(7, now);
    assert.equal(act.length, 7);
    assert.equal(act[6].count, 2);
    assert.equal(act[6].day, s.dayStart(now));
    s.undo(t1);
    assert.equal(data.log.length, 0);
    assert.equal(s.has("c1"), false);

    // 2am belongs to the previous study day.
    assert.equal(s.dayStart(new Date(2026, 9, 15, 2).getTime()), new Date(2026, 9, 14, 4).getTime());
});
