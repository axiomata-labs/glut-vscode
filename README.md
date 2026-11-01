# Glut for VS Code

Glut beside VS Code (and Cursor, Windsurf and the other editors built on it). Glut — a terminal coding agent with its
own sandbox, gate and sessions — runs in a terminal beside your editors (or in any terminal in the same folder), and
this extension tells it what you work on:

- **The file, the cursor and the selection** go with each of your messages to Glut (it shows "⧉ 12 lines of
  src/main.rs" under them), as long as none of Glut's read rules holds the file back.
- **Your documents as VS Code holds them**: Glut reads an open document, unsaved changes too. It never changes a
  document with unsaved changes — save it first.
- **Glut's questions about edits as VS Code diffs**: where Glut's gate asks before an edit, the change opens as a diff,
  the file on the left, Glut's change on the right. The ✓ and ✕ in the diff's title bar (or *Glut: Accept Glut's
  Change* / *Refuse Glut's Change*) answer; Glut's own card in its terminal answers too, and the first answer counts.
  You may change the right side before accepting: Glut then writes your version instead of its own, and tells its
  model what you changed. Accepting writes nothing here: Glut writes the file once its gate allows it.
- **What is open and what your language servers say**, for Glut's model to ask.

The protocol is Glut's own, in Glut's repository: `docs/editor-protocol.md`.

## Requirements

- VS Code 1.85 or later (or a fork of it: Cursor, Windsurf)
- `glut` on the `PATH` (or set `glut.command`)

## Install

```sh
npm install
npm run package                       # glut-0.1.0.vsix
code --install-extension glut-0.1.0.vsix
```

The extension starts listening once VS Code has started (on 127.0.0.1 only, behind a fresh random token in
`~/.glut/ide/<port>.json`, readable by you alone), so a Glut started in another terminal in the same folder finds
VS Code too.

## Commands

The extension binds no keys; bind the commands the way you like.

| Command | What it does |
|---|---|
| *Glut: Open Glut* | Glut in a terminal beside the editors: opens it, or shows the one there is |
| *Glut: Send Selection to Glut* | the selected lines as `@path#L10-22` in Glut's input — write your question and send it |
| *Glut: Add File to Glut* | the current file (or the one the explorer's menu was opened on) as `@path` in Glut's input |
| *Glut: Accept Glut's Change* | accept Glut's change shown in this diff, with what you changed on its right side |
| *Glut: Refuse Glut's Change* | refuse it |

## Settings

| Setting | Default | |
|---|---|---|
| `glut.command` | `glut` | the program Glut is started as — read from your user settings only, never a folder's |
| `glut.terminalLocation` | `editor` | `editor`: Glut's terminal beside the editors; `panel`: in the panel |

## Development

```sh
npm install
npm run check        # TypeScript
npm test             # the protocol, the server and the editor against a stand-in for VS Code
```

## License

MIT OR Apache-2.0
