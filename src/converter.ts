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
        // Escape the separator in content if it matches
        const q = card.question.replace(new RegExp(separator, 'g'), separator.split('').join(' '));
        const a = card.answer.replace(new RegExp(separator, 'g'), separator.split('').join(' '));
        
        if (separator === '?' || separator === '??') {
            // Multiline format
            markdown += `${q}\n${separator}\n${a}\n\n`;
        } else {
            // Single line format
            markdown += `${q}${separator}${a}\n\n`;
        }
    }
    
    return markdown.trim() + '\n';
}
