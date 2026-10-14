import { MindMapNode } from "./types";

/** Serialize a mind map as an indented markdown list (also what Markmap reads). */
export function toOutline(root: MindMapNode, indent = "  "): string {
    const lines: string[] = [];
    const walk = (node: MindMapNode, depth: number) => {
        lines.push(`${indent.repeat(depth)}- ${oneLine(node.name)}`);
        node.children.forEach(c => walk(c, depth + 1));
    };
    walk(root, 0);
    return lines.join("\n");
}

/** Parse an indented markdown list back into a tree. Multiple top-level items get a synthetic root. */
export function parseOutline(text: string, fallbackTitle = "Mind map"): MindMapNode {
    const roots: MindMapNode[] = [];
    const stack: { indent: number; node: MindMapNode }[] = [];

    for (const raw of text.split(/\r?\n/)) {
        const m = raw.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (!m) continue;
        const indent = m[1].replace(/\t/g, "    ").length;
        const node: MindMapNode = { name: m[2].trim(), children: [] };

        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        if (stack.length) stack[stack.length - 1].node.children.push(node);
        else roots.push(node);
        stack.push({ indent, node });
    }

    if (roots.length === 1) return roots[0];
    return { name: fallbackTitle, children: roots };
}

export function countNodes(node: MindMapNode): number {
    return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

function oneLine(s: string): string {
    return s.replace(/\s*\n\s*/g, " ").trim();
}

// --- Obsidian Canvas -------------------------------------------------------

interface CanvasNode {
    id: string;
    type: "text";
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
}

interface CanvasEdge {
    id: string;
    fromNode: string;
    fromSide: "right";
    toNode: string;
    toSide: "left";
}

const NODE_WIDTH = 280;
const H_GAP = 100;
const V_GAP = 24;
const DEPTH_COLORS = ["6", "5", "4", "3", "2", "1"];

function estimateHeight(text: string, isRoot: boolean): number {
    const charsPerLine = 30;
    const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
    return Math.max(isRoot ? 80 : 60, lines * 26 + 34);
}

/** Lay the tree out left-to-right and return Obsidian `.canvas` JSON. */
export function toCanvas(root: MindMapNode): string {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
    let counter = 0;
    const nextId = () => (counter++).toString(16).padStart(16, "0");

    // Returns the subtree height and places nodes starting at yTop.
    const place = (node: MindMapNode, depth: number, yTop: number, parentId?: string): number => {
        const id = nextId();
        const text = depth === 0 ? `# ${oneLine(node.name)}` : oneLine(node.name);
        const height = estimateHeight(node.name, depth === 0);

        let subtreeHeight = height;
        if (node.children.length) {
            let y = yTop;
            for (const child of node.children) {
                y += place(child, depth + 1, y, id) + V_GAP;
            }
            subtreeHeight = Math.max(height, y - V_GAP - yTop);
        }

        // Centre the node on its subtree.
        const nodeY = yTop + (subtreeHeight - height) / 2;
        nodes.push({
            id,
            type: "text",
            text,
            x: depth * (NODE_WIDTH + H_GAP),
            y: Math.round(nodeY),
            width: NODE_WIDTH,
            height,
            color: DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)],
        });
        if (parentId) {
            edges.push({ id: `e${id}`, fromNode: parentId, fromSide: "right", toNode: id, toSide: "left" });
        }
        return subtreeHeight;
    };

    place(root, 0, 0);
    return JSON.stringify({ nodes, edges }, null, "\t");
}
