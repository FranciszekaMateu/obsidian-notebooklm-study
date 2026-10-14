import { Card, FSRS, Grade, Rating, State, createEmptyCard, fsrs, generatorParameters, migrateParameters } from "ts-fsrs";

/** Card state as persisted in data.json (dates as epoch ms). */
export interface StoredCard {
    due: number;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    learning_steps: number;
    reps: number;
    lapses: number;
    state: State;
    last_review?: number;
}

export interface ReviewEntry {
    id: string;
    /** Review time, epoch ms. */
    t: number;
    rating: Grade;
    /** State before the review. */
    state: State;
}

export interface ExamResult {
    /** Finish time, epoch ms. */
    t: number;
    durationMs: number;
    correct: number;
    total: number;
    /** Per note path: correct / total. */
    byNote: Record<string, { correct: number; total: number }>;
}

export interface SrsData {
    cards: Record<string, StoredCard>;
    log: ReviewEntry[];
    /** Cards left out of every session until unsuspended. */
    suspended: Record<string, true>;
    exams: ExamResult[];
}

export function emptySrs(): SrsData {
    return { cards: {}, log: [], suspended: {}, exams: [] };
}

export interface SchedulerOptions {
    desiredRetention: number;
    maximumInterval: number;
    enableFuzz: boolean;
    /** Hour at which a new study day begins (like Anki's "next day starts at"). */
    dayStartHour: number;
    /** Optimized FSRS weights; empty means the defaults. */
    weights?: number[];
}

export interface UndoToken {
    id: string;
    prev: StoredCard | undefined;
    logLength: number;
}

const MAX_LOG = 50000;
const DAY = 24 * 60 * 60 * 1000;

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export class Scheduler {
    private f: FSRS;

    constructor(public data: SrsData, private opts: SchedulerOptions) {
        this.f = this.makeFsrs();
    }

    setOptions(opts: SchedulerOptions) {
        this.opts = opts;
        this.f = this.makeFsrs();
    }

    private makeFsrs(): FSRS {
        return fsrs(
            generatorParameters({
                request_retention: this.opts.desiredRetention,
                maximum_interval: this.opts.maximumInterval,
                enable_fuzz: this.opts.enableFuzz,
                enable_short_term: true,
                ...(this.opts.weights?.length ? { w: migrateParameters(this.opts.weights) } : {}),
            })
        );
    }

    get weights(): readonly number[] {
        return this.f.parameters.w;
    }

    isSuspended(id: string): boolean {
        return !!this.data.suspended[id];
    }

    setSuspended(id: string, suspended: boolean) {
        if (suspended) this.data.suspended[id] = true;
        else delete this.data.suspended[id];
    }

    /** Review log entries of one card, oldest first. */
    history(id: string): ReviewEntry[] {
        return this.data.log.filter(e => e.id === id);
    }

    /** Current probability of recall (0..1), or null for new cards. */
    retrievability(id: string, now = Date.now()): number | null {
        const s = this.data.cards[id];
        if (!s || s.state === State.New) return null;
        return this.f.get_retrievability(fromStored(s), new Date(now), false);
    }

    has(id: string): boolean {
        return id in this.data.cards;
    }

    stored(id: string): StoredCard | undefined {
        return this.data.cards[id];
    }

    getCard(id: string, now = Date.now()): Card {
        const s = this.data.cards[id];
        return s ? fromStored(s) : createEmptyCard(new Date(now));
    }

    isNew(id: string): boolean {
        const s = this.data.cards[id];
        return !s || s.state === State.New;
    }

    isDue(id: string, now = Date.now()): boolean {
        const s = this.data.cards[id];
        return !!s && s.state !== State.New && s.due <= now;
    }

    /** Next due time for each grade, for the answer buttons. */
    preview(id: string, now = Date.now()): Record<Grade, Date> {
        const log = this.f.repeat(this.getCard(id, now), new Date(now));
        const out = {} as Record<Grade, Date>;
        for (const g of GRADES) out[g] = log[g].card.due;
        return out;
    }

    review(id: string, grade: Grade, now = Date.now()): UndoToken {
        const prev = this.data.cards[id];
        const token: UndoToken = { id, prev: prev ? { ...prev } : undefined, logLength: this.data.log.length };
        const before = this.getCard(id, now);
        const result = this.f.next(before, new Date(now), grade);
        this.data.cards[id] = toStored(result.card);
        this.data.log.push({ id, t: now, rating: grade, state: before.state });
        if (this.data.log.length > MAX_LOG) {
            const drop = this.data.log.length - MAX_LOG;
            this.data.log.splice(0, drop);
            token.logLength = Math.max(0, token.logLength - drop);
        }
        return token;
    }

    undo(token: UndoToken) {
        if (token.prev) this.data.cards[token.id] = token.prev;
        else delete this.data.cards[token.id];
        this.data.log.length = Math.min(this.data.log.length, token.logLength);
    }

    /** Forget all progress on one card. */
    reset(id: string) {
        delete this.data.cards[id];
    }

    /** Start of the current study day, honouring dayStartHour. */
    dayStart(now = Date.now()): number {
        const d = new Date(now);
        d.setHours(this.opts.dayStartHour, 0, 0, 0);
        if (d.getTime() > now) d.setDate(d.getDate() - 1);
        return d.getTime();
    }

    /** End of the current study day: cards due before this count as due today. */
    dayEnd(now = Date.now()): number {
        return this.dayStart(now) + DAY;
    }

    stats(now = Date.now()) {
        const start = this.dayStart(now);
        let reviewedToday = 0;
        let newToday = 0;
        let correctToday = 0;
        const reviewDays = new Set<number>();
        let matureTotal = 0;
        let matureCorrect = 0;
        const monthAgo = now - 30 * DAY;

        for (const e of this.data.log) {
            if (e.t >= start) {
                reviewedToday++;
                if (e.state === State.New) newToday++;
                if (e.rating !== Rating.Again) correctToday++;
            }
            if (e.t >= monthAgo && e.state === State.Review) {
                matureTotal++;
                if (e.rating !== Rating.Again) matureCorrect++;
            }
            reviewDays.add(this.dayStart(e.t));
        }

        let streak = 0;
        let day = start;
        if (!reviewDays.has(day)) day -= DAY; // today not studied yet doesn't break the streak
        while (reviewDays.has(day)) {
            streak++;
            day -= DAY;
        }

        return {
            reviewedToday,
            newToday,
            accuracyToday: reviewedToday ? correctToday / reviewedToday : null,
            retention30d: matureTotal ? matureCorrect / matureTotal : null,
            streak,
        };
    }

    /** Reviews per study day for the last `days` days, oldest first. */
    activity(days: number, now = Date.now()): { day: number; count: number }[] {
        const today = this.dayStart(now);
        const first = today - (days - 1) * DAY;
        const counts = new Map<number, number>();
        for (const e of this.data.log) {
            if (e.t < first) continue;
            const d = this.dayStart(e.t);
            counts.set(d, (counts.get(d) ?? 0) + 1);
        }
        const out: { day: number; count: number }[] = [];
        for (let i = 0; i < days; i++) {
            // Step by calendar day so DST changes don't drift the keys.
            const d = new Date(first);
            d.setDate(d.getDate() + i);
            const key = this.dayStart(d.getTime() + 60 * 60 * 1000);
            out.push({ day: key, count: counts.get(key) ?? 0 });
        }
        return out;
    }

    /** Number of the given cards due on each of the next `days` study days (index 0 = today, incl. overdue). */
    forecast(ids: string[], days: number, now = Date.now()): number[] {
        const counts = new Array(days).fill(0);
        const start = this.dayStart(now);
        for (const id of ids) {
            const s = this.data.cards[id];
            if (!s || s.state === State.New) continue;
            const idx = Math.max(0, Math.floor((s.due - start) / DAY));
            if (idx < days) counts[idx]++;
        }
        return counts;
    }
}

function toStored(c: Card): StoredCard {
    const s: StoredCard = {
        due: c.due.getTime(),
        stability: c.stability,
        difficulty: c.difficulty,
        elapsed_days: c.elapsed_days,
        scheduled_days: c.scheduled_days,
        learning_steps: c.learning_steps,
        reps: c.reps,
        lapses: c.lapses,
        state: c.state,
    };
    if (c.last_review) s.last_review = c.last_review.getTime();
    return s;
}

function fromStored(s: StoredCard): Card {
    return {
        due: new Date(s.due),
        stability: s.stability,
        difficulty: s.difficulty,
        elapsed_days: s.elapsed_days,
        scheduled_days: s.scheduled_days,
        learning_steps: s.learning_steps ?? 0,
        reps: s.reps,
        lapses: s.lapses,
        state: s.state,
        last_review: s.last_review ? new Date(s.last_review) : undefined,
    };
}

/** Human readable interval like "10m", "3d", "2.1mo". */
export function formatInterval(from: number, to: number): string {
    const mins = Math.max(1, Math.round((to - from) / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = mins / 60;
    if (hours < 24) return `${Math.round(hours)}h`;
    const days = hours / 24;
    if (days < 30) return `${Math.round(days)}d`;
    if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, "")}mo`;
    return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}
