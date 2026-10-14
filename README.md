# NotebookLM Study for Obsidian

Bring the study material NotebookLM generates — **flashcards, quizzes and mind maps** — into your vault, and study it there with a built-in **FSRS** spaced-repetition scheduler.

## Features

- **Everything lives in your Markdown.** Flashcards and quiz questions are ordinary callouts (`> [!flashcard]`, `> [!quiz]`). They read fine without the plugin, you can edit them by hand, and you can write them in *any* note: the plugin finds them across the whole vault.
- **Sync straight from NotebookLM** (desktop) through the [`nlm` CLI](https://github.com/jacob-bd/gemini-notebook-mcp-cli). Browse your notebooks in the side panel, tick the flashcards, quizzes or mind maps you want, and import them. A single **Update** button refreshes every synced note; your own text and your review history are kept.
- **Import exports from disk** (desktop and mobile): NotebookLM CSV exports, `nlm` JSON downloads, or a Markdown outline for mind maps.
- **FSRS spaced repetition** (via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)): Again / Hard / Good / Easy with interval previews, learning steps, daily limits, configurable desired retention, undo.
- **Quizzes everywhere**: answer quiz callouts right inside the note, practice a whole quiz with a score and *retry missed*, or review the questions with spaced repetition alongside your flashcards.
- **Integrated UI, no pop-ups**:
  - a **side panel** with today's numbers, a *Study now* button, the NotebookLM browser, all your decks and file import;
  - a **toolbar on every study note** with *Study*, *Practice quiz* and *Update from NotebookLM*;
  - a **status-bar counter** of cards to study (click it to start);
  - a **dashboard** with card states, a 14-day forecast, a review heatmap and per-deck progress.
- **Mind maps three ways**: a collapsible tree in the note, an Obsidian **Canvas** laid out as a tree, and a plain nested list that works with Markmap.

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
````

- The `-` after the type folds the callout, so the answer stays hidden until you open it.
- Wrong and right options are `- [ ]` / `- [x]`. An indented bullet under an option is its explanation, shown after you answer.
- Each item gets a stable id from its content. Notes created by the plugin store it in the callout metadata (`> [!flashcard|fc-1a2b3c4d5e]`), which Obsidian hides; review history is keyed on that id.
- Notes imported from NotebookLM wrap the synced items between `%% nlm:start %%` and `%% nlm:end %%`. Updating replaces only that region. Anything you write outside it is kept. Add `nlm-lock: true` to the frontmatter to stop a note from being updated.
- Use the **Insert flashcard** and **Insert quiz question** commands to add new items from a template.

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
| Open study dashboard | |
| Study all due cards | Also the status-bar counter |
| Study current note / Practice quiz in current note | Also the note toolbar |
| Insert flashcard / Insert quiz question | |
| Add from NotebookLM | Desktop only |
| Update current note / all synced notes from NotebookLM | Desktop only |
| Import CSV / JSON export | |
| Convert current note to callout format | For notes created by 2.0.0 |

Review shortcuts: <kbd>Space</kbd> shows the answer (or accepts the suggested grade), <kbd>1</kbd>–<kbd>4</kbd> grade the card, <kbd>A</kbd>–<kbd>H</kbd> answer a quiz question, <kbd>Enter</kbd> moves to the next quiz question, and <kbd>U</kbd> undoes the last grade.

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
