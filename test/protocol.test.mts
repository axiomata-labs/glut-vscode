// The extension as Glut meets it, without VS Code: the server, the lock file and the tools against a stand-in editor.
// Run with `npm test`.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as lockfile from "../src/lockfile.ts";
import { Diffs, handle, plain, type DiffAnswer, type DiffRequest, type Editor } from "../src/protocol.ts";
import { start, type Served } from "../src/server.ts";

/** An editor that holds one unsaved buffer and keeps the diffs it was shown. */
class StandIn implements Editor {
  diffs = new Map<string, { request: DiffRequest; answer: (answer: DiffAnswer) => void }>();
  told: string[] = [];
  context() {
    return {
      activeFile: {
        path: "/w/a.ts",
        cursor: { line: 3, character: 1 },
        selection: { start: { line: 2, character: 1 }, end: { line: 4, character: 9 }, text: "fn a()" },
      },
    };
  }
  openFiles() {
    return [{ path: "/w/a.ts", active: true, dirty: true }];
  }
  buffer(file: string) {
    return file === "/w/a.ts" ? { path: "/w/a.ts", text: "unsaved\n", dirty: true } : undefined;
  }
  diagnostics(file: string) {
    return file === "/w/a.ts"
      ? { path: file, diagnostics: [{ line: 1, character: 2, severity: "error" as const, message: "no" }] }
      : undefined;
  }
  openDiff(request: DiffRequest, answer: (answer: DiffAnswer) => void) {
    this.diffs.set(request.id, { request, answer });
  }
  closeDiff(id: string) {
    const diff = this.diffs.get(id);
    this.diffs.delete(id);
    diff?.answer({ outcome: "closed" });
    return diff !== undefined;
  }
  changed() {}
  notify(message: string) {
    this.told.push(message);
  }
}

const SECRET = "0123456789abcdef0123456789abcdef";

async function serve(): Promise<{ served: Served; editor: StandIn }> {
  const editor = new StandIn();
  const diffs = new Diffs(editor);
  const served = await start(
    SECRET,
    (message, respond, connection) => handle(editor, diffs, "0.1.0", "Visual Studio Code", message, respond, connection),
    (connection) => diffs.ended(connection),
  );
  return { served, editor };
}

let id = 0;

/** One JSON-RPC call with the token; its result. */
async function call(port: number, method: string, params: unknown = {}): Promise<any> {
  id += 1;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await response.json()).result;
}

/** A tool's answer, read from its text. */
async function tool(port: number, name: string, args: unknown = {}): Promise<any> {
  const result = await call(port, "tools/call", { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

/** What the server answers bytes sent as they are, on a connection of their own. */
function raw(port: number, bytes: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(bytes));
    let said = "";
    socket.on("data", (chunk) => (said += chunk.toString()));
    socket.on("close", () => resolve(said));
    socket.on("error", () => resolve(said));
    setTimeout(() => socket.destroy(), 2000);
  });
}

test("the file Glut finds the editor by is the owner's alone, and a dead editor's goes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glut-vscode-"));
  const file = lockfile.write(4711, SECRET, "Visual Studio Code", ["/w"], home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(lockfile.dir(home)).mode & 0o777, 0o700);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written, {
    version: 1,
    port: 4711,
    pid: process.pid,
    ideName: "Visual Studio Code",
    workspaceFolders: ["/w"],
    authToken: SECRET,
  });
  const dead = path.join(lockfile.dir(home), "4712.json");
  fs.writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 + 17 }), { mode: 0o600 });
  lockfile.sweep(home);
  assert.ok(fs.existsSync(file), "a live editor's file stays");
  assert.ok(!fs.existsSync(dead), "a dead one's goes");
  lockfile.remove(file);
  assert.ok(!fs.existsSync(file));
  assert.match(lockfile.token(), /^[0-9a-f]{32}$/);
});

test("Glut hears the editor's place, its buffer and its diagnostics behind the token", async () => {
  const { served } = await serve();
  try {
    const init = await call(served.port, "initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.serverInfo.name, "Visual Studio Code");
    const listed = await call(served.port, "tools/list");
    assert.deepEqual(
      listed.tools.map((listedTool: { name: string }) => listedTool.name),
      ["openFiles", "diagnostics"],
    );
    assert.equal((await tool(served.port, "getContext")).activeFile.selection.text, "fn a()");
    assert.deepEqual(await tool(served.port, "readBuffer", { path: "/w/a.ts" }), {
      loaded: true,
      path: "/w/a.ts",
      text: "unsaved\n",
      dirty: true,
    });
    assert.deepEqual(await tool(served.port, "readBuffer", { path: "/w/a.ts.local" }), { loaded: false });
    assert.equal((await tool(served.port, "diagnostics", { path: "/w/a.ts" })).diagnostics[0].severity, "error");
    assert.deepEqual(await tool(served.port, "diagnostics", { path: "/w/nowhere" }), { diagnostics: [] });
  } finally {
    await served.stop();
  }
});

test("a stranger on the port is refused by the head, before any body is read", async () => {
  const { served } = await serve();
  try {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const noToken = await raw(
      served.port,
      `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    assert.match(noToken, /^HTTP\/1\.1 401/);
    const wrongPlace = await raw(served.port, `GET / HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${SECRET}\r\n\r\n`);
    assert.match(wrongPlace, /^HTTP\/1\.1 404/);
    const chunked = await raw(
      served.port,
      `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${SECRET}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    );
    assert.match(chunked, /^HTTP\/1\.1 400/);
    const nan = await raw(
      served.port,
      `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${SECRET}\r\nContent-Length: nan\r\n\r\n`,
    );
    assert.match(nan, /^HTTP\/1\.1 400/);
    // Still answering after all of them.
    assert.equal((await call(served.port, "ping")) !== undefined, true);
  } finally {
    await served.stop();
  }
});

test("a diff answers once the owner decided, with their own text; Glut closes one its card answered", async () => {
  const { served, editor } = await serve();
  try {
    const waiting = tool(served.port, "openDiff", {
      id: "ask-1",
      path: "/w/a.ts",
      oldText: "a\n",
      newText: "b\n",
      title: "a.ts",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const shown = editor.diffs.get("ask-1");
    assert.ok(shown && shown.request.editable, "an edit's diff takes the owner's change");
    shown.answer({ outcome: "accepted", text: "mine\n" });
    assert.deepEqual(await waiting, { outcome: "accepted", text: "mine\n" });

    const renamed = tool(served.port, "openDiff", {
      id: "ask-2",
      path: "/w/a.ts",
      oldText: "a\n",
      newText: "b\n",
      title: "rename · a.ts",
      editable: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(editor.diffs.get("ask-2")?.request.editable, false, "a rename's diff takes none");
    assert.deepEqual(await tool(served.port, "closeDiff", { id: "ask-2" }), { closed: true });
    assert.deepEqual(await renamed, { outcome: "closed" });
  } finally {
    await served.stop();
  }
});

test("a diff whose connection ended is closed, and Glut's note shows as plain words", async () => {
  const { served, editor } = await serve();
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "openDiff", arguments: { id: "ask-3", path: "/w/a.ts", oldText: null, newText: "x" } },
    });
    const socket = net.connect(served.port, "127.0.0.1", () =>
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${SECRET}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(editor.diffs.has("ask-3"));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!editor.diffs.has("ask-3"), "nobody waits for its answer any more");

    await tool(served.port, "notify", { message: "answer it in Glut\u001b[2J" });
    assert.deepEqual(editor.told, ["answer it in Glut [2J"]);
    assert.equal(plain("x".repeat(400)).length, 300);
    assert.equal(plain("…".repeat(400)), "…".repeat(300), "cut by characters, never inside one");
  } finally {
    await served.stop();
  }
});
