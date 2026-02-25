export interface Flashcard {
    question: string;
    answer: string;
}

export function parseCSV(content: string): Flashcard[] {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];

    // Auto-detect format
    const firstLine = lines[0];
    
    // Format B: Q: ...; A: ...
    if (firstLine.includes('Q:') && firstLine.includes('; A:')) {
        return parseFormatB(lines);
    }
    
    // Default to Format A (Standard CSV)
    return parseFormatA(content);
}

function parseFormatB(lines: string[]): Flashcard[] {
    const flashcards: Flashcard[] = [];
    for (const line of lines) {
        // Formato: "1: Q: Pregunta; A: Respuesta" o "Q: Pregunta; A: Respuesta"
        // Remove index prefix if exists (e.g. "1: ")
        const cleanLine = line.replace(/^\d+:\s*/, '');
        
        const parts = cleanLine.split('; A:');
        if (parts.length >= 2) {
            const question = parts[0].replace(/^Q:\s*/, '').trim();
            const answer = parts.slice(1).join('; A:').trim();
            if (question && answer) {
                flashcards.push({ question, answer });
            }
        }
    }
    return flashcards;
}

function parseFormatA(content: string): Flashcard[] {
    const flashcards: Flashcard[] = [];
    
    // Simple CSV parser that handles quotes and escaped quotes
    // NotebookLM format: "Question","Answer" or Question,Answer
    
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];
        
        if (inQuotes) {
            if (char === '"' && nextChar === '"') {
                currentField += '"';
                i++; // Skip next quote
            } else if (char === '"') {
                inQuotes = false;
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
                if (char === '\r') i++; // Skip \n
            } else if (char === '\r') {
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
            } else {
                currentField += char;
            }
        }
    }
    
    // Push last field/row
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }
    
    for (const row of rows) {
        if (row.length >= 2) {
            // Check if it's a header (NotebookLM sometimes doesn't have headers, 
            // but if it looks like "Question","Answer" or "Front","Back" we skip)
            const q = row[0].trim().replace(/^\d+:\s*/, ''); // Some CSVs had index prefix
            const a = row[1].trim();
            
            if (q && a && !isHeader(q, a)) {
                flashcards.push({ question: q, answer: a });
            }
        }
    }
    
    return flashcards;
}

function isHeader(q: string, a: string): boolean {
    const headers = ['question', 'answer', 'front', 'back', 'pregunta', 'respuesta'];
    return headers.includes(q.toLowerCase()) && headers.includes(a.toLowerCase());
}
