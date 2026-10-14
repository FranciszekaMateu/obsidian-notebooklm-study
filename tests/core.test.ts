import { test } from "node:test";
import assert from "node:assert/strict";
import { Rating, State } from "ts-fsrs";
import { parseCSV } from "../src/parsers/csv";
import { parseJSON } from "../src/parsers/json";
import {
    buildFlashcardsNote, buildQuizNote, buildMindMapNote, carryOverIds, findBlock,
    parseFlashcards, parseQuiz, replaceBlock, serializeFlashcards, serializeQuiz,
} from "../src/notes";
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

test("flashcard block round-trips, including multi-line and stable ids", () => {
    const cards = [{ front: "What is ATP?", back: "Energy currency\n\n- line 2" }, { front: "$E=mc^2$?", back: "Yes" }];
    const parsed = parseFlashcards(serializeFlashcards(cards));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].back, "Energy currency\n\n- line 2");
    assert.match(parsed[0].id!, /^fc-[a-z0-9]+$/);
    assert.equal(parseFlashcards(serializeFlashcards(parsed))[0].id, parsed[0].id);
    // A hand-written card without an id gets the same content id.
    assert.equal(parseFlashcards("Q: What is ATP?\nA: whatever")[0].id, parsed[0].id);
});

test("quiz block round-trips with rationale and hint", () => {
    const qs = [{ question: "Which?\nSecond line", hint: "h", options: [
        { text: "one", correct: false, rationale: "because" }, { text: "two", correct: true },
    ] }];
    const parsed = parseQuiz(serializeQuiz(qs));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].question, "Which?\nSecond line");
    assert.equal(parsed[0].hint, "h");
    assert.equal(parsed[0].options[0].rationale, "because");
    assert.deepEqual(parsed[0].options.map(o => o.correct), [false, true]);
});

test("notes: replace block keeps user text and carries ids over", () => {
    const note = buildFlashcardsNote([{ front: "A", back: "1" }], { title: "T", deck: "Bio", origin });
    assert.match(note, /^---\nnlm-type: flashcards\nnlm-deck: "Bio"/);
    const withUser = note.replace(/id: fc-\w+/, "id: fc-custom1") + "\nMy own notes here.\n";
    const old = parseFlashcards(findBlock(withUser, "nlm-flashcards")!.body);
    const fresh = carryOverIds([{ front: "a ", back: "2" }, { front: "B", back: "3" }], old, c => c.front);
    assert.equal(fresh[0].id, "fc-custom1");
    const updated = replaceBlock(withUser, "flashcards", serializeFlashcards(fresh))!;
    assert.match(updated, /My own notes here\./);
    assert.equal(parseFlashcards(findBlock(updated, "nlm-flashcards")!.body).length, 2);

    const quizNote = buildQuizNote([{ question: "Q", options: [{ text: "x", correct: true }] }], { title: "Q", deck: "Bio", origin });
    assert.equal(parseQuiz(findBlock(quizNote, "nlm-quiz")!.body).length, 1);
});

test("notes: content containing a code fence uses a longer fence", () => {
    const back = "```js\nx()\n```";
    const note = buildFlashcardsNote([{ front: "Code?", back }], { title: "T", deck: "D", origin });
    assert.equal(parseFlashcards(findBlock(note, "nlm-flashcards")!.body)[0].back, back);
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

test("scheduler: FSRS review, undo, stats, forecast and day boundary", () => {
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
    s.undo(t1);
    assert.equal(data.log.length, 0);
    assert.equal(s.has("c1"), false);

    // 2am belongs to the previous study day.
    assert.equal(s.dayStart(new Date(2026, 9, 15, 2).getTime()), new Date(2026, 9, 14, 4).getTime());
});
