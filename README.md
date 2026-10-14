# NotebookLM Study for Obsidian

Bring the study material NotebookLM generates — **flashcards, quizzes and mind maps** — into your vault, and study it there with a built-in **FSRS** spaced-repetition scheduler.

## Features

- **Sync straight from NotebookLM** (desktop) through the [`nlm` CLI](https://github.com/jacob-bd/gemini-notebook-mcp-cli): pick a notebook, tick the flashcards / quizzes / mind maps you want, done. Re-syncing updates the notes in place and keeps your review history.
- **Import exports from disk** (desktop and mobile): NotebookLM CSV exports, `nlm` JSON downloads, or a Markdown outline for mind maps.
- **FSRS spaced repetition** (via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)): Again / Hard / Good / Easy with interval previews, learning steps, daily limits for new cards and reviews, configurable desired retention, undo.
- **Quiz questions in your reviews**: multiple-choice questions can be reviewed alongside flashcards. Answer with a click or with the A–H keys, and a grade is suggested from whether you got it right.
- **Study dashboard**: due and new counts per deck, today's reviews, 30-day retention, your streak and a 14-day forecast.
- **Interactive blocks inside notes**:
  - `nlm-flashcards`: a flip-card browser with a *Study* button.
  - `nlm-quiz`: a self-test with a score, hints, rationales and *retry missed*.
  - `nlm-mindmap`: a collapsible tree.
- **Mind maps three ways**: the interactive block, an Obsidian **Canvas** laid out as a tree, and a plain nested list that works with Markmap.

## Note format

Everything lives in normal Markdown notes, and you can edit them by hand. Each card or question gets a stable `id` (generated from its content when you leave it out), and that id is what the review history is keyed on.

````markdown
---
nlm-type: flashcards
nlm-deck: "Biology"
---

```nlm-flashcards
Q: What is ATP?
A: The cell's energy currency.
   Answers can span several lines.
id: fc-1a2b3c4d5e

Q: Second card
A: …
```
````

````markdown
```nlm-quiz
Q: Which organelle produces ATP?
- [ ] Ribosome
  > Ribosomes synthesise proteins.
- [x] Mitochondrion
hint: Think "powerhouse".
```
````

````markdown
```nlm-mindmap
- Neural networks
  - Perceptron
  - Backpropagation
```
````

Text you write outside the block is preserved when a note is re-synced. Add `nlm-lock: true` to the frontmatter to stop a note from being updated.

## Commands

| Command | |
|---|---|
| Open study dashboard | Also available from the ribbon (graduation cap) |
| Study all due cards | |
| Study current note | |
| Sync from NotebookLM | Desktop only |
| Update current note / all synced notes from NotebookLM | Desktop only |
| Import CSV / JSON export | |

Review shortcuts: <kbd>Space</kbd> shows the answer (or accepts the suggested grade), <kbd>1</kbd>–<kbd>4</kbd> grade the card, <kbd>A</kbd>–<kbd>H</kbd> answer a quiz question, and <kbd>U</kbd> undoes the last grade.

## Setting up NotebookLM sync

1. Install the CLI: `uv tool install notebooklm-mcp-cli` (or `pipx install notebooklm-mcp-cli`).
2. Run `nlm login` once in a terminal.
3. In Obsidian, run **Sync from NotebookLM**. If the plugin can't find `nlm`, set its full path in the settings (for example `C:\Users\you\.local\bin\nlm.exe`) and click **Test**.

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
