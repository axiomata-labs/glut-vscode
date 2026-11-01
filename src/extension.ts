// glut for VS Code: Glut beside VS Code. The extension listens on loopback for Glut (docs/editor-protocol.md in Glut),
// tells it the file, the cursor and the selection you work on, hands it your documents as VS Code holds them, and
// shows its questions about edits as VS Code's own diffs. Glut itself runs in a terminal beside the editors (Glut:
// Open Glut) or anywhere else in this folder. Cursor and Windsurf, built on VS Code, take it as it is.

import * as path from "node:path";
import * as vscode from "vscode";
import * as lockfile from "./lockfile.ts";
import { Diffs, handle } from "./protocol.ts";
import { start, type Served } from "./server.ts";
import { SCHEMES, VsCodeEditor } from "./vscodeEditor.ts";

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
  let file: string;
  try {
    file = lockfile.write(served.port, secret, ideName(), folders());
  } catch (error) {
    await served.stop();
    editor.dispose();
    throw error;
  }
  Object.assign(state, { served, secret, editor, diffs, file });
  context.subscriptions.push(
    editor,
    // The folders Glut finds this editor by follow VS Code's: the same port and token, the file written anew.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (state.served && state.secret) {
        state.file = lockfile.write(state.served.port, state.secret, ideName(), folders());
      }
    }),
    // ⌘K in Glut's terminal draws Glut anew (⌃L) instead of clearing it: a cleared terminal leaves Glut blank.
    vscode.window.onDidChangeActiveTerminal((active) => {
      void vscode.commands.executeCommand("setContext", "glut.terminalActive", active !== undefined && active === state.terminal);
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
  // The owner's own setting alone: a folder's settings never choose the program that starts here.
  const command = config.inspect<string>("command")?.globalValue ?? "glut";
  state.terminal = vscode.window.createTerminal({
    name: "Glut",
    shellPath: command,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
    env: { GLUT_IDE_PORT: String(state.served?.port ?? "") },
    location: beside ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Panel,
  });
  state.terminal.show(false);
  void vscode.commands.executeCommand("setContext", "glut.terminalActive", true);
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
  // Below the folder Glut runs in (the first one); a file elsewhere by its whole path.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const below = root ? path.relative(root, uri.fsPath) : "";
  const name = root && below && !below.startsWith("..") && !path.isAbsolute(below) ? below : uri.fsPath;
  // A space, a control, bidi or zero-width character would end the reference, act as a key or hide what it names.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(name)) {
    void vscode.window.showWarningMessage("Glut: this file's name cannot go into a reference");
    return undefined;
  }
  return name;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Diffs of Glut's a window brought back from before answer nothing: their question went with the last session.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && SCHEMES.includes(input.modified.scheme)) {
        void vscode.window.tabGroups.close(tab, true);
      }
    }
  }
  await listen(context);
  // One click from anywhere: the status bar starts Glut, or shows the one there is.
  const item = vscode.window.createStatusBarItem("glut.open", vscode.StatusBarAlignment.Right, 100);
  item.name = "Glut";
  item.text = "$(flame) Glut";
  item.tooltip = "Open Glut";
  item.command = "glut.open";
  item.show();
  // The flame in the activity bar: its view holds the buttons, and opening it brings Glut to the front — not when a
  // window comes back with the view open, only when the owner clicks it.
  const view = vscode.window.createTreeView("glut.start", { treeDataProvider: { getChildren: () => [], getTreeItem: (item: vscode.TreeItem) => item } });
  context.subscriptions.push(
    item,
    view,
    view.onDidChangeVisibility(({ visible }) => {
      if (visible) {
        open();
      }
    }),
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
    vscode.commands.registerCommand("glut.acceptDiff", (uri?: vscode.Uri) => state.editor?.answerCurrent(true, uri)),
    vscode.commands.registerCommand("glut.denyDiff", (uri?: vscode.Uri) => state.editor?.answerCurrent(false, uri)),
  );
}

export async function deactivate(): Promise<void> {
  state.diffs?.closeAll();
  lockfile.remove(state.file);
  await state.served?.stop();
}
