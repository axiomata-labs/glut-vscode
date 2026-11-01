// The protocol's `Editor` in VS Code: the file the owner works on, the documents VS Code holds (unsaved changes too,
// never one opened for Glut), the language servers' diagnostics, and Glut's questions about edits as VS Code's own
// diffs — the file on the left, Glut's change on the right, which the owner may change before accepting.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { shown as plainly, type Context, type DiffAnswer, type DiffRequest, type Editor, type OpenFile } from "./protocol.ts";

/** The left side of a diff: the file as it is, read-only. */
const BEFORE = "glut-before";
/** The right side Glut proposes, which the owner may change: kept in memory, never on disk. */
const CHANGE = "glut-change";
/** The right side of a diff that takes no change of the owner's (a rename's file). */
const SHOWN = "glut-shown";

/** The largest selection handed over, in bytes: the protocol's 16 KB. */
const MOST_SELECTED = 16 * 1024;

/** `text` cut to at most `bytes` bytes of UTF-8, never inside a character. */
export function cut(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) {
    return text;
  }
  let out = "";
  let size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > bytes) {
      break;
    }
    out += char;
  }
  return out;
}

/** The schemes of Glut's own diff documents. */
export const SCHEMES = [BEFORE, CHANGE, SHOWN];

/** A path as the disk names it: links resolved where the file is there. */
function real(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** One diff shown, until the owner answers it or it goes. */
interface Shown {
  left: vscode.Uri;
  right: vscode.Uri;
  newText: string;
  /** The right side as VS Code loaded it (its line endings and BOM normalised): the owner changed it if it differs. */
  loaded?: string;
  editable: boolean;
  answer: (answer: DiffAnswer) => void;
}

/** `text` as the file Glut proposed writes it: its line endings and its BOM. */
export function asProposed(text: string, proposed: string): string {
  let out = text.replace(/\r\n/g, "\n");
  if (proposed.includes("\r\n")) {
    out = out.replace(/\n/g, "\r\n");
  }
  if (proposed.startsWith("\ufeff") && !out.startsWith("\ufeff")) {
    out = `\ufeff${out}`;
  }
  return out;
}

/** In-memory files for the right side of an editable diff: what the owner saves there stays here. */
class Changes implements vscode.FileSystemProvider {
  readonly texts = new Map<string, Uint8Array>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const bytes = this.texts.get(uri.toString());
    if (!bytes) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: bytes.length };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const bytes = this.texts.get(uri.toString());
    if (!bytes) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return bytes;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    // Only a diff's own side: nothing new is made here.
    if (!this.texts.has(uri.toString())) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    this.texts.set(uri.toString(), content);
  }

  delete(uri: vscode.Uri): void {
    this.texts.delete(uri.toString());
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

export class VsCodeEditor implements Editor, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changes = new Changes();
  private readonly readOnly = new Map<string, string>();
  private readonly diffs = new Map<string, Shown>();
  /** The last editor that showed a file of the disk: the owner's, while they type in Glut's terminal. */
  private active: vscode.TextEditor | undefined;

  constructor() {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.readOnly.get(uri.toString()) ?? "",
    };
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(BEFORE, provider),
      vscode.workspace.registerTextDocumentContentProvider(SHOWN, provider),
      vscode.workspace.registerFileSystemProvider(CHANGE, this.changes, { isCaseSensitive: true }),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor)),
      vscode.window.tabGroups.onDidChangeTabs((event) => this.tabsChanged(event)),
    );
    this.follow(vscode.window.activeTextEditor);
  }

  dispose(): void {
    for (const id of [...this.diffs.keys()]) {
      this.closeDiff(id);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private follow(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.uri.scheme === "file") {
      this.active = editor;
    }
    void vscode.commands.executeCommand("setContext", "glut.diffShown", this.current() !== undefined);
  }

  context(): Context {
    // The editor on screen for that document where there is one: a hidden editor's selection is not kept current.
    const editor =
      vscode.window.visibleTextEditors.find((visible) => visible.document === this.active?.document) ?? this.active;
    if (!editor || editor.document.isClosed) {
      return { activeFile: null };
    }
    const { selection, document } = editor;
    return {
      activeFile: {
        path: document.uri.fsPath,
        cursor: { line: selection.active.line + 1, character: selection.active.character + 1 },
        selection: selection.isEmpty
          ? null
          : {
              start: { line: selection.start.line + 1, character: selection.start.character + 1 },
              end: { line: selection.end.line + 1, character: selection.end.character + 1 },
              text: cut(document.getText(selection), MOST_SELECTED),
            },
      },
    };
  }

  openFiles(): OpenFile[] {
    const active = this.active?.document.uri.fsPath;
    const seen = new Set<string>();
    const files: OpenFile[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== "file") {
          continue;
        }
        const path = tab.input.uri.fsPath;
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        const file = { path, active: path === active, dirty: tab.isDirty };
        if (file.active) {
          files.unshift(file);
        } else {
          files.push(file);
        }
      }
    }
    return files;
  }

  /** The open document of exactly `path` — matched by its real path, never by a part of its name. */
  private document(path: string): vscode.TextDocument | undefined {
    if (!nodePath.isAbsolute(path)) {
      return undefined;
    }
    const wanted = real(path);
    return vscode.workspace.textDocuments.find(
      (document) => !document.isClosed && document.uri.scheme === "file" && real(document.uri.fsPath) === wanted,
    );
  }

  buffer(path: string): { path: string; text: string; dirty: boolean } | undefined {
    const document = this.document(path);
    return document ? { path: document.uri.fsPath, text: document.getText(), dirty: document.isDirty } : undefined;
  }

  diagnostics(path: string): { path: string; diagnostics: import("./protocol.ts").Diagnostic[] } | undefined {
    const document = this.document(path);
    if (!document) {
      return undefined;
    }
    const severities = ["error", "warning", "info", "hint"] as const;
    return {
      path: document.uri.fsPath,
      diagnostics: vscode.languages.getDiagnostics(document.uri).map((item) => ({
        line: item.range.start.line + 1,
        character: item.range.start.character + 1,
        severity: severities[item.severity] ?? "info",
        message: item.message,
        source: item.source,
      })),
    };
  }

  openDiff(request: DiffRequest, answer: (answer: DiffAnswer) => void): void {
    const name = nodePath.basename(request.path) || "file";
    // A nonce of its own: a diff shown again under the same id never shares the documents of the one before.
    const place = `/${randomBytes(8).toString("hex")}/${name}`;
    const left = vscode.Uri.from({ scheme: BEFORE, path: place });
    const right = vscode.Uri.from({ scheme: request.editable ? CHANGE : SHOWN, path: place });
    this.readOnly.set(left.toString(), request.oldText ?? "");
    if (request.editable) {
      this.changes.texts.set(right.toString(), new TextEncoder().encode(request.newText));
    } else {
      this.readOnly.set(right.toString(), request.newText);
    }
    const shown: Shown = { left, right, newText: request.newText, editable: request.editable, answer };
    this.diffs.set(request.id, shown);
    const title = `Glut: ${plainly(request.title || name)}`;
    // The owner types in Glut's terminal: the diff shows without the focus, so no key meant for Glut lands in it — and
    // beside the file they work on, never over Glut's own terminal.
    const options = { preview: false, preserveFocus: true, viewColumn: this.active?.viewColumn };
    vscode.commands.executeCommand("vscode.diff", left, right, title, options).then(
      () => {
        shown.loaded = vscode.workspace.textDocuments
          .find((open) => open.uri.toString() === right.toString())
          ?.getText();
      },
      () => this.settle(request.id, { outcome: "closed" }),
    );
    void vscode.window.showInformationMessage(`Glut asks about a change of ${plainly(name)}.`);
  }

  /** The id of the diff in the active tab, if it is one of Glut's. */
  current(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) {
      return undefined;
    }
    return this.byRight(input.modified);
  }

  /** The diff whose right side is `uri`, if it is one of Glut's. */
  private byRight(uri: vscode.Uri): string | undefined {
    const wanted = uri.toString();
    for (const [id, shown] of this.diffs) {
      if (shown.right.toString() === wanted) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * The owner answers a diff: the one whose title bar was clicked (`uri`, its right side) — its group need not have the
   * focus, which stays in Glut's terminal — or, from the palette, the one in the active tab.
   */
  answerCurrent(accepted: boolean, uri?: vscode.Uri): void {
    const id = uri instanceof vscode.Uri ? this.byRight(uri) : this.current();
    if (id === undefined) {
      void vscode.window.showWarningMessage("Glut: no diff of Glut's in this tab");
      return;
    }
    const shown = this.diffs.get(id);
    if (!shown) {
      return;
    }
    let text: string | undefined;
    if (accepted && shown.editable) {
      const document = vscode.workspace.textDocuments.find((open) => open.uri.toString() === shown.right.toString());
      const now = document?.getText();
      if (now !== undefined && now !== (shown.loaded ?? shown.newText)) {
        text = asProposed(now, shown.newText);
      }
    }
    this.settle(id, accepted ? { outcome: "accepted", text } : { outcome: "rejected" });
  }

  private settle(id: string, answer: DiffAnswer): void {
    const shown = this.diffs.get(id);
    if (!shown) {
      return;
    }
    this.diffs.delete(id);
    shown.answer(answer);
    void this.closeTabs(shown);
  }

  /** Closes a settled diff's tabs — its changed right side kept first, in memory, so VS Code asks nothing. */
  private async closeTabs(shown: Shown): Promise<void> {
    const document = vscode.workspace.textDocuments.find((open) => open.uri.toString() === shown.right.toString());
    if (document?.isDirty) {
      await document.save();
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === shown.right.toString()) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
    this.readOnly.delete(shown.left.toString());
    this.readOnly.delete(shown.right.toString());
    this.changes.texts.delete(shown.right.toString());
    void vscode.commands.executeCommand("setContext", "glut.diffShown", this.current() !== undefined);
  }

  /** A diff's tab the owner closed answers nothing: `closed`. */
  private tabsChanged(event: vscode.TabChangeEvent): void {
    const still = new Set(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input instanceof vscode.TabInputTextDiff ? tab.input.modified.toString() : "")),
    );
    for (const tab of event.closed) {
      if (!(tab.input instanceof vscode.TabInputTextDiff)) {
        continue;
      }
      const closed = tab.input.modified.toString();
      // A tab moved to another group or window is closed in one place and open in the other: it still asks.
      if (still.has(closed)) {
        continue;
      }
      for (const [id, shown] of this.diffs) {
        if (shown.right.toString() === closed) {
          this.settle(id, { outcome: "closed" });
        }
      }
    }
    void vscode.commands.executeCommand("setContext", "glut.diffShown", this.current() !== undefined);
  }

  closeDiff(id: string): boolean {
    const had = this.diffs.has(id);
    this.settle(id, { outcome: "closed" });
    return had;
  }

  changed(): void {
    // VS Code reads a file changed on disk again by itself where no unsaved change stands.
  }

  notify(message: string): void {
    void vscode.window.showInformationMessage(`Glut: ${plainly(message)}`);
  }
}
