// The extension's editor in VS Code's place (test/fake-vscode.mts): a diff shown without the focus, changed by the
// owner on its right side, answered with their text, and closed without a question to save; a rename's diff takes
// no change of the owner's; a tab the owner closes answers `closed`.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vscode") {
      return { url: new URL("./fake-vscode.mts", import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const vscode = await import("./fake-vscode.mts");
const { VsCodeEditor, cut, asProposed } = await import("../src/vscodeEditor.ts");

test("a diff takes the owner's own text, answers once and closes without asking to save", async () => {
  const editor = new VsCodeEditor();
  const answers: unknown[] = [];
  editor.openDiff(
    { id: "ask-1", path: "/w/a.ts", oldText: "a\n", newText: "b\n", title: "a.ts", editable: true },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(vscode.tabs(), 1);
  assert.equal(editor.current(), "ask-1");
  assert.ok(vscode.said.some((message) => message.includes("a.ts")), "the owner is told where the question is");
  vscode.ownerTypes("mine\n");
  editor.answerCurrent(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [{ outcome: "accepted", text: "mine\n" }]);
  assert.equal(vscode.tabs(), 0, "the tab closed — its changed side kept in memory, so nothing asks to save");

  editor.openDiff(
    { id: "ask-2", path: "/w/a.ts", oldText: "a\n", newText: "b\n", title: "a.ts", editable: true },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  editor.answerCurrent(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers[1], { outcome: "accepted", text: undefined }, "unchanged, no text of the owner's");
  editor.dispose();
});

test("a click on a diff's title bar answers that diff while the focus stays in Glut's terminal", async () => {
  const editor = new VsCodeEditor();
  const answers: unknown[] = [];
  editor.openDiff(
    { id: "ask-9", path: "/w/c.ts", oldText: "a\n", newText: "b\n", title: "c.ts", editable: true },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  vscode.ownerTypes("mine\n");
  const right = vscode.rightSide();
  vscode.ownerFocusesGlut();
  editor.answerCurrent(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [], "from the palette, with no diff in front, nothing is answered");
  editor.answerCurrent(true, new vscode.Uri("file", "/w/c.ts"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [], "a file's own title bar answers no diff");
  editor.answerCurrent(true, right);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [{ outcome: "accepted", text: "mine\n" }]);
  editor.dispose();
});

test("a rename's diff takes no change, and a tab closed by the owner answers closed", async () => {
  const editor = new VsCodeEditor();
  const answers: unknown[] = [];
  editor.openDiff(
    { id: "ask-3", path: "/w/b.ts", oldText: "a\n", newText: "b\n", title: "rename · b.ts", editable: false },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  editor.answerCurrent(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [{ outcome: "accepted", text: undefined }]);

  editor.openDiff(
    { id: "ask-4", path: "/w/b.ts", oldText: "a\n", newText: "b\n", title: "b.ts", editable: true },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await vscode.ownerCloses();
  assert.deepEqual(answers[1], { outcome: "closed" });
  assert.equal(editor.current(), undefined);
  editor.dispose();
});

test("a selection is cut on a character, never inside one", () => {
  assert.equal(cut("äää", 4), "ää");
  assert.equal(cut("abc", 16), "abc");
});

test("the owner's text keeps the proposed file's line endings and BOM, and a moved tab still asks", async () => {
  assert.equal(asProposed("a\nb\n", "x\r\ny\r\n"), "a\r\nb\r\n");
  assert.equal(asProposed("a\n", "\ufeffx\n"), "\ufeffa\n");
  assert.equal(asProposed("a\r\nb", "x\ny"), "a\nb");
  const editor = new VsCodeEditor();
  const answers: unknown[] = [];
  editor.openDiff(
    { id: "ask-6", path: "/w/c.ts", oldText: "a\r\n", newText: "b\r\n", title: "c.ts", editable: true },
    (answer) => answers.push(answer),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  vscode.ownerMoves();
  assert.equal(answers.length, 0, "moved, not closed");
  // VS Code loaded it with its own line endings; the owner touched nothing.
  editor.answerCurrent(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(answers, [{ outcome: "accepted", text: undefined }]);
  editor.dispose();
});
