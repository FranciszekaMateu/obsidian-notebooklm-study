import { CLAMP_PARAMETERS, FSRSAlgorithm, FSRSState, W17_W18_Ceiling, default_w, migrateParameters } from "ts-fsrs";
import type { ReviewEntry } from "./scheduler";

/*
 * Fits the FSRS weights to the user's own review history.
 *
 * For every card the reviews are replayed through the FSRS memory model; each
 * review made on a later day than the previous one is a prediction ("recall
 * probability R") that is scored against what happened (rating > Again).
 * The weights minimise the mean log loss of those predictions, using Adam
 * with central-difference gradients, within the official parameter bounds.
 */

export const MIN_REVIEWS = 200;
const MAX_LABELLED = 12000;
const DAY = 24 * 60 * 60 * 1000;

interface Step { dt: number; g: number }

export interface Dataset {
    sequences: Step[][];
    /** Reviews that are scored (made on a later day than the previous one). */
    labelled: number;
}

export interface Metrics {
    logLoss: number;
    /** RMSE between predicted and actual recall, over 10 bins of predicted R. */
    rmse: number;
}

export interface OptimizeResult {
    weights: number[];
    before: Metrics;
    after: Metrics;
    reviews: number;
    cards: number;
}

/** Group the log per card and turn it into (days since previous review, rating) steps. */
export function buildDataset(log: ReviewEntry[], dayStart: (t: number) => number): Dataset {
    const byCard = new Map<string, ReviewEntry[]>();
    for (const e of log) {
        if (!byCard.has(e.id)) byCard.set(e.id, []);
        byCard.get(e.id)!.push(e);
    }

    const sequences: Step[][] = [];
    let labelled = 0;
    // Newest cards last, so trimming to MAX_LABELLED keeps the most recent history.
    const entries = [...byCard.values()].sort((a, b) => a[0].t - b[0].t);
    for (const reviews of entries) {
        reviews.sort((a, b) => a.t - b.t);
        // Only cards whose history starts at their first review can be replayed.
        if (reviews[0].state !== 0) continue;
        const seq: Step[] = [];
        let prevDay = dayStart(reviews[0].t);
        for (const r of reviews) {
            const day = dayStart(r.t);
            const dt = Math.max(0, Math.round((day - prevDay) / DAY));
            seq.push({ dt: seq.length ? dt : 0, g: r.rating });
            if (seq.length > 1 && dt > 0) labelled++;
            prevDay = day;
        }
        if (seq.length > 1) sequences.push(seq);
    }

    while (labelled > MAX_LABELLED && sequences.length > 1) {
        const dropped = sequences.shift()!;
        labelled -= dropped.slice(1).filter(s => s.dt > 0).length;
    }
    return { sequences, labelled };
}

export function evaluate(w: readonly number[], data: Dataset): Metrics {
    const algo = new FSRSAlgorithm({ w: [...w], enable_short_term: true });
    let loss = 0;
    let n = 0;
    const bins = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));

    for (const seq of data.sequences) {
        let state: FSRSState | null = null;
        for (const step of seq) {
            if (state && step.dt > 0) {
                const r = clamp(algo.forgetting_curve(step.dt, state.stability), 1e-4, 1 - 1e-4);
                const y = step.g > 1 ? 1 : 0;
                loss += -(y * Math.log(r) + (1 - y) * Math.log(1 - r));
                n++;
                const b = bins[Math.min(9, Math.floor(r * 10))];
                b.p += r;
                b.y += y;
                b.n++;
            }
            state = algo.next_state(state, step.dt, step.g);
        }
    }

    let se = 0;
    for (const b of bins) if (b.n) se += b.n * ((b.p - b.y) / b.n) ** 2;
    return { logLoss: n ? loss / n : NaN, rmse: n ? Math.sqrt(se / n) : NaN };
}

export async function optimize(
    log: ReviewEntry[],
    dayStart: (t: number) => number,
    start: readonly number[] = default_w,
    onProgress?: (fraction: number) => void,
    steps = 120,
): Promise<OptimizeResult> {
    const data = buildDataset(log, dayStart);
    if (data.labelled < MIN_REVIEWS) {
        throw new Error(`Not enough review history yet: ${data.labelled} of ${MIN_REVIEWS} reviews made on a later day.`);
    }

    let w = migrateParameters([...start]);
    const bounds = CLAMP_PARAMETERS(W17_W18_Ceiling, true);
    const project = (v: number[]) => v.map((x, i) => (bounds[i] ? clamp(x, bounds[i][0], bounds[i][1]) : x));
    w = project(w);

    const before = evaluate(w, data);
    const loss = (v: number[]) => evaluate(v, data).logLoss;

    // Adam on central-difference gradients.
    const lr = 0.03;
    const b1 = 0.9, b2 = 0.999, epsAdam = 1e-8;
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    let best = w;
    let bestLoss = before.logLoss;

    for (let t = 1; t <= steps; t++) {
        const grad = w.map((x, i) => {
            const h = Math.max(1e-3, Math.abs(x) * 1e-3);
            const up = [...w]; up[i] = x + h;
            const down = [...w]; down[i] = x - h;
            return (loss(project(up)) - loss(project(down))) / (2 * h);
        });
        const step = lr * Math.sqrt(1 - b2 ** t) / (1 - b1 ** t);
        w = project(w.map((x, i) => {
            m[i] = b1 * m[i] + (1 - b1) * grad[i];
            v[i] = b2 * v[i] + (1 - b2) * grad[i] ** 2;
            return x - step * m[i] / (Math.sqrt(v[i]) + epsAdam);
        }));
        const current = loss(w);
        if (current < bestLoss) {
            bestLoss = current;
            best = w;
        }
        onProgress?.(t / steps);
        // Let the UI breathe between steps.
        await new Promise(r => setTimeout(r, 0));
    }

    return {
        weights: best.map(x => Math.round(x * 1e4) / 1e4),
        before,
        after: evaluate(best, data),
        reviews: data.labelled,
        cards: data.sequences.length,
    };
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}
