import { Flashcard } from "./csv-parser";

export function convertToMarkdown(
    flashcards: Flashcard[], 
    deckName: string, 
    separator: string, 
    deckPrefix: string
): string {
    const sanitizedDeckName = deckName
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
    
    const tag = `#${deckPrefix}/${sanitizedDeckName}`;
    
    let markdown = `${tag}\n\n`;
    
    for (const card of flashcards) {
        const isMultiLine = card.question.includes('\n') || card.answer.includes('\n');
        
        // Escape the separator in content if it matches
        const q = card.question.replace(new RegExp(separator, 'g'), separator.split('').join(' '));
        const a = card.answer.replace(new RegExp(separator, 'g'), separator.split('').join(' '));
        
        let effectiveSeparator = separator;
        if (isMultiLine) {
            if (separator === '::') effectiveSeparator = '?';
            if (separator === ':::') effectiveSeparator = '??';
        }

        if (effectiveSeparator === '?' || effectiveSeparator === '??') {
            // Multiline format
            markdown += `${q}\n${effectiveSeparator}\n${a}\n\n`;
        } else {
            // Single line format
            markdown += `${q}${effectiveSeparator}${a}\n\n`;
        }
    }
    
    return markdown.trim() + '\n';
}
