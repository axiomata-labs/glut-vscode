// glut for VS Code: Glut beside VS Code. The extension listens on loopback for Glut (docs/editor-protocol.md in Glut),
// tells it the file, the cursor and the selection you work on, hands it your documents as VS Code holds them, and
// shows its questions about edits as VS Code's own diffs. Glut itself runs in a terminal beside the editors (Glut:
// Open Glut) or anywhere else in this folder. Cursor and Windsurf, built on VS Code, take it as it is.

import * as vscode from "vscode";
import * as lockfile from "./lockfile.ts";
import { Diffs, handle } from "./protocol.ts";
import { start, type Served } from "./server.ts";
import { VsCodeEditor } from "./vscodeEditor.ts";

/** How long Glut takes to draw its input before a reference pasted into it is kept, in milliseconds. */
const GLUT_READY_MS = 800;

interface State {
  served?: Served;
  secret?: string;
  file?: string;
  editor?: VsCodeEditor;
  diffs?: Diffs;
  terminal?: vscode.Terminal;
}

const state: State = {};

/** The folders VS Code works in. */
function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
}

/** The editor's name for Glut: VS Code's own, or the fork's (Cursor, Windsurf). */
function ideName(): string {
  return vscode.env.appName || "VS Code";
}

async function listen(context: vscode.ExtensionContext): Promise<void> {
  const editor = new VsCodeEditor();
  const diffs = new Diffs(editor);
  const secret = lockfile.token();
  const version = String(context.extension.packageJSON.version ?? "0");
  lockfile.sweep();
  const served = await start(
    secret,
    (message, respond, connection) => handle(editor, diffs, version, ideName(), message, respond, connection),
    (connection) => diffs.ended(connection),
  );
  Object.assign(state, { served, secret, editor, diffs, file: lockfile.write(served.port, secret, ideName(), folders()) });
  context.subscriptions.push(
    editor,
    // The folders Glut finds this editor by follow VS Code's: the same port and token, the file written anew.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (state.served && state.secret) {
        state.file = lockfile.write(state.served.port, state.secret, ideName(), folders());
      }
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === state.terminal) {
        state.terminal = undefined;
      }
    }),
  );
}

/** Opens Glut's terminal, or shows the one there is; whether it was just started. */
function open(): boolean {
  if (state.terminal && state.terminal.exitStatus === undefined) {
    state.terminal.show(false);
    return false;
  }
  const config = vscode.workspace.getConfiguration("glut");
  const beside = config.get<string>("terminalLocation", "editor") === "editor";
  state.terminal = vscode.window.createTerminal({
    name: "Glut",
    shellPath: config.get<string>("command", "glut"),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    env: { GLUT_IDE_PORT: String(state.served?.port ?? "") },
    location: beside ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Panel,
  });
  state.terminal.show(false);
  return true;
}

/**
 * Puts `text` into Glut's input, unsent, and goes there — as a paste, never as keys: a key could answer a question of
 * Glut's that stands open.
 */
function typeIntoGlut(text: string): void {
  const started = open();
  const paste = () => {
    state.terminal?.sendText(`\u001b[200~${text}\u001b[201~`, false);
    state.terminal?.show(false);
  };
  if (started) {
    setTimeout(paste, GLUT_READY_MS);
  } else {
    paste();
  }
}

/** The document as Glut names it — relative below its folder — or `undefined` for a name a reference cannot carry. */
function relative(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") {
    void vscode.window.showWarningMessage("Glut: not a file");
    return undefined;
  }
  const name = vscode.workspace.asRelativePath(uri, false);
  // A space or a control character would end the reference, or act as a key.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    void vscode.window.showWarningMessage("Glut: this file's name cannot go into a reference");
    return undefined;
  }
  return name;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await listen(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("glut.open", () => open()),
    vscode.commands.registerCommand("glut.send", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const name = relative(editor.document.uri);
      if (!name) {
        return;
      }
      const { start: first, end } = editor.selection;
      // A selection that ends at a line's start does not take that line.
      const lastLine = end.character === 0 && end.line > first.line ? end.line : end.line + 1;
      const firstLine = first.line + 1;
      typeIntoGlut(firstLine === lastLine ? `@${name}#L${firstLine} ` : `@${name}#L${firstLine}-${lastLine} `);
    }),
    vscode.commands.registerCommand("glut.add", (uri?: vscode.Uri) => {
      // From the explorer's or an editor's menu the file it was opened on; from the palette the active one.
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const name = target ? relative(target) : undefined;
      if (name) {
        typeIntoGlut(`@${name} `);
      }
    }),
    vscode.commands.registerCommand("glut.acceptDiff", () => state.editor?.answerCurrent(true)),
    vscode.commands.registerCommand("glut.denyDiff", () => state.editor?.answerCurrent(false)),
  );
}

export async function deactivate(): Promise<void> {
  state.diffs?.closeAll();
  lockfile.remove(state.file);
  await state.served?.stop();
}
