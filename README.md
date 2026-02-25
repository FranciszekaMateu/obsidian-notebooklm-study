# Obsidian NotebookLM CSV Importer

This plugin allows you to import flashcards from CSV files exported by NotebookLM and convert them into a format compatible with the [Obsidian Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) plugin.

## Features

- **Auto-detection**: Supports both standard CSV (comma-separated) and the `Q:; A:` format.
- **Customizable**: Configure the output folder, deck prefix, and card separators.
- **Easy Import**: Use the ribbon icon or command palette to select your CSV and generate markdown files ready for study.

## Installation

### Manual Installation
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder named `notebooklm-csv-importer` in your vault's `.obsidian/plugins/` directory.
3. Copy the downloaded files into that folder.
4. Enable the plugin in Obsidian settings.

## Development

1. Clone this repository.
2. Run `npm install`.
3. Run `npm run build` to compile the plugin.

## License

MIT
