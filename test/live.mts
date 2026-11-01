// Serves the extension's protocol with a stand-in editor under a home of its own, for Glut's live test:
//   node test/live.mts <home>   then   GLUT_IDE_HOME=<home> cargo test -p glut-tui --lib ide::live -- --ignored
import * as lockfile from "../src/lockfile.ts";
import { Diffs, handle, type DiffAnswer, type DiffRequest, type Editor } from "../src/protocol.ts";
import { start } from "../src/server.ts";

const home = process.argv[2];
const editor: Editor = {
  context: () => ({ activeFile: { path: "/w/a.ts", cursor: { line: 1, character: 1 }, selection: null } }),
  openFiles: () => [{ path: "/w/a.ts", active: true, dirty: true }],
  buffer: (file) => (file === "/w/a.ts" ? { path: file, text: "unsaved\n", dirty: true } : undefined),
  diagnostics: () => undefined,
  openDiff: (request: DiffRequest, answer: (answer: DiffAnswer) => void) => {
    shown.set(request.id, answer);
  },
  closeDiff: (id) => {
    const answer = shown.get(id);
    shown.delete(id);
    answer?.({ outcome: "closed" });
    return answer !== undefined;
  },
  changed: () => undefined,
  notify: () => undefined,
};
const shown = new Map<string, (answer: DiffAnswer) => void>();
const diffs = new Diffs(editor);
const secret = lockfile.token();
const served = await start(
  secret,
  (message, respond, connection) => handle(editor, diffs, "0.1.0", "Visual Studio Code", message, respond, connection),
  (connection) => diffs.ended(connection),
);
lockfile.write(served.port, secret, "Visual Studio Code", ["/w"], home);
console.log(`listening on ${served.port}`);
