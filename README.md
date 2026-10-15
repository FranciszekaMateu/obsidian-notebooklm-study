# NotebookLM Study for Obsidian

Bring the study material NotebookLM generates — **flashcards, quizzes and mind maps** — into your vault, and study it there with a built-in **FSRS** spaced-repetition scheduler.

## Features

**NotebookLM, from inside Obsidian** (desktop, through the [`nlm` CLI](https://github.com/jacob-bd/gemini-notebook-mcp-cli))
- **Generate from notes and PDFs**: right-click a note, a **PDF** (also Word, PowerPoint or audio) or a folder → *Generate with NotebookLM*. The files are uploaded as sources (an unchanged file is never uploaded twice) and NotebookLM creates flashcards, a quiz, a mind map, an audio overview, a study guide or an infographic, which are then imported automatically. Generated notes link back to their PDF, and the toolbar has an *Open PDF* button to study side by side.
- **Your own cards from PDFs**: select text in a PDF and click the floating *Card* button (or right-click selected text in a note → *Make a card from this*). The side panel fills in the answer; type the question, or let NotebookLM *Suggest a question*. Basic, both-ways and cloze cards are saved to a companion note next to the PDF (`Lecture 3 - cards.md`) with a link back to the exact page, in the same deck as the course's notebook.
- **Ask**: chat with any notebook from the side panel. Answers come with citations; insert them into a note or save them as a flashcard. Select text in a note → right-click → *Ask NotebookLM about this*; in the PDF viewer, select text and run *Ask NotebookLM about the selected text*.
- **Sync**: browse notebooks and import what you need: flashcards, quizzes, mind maps, audio overviews (with a player), reports, infographics and slide decks. **Automatic sync** can bring in anything new every few hours or at startup.

**Study**
- **Everything lives in your Markdown.** Flashcards, cloze cards and quiz questions are ordinary callouts that read fine without the plugin, and you can write them in *any* note.
- **FSRS spaced repetition** (via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)) with interval previews, daily limits and undo. An **optimizer** fits FSRS to your own review history.
- **Cloze deletions** (`{{answer}}`, `{{c2::answer::hint}}`) and **reversible flashcards** (studied in both directions).
- **Quizzes everywhere**: answer them inside the note, practice a whole quiz, review the questions with spaced repetition, or take a **mock exam**: questions from several quizzes, a time limit, a score per topic and *retry mistakes*.
- **Card browser**: search, filter and sort every card; see its history, stability and recall; suspend, reset or study it.
- **Dashboard**: card states, 14-day forecast, activity heatmap, retention per deck, recent exams and the topics to reinforce.

**Interface**
- Side panel, a toolbar on study notes, a status-bar counter. There are no pop-ups.
- **English and Spanish**: follows Obsidian's language, or choose it in the settings.
- **Mind maps**: collapsible tree with zoom, drag and full screen, plus the cards related to each node. They are also exported as an Obsidian Canvas and as a Markmap-compatible outline.

## Note format

````markdown
> [!flashcard]- What is ATP?
> The cell's energy currency.
> Answers can span several lines, with lists, code, math…

> [!quiz]- Which organelle produces ATP?
> - [ ] Ribosome
>     - Ribosomes synthesise proteins.
> - [x] Mitochondrion
>
> **Hint:** Think "powerhouse".

> [!cloze] Cell biology
> The {{mitochondrion}} makes {{c2::ATP::energy molecule}}.

> [!flashcard|reverse]- Mitochondrion
> Organelle that produces ATP.
````

- The `-` after the type folds the callout, so the answer stays hidden until you open it.
- Wrong and right options are `- [ ]` / `- [x]`. An indented bullet under an option is its explanation, shown after you answer.
- Each item gets a stable id from its content. Notes created by the plugin store it in the callout metadata (`> [!flashcard|fc-1a2b3c4d5e]`), which Obsidian hides; review history is keyed on that id.
- Notes imported from NotebookLM wrap the synced items between `%% nlm:start %%` and `%% nlm:end %%`. Updating replaces only that region. Anything you write outside it is kept. Add `nlm-lock: true` to the frontmatter to stop a note from being updated.
- In a `[!cloze]` callout, each `{{…}}` is a card; `{{cN::…}}` groups deletions into one card, and a third part is a hint. Select text and choose *Turn into cloze card* to make one: **bold** and ==highlighted== text become the gaps.
- `|reverse` in the callout metadata also creates the back-to-front card.
- Use the **Insert flashcard**, **Insert reversible flashcard**, **Insert cloze card** and **Insert quiz question** commands to add new items from a template.

Mind maps are an indented list in an `nlm-mindmap` block:

````markdown
```nlm-mindmap
- Neural networks
  - Perceptron
  - Backpropagation
```
````

Notes created by 2.0.0 (code-block format) keep working; run **Convert current note to callout format**, or click the button shown on the block, to switch them over.

## Commands

| Command | |
|---|---|
| Open panel | Also the ribbon icon (graduation cap) |
| Open study dashboard / Open card browser | |
| Study all due cards | Also the status-bar counter |
| Study current note / Practice quiz in current note | Also the note toolbar |
| Start an exam | |
| Insert flashcard / reversible flashcard / cloze card / quiz question | |
| Generate study material from current note | Desktop; also right-click a note or folder |
| Ask a notebook | Desktop; also right-click selected text |
| New card from selected text | Works in notes and PDFs; also the floating *Card* button in PDFs |
| Add from NotebookLM / Check NotebookLM for new items | Desktop |
| Update current note / all synced notes from NotebookLM | Desktop |
| Import CSV / JSON export | |
| Convert current note / all notes to callout format | For notes created by 2.0.0 |

Review shortcuts: <kbd>Space</kbd> shows the answer (or accepts the suggested grade), <kbd>1</kbd>–<kbd>4</kbd> grade the card, <kbd>A</kbd>–<kbd>H</kbd> answer a quiz question, <kbd>Enter</kbd> moves to the next quiz question, <kbd>U</kbd> undoes the last grade, and in an exam <kbd>←</kbd>/<kbd>→</kbd> move between questions.

## Setting up NotebookLM sync

1. Install the CLI: `uv tool install notebooklm-mcp-cli` (or `pipx install notebooklm-mcp-cli`).
2. Run `nlm login` once in a terminal.
3. In Obsidian, open the side panel and expand **NotebookLM**. If the plugin can't find `nlm`, set its full path in the settings (for example `C:\Users\you\.local\bin\nlm.exe`) and click **Test**.

Generate flashcards, quizzes or mind maps in NotebookLM's Studio panel first. The plugin only downloads what already exists.

## Installation

### BRAT (recommended)
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run `BRAT: Plugins: Add a beta plugin for testing` and enter `https://github.com/FranciszekaMateu/obsidian-notebooklm-study`.
3. Enable **NotebookLM Study**.

### Manual
Copy `main.js`, `manifest.json` and `styles.css` from the latest release into `.obsidian/plugins/notebooklm-study/`, then enable the plugin.

## Coming from NotebookLM CSV Importer

This plugin replaces [obsidian-notebooklm-flashcards](https://github.com/FranciszekaMateu/obsidian-notebooklm-flashcards) (NotebookLM CSV Importer), which is now archived. It is installed as a separate plugin: install this one, then disable and remove the old one. Notes created by the old plugin use the Spaced Repetition plugin's format and keep working with that plugin. To move a deck into this plugin's scheduler, import its CSV again.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production build
npm test        # parser, note-format, mind map and scheduler tests
```

## License

MIT
