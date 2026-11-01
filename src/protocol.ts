// The protocol's tools: what Glut may ask of the editor (docs/editor-protocol.md in Glut). `openFiles` and
// `diagnostics` are listed for its model; the rest Glut calls itself. Nothing here knows VS Code: an `Editor` answers,
// so the same tools are tested without one.

import type { Message, Respond } from "./server.ts";

/** A place in a file, 1-based. */
export interface Position {
  line: number;
  character: number;
}

/** The file the owner works on, as `getContext` answers. */
export interface Context {
  activeFile: {
    path: string;
    cursor: Position;
    selection: { start: Position; end: Position; text: string } | null;
  } | null;
}

/** One open file. */
export interface OpenFile {
  path: string;
  active: boolean;
  dirty: boolean;
}

/** A buffer the editor holds, as it holds it. */
export interface Buffer {
  path: string;
  text: string;
  dirty: boolean;
}

/** One finding of a language server. */
export interface Diagnostic {
  line: number;
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

/** A diff Glut asks about. */
export interface DiffRequest {
  id: string;
  path: string;
  oldText: string | null;
  newText: string;
  title: string;
  editable: boolean;
}

/** How the owner answered a diff; `text` is theirs where they changed the right side and accepted. */
export interface DiffAnswer {
  outcome: "accepted" | "rejected" | "closed";
  text?: string;
}

/** What the editor does for the protocol. */
export interface Editor {
  context(): Context;
  openFiles(): OpenFile[];
  /** The loaded buffer of exactly `path`, never one opened for it. */
  buffer(path: string): Buffer | undefined;
  /** The diagnostics of a loaded buffer of exactly `path`. */
  diagnostics(path: string): { path: string; diagnostics: Diagnostic[] } | undefined;
  /** Shows the diff; `answer` is called once the owner decided or the diff went. */
  openDiff(request: DiffRequest, answer: (answer: DiffAnswer) => void): void;
  /** Closes the diff `id`; whether there was one. */
  closeDiff(id: string): boolean;
  /** Glut wrote these files. */
  changed(paths: string[]): void;
  /** A word of Glut's to the owner. */
  notify(message: string): void;
}

/** The largest note `notify` shows, in characters. */
const MOST_NOTIFIED = 300;

function text(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function refusal(why: string): unknown {
  return { isError: true, content: [{ type: "text", text: why }] };
}

/** `value` as a string, or `undefined`. */
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Glut's words as plain words: control characters as spaces, at most [`MOST_NOTIFIED`] characters. */
export function plain(message: string): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "))
    .slice(0, MOST_NOTIFIED)
    .join("");
}

/** What `tools/list` shows Glut's model. */
const LISTED = [
  {
    name: "openFiles",
    description: "The files open in the owner's editor, the active first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "diagnostics",
    description: "A file's diagnostics, as the editor's language servers see its buffer.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

/** The diffs waiting for the owner, by id, with the connection that asked: its end closes them. */
export class Diffs {
  private readonly editor: Editor;
  /** Each diff by its id: an entry of its own, so a late answer of one shown before under the same id is dropped. */
  private readonly open = new Map<string, { connection: number }>();

  constructor(editor: Editor) {
    this.editor = editor;
  }

  show(request: DiffRequest, respond: Respond, connection: number): void {
    if (this.open.has(request.id)) {
      this.close(request.id);
    }
    const entry = { connection };
    this.open.set(request.id, entry);
    this.editor.openDiff(request, (answer) => {
      if (this.open.get(request.id) !== entry) {
        return;
      }
      this.open.delete(request.id);
      const out: DiffAnswer = { outcome: answer.outcome };
      if (answer.outcome === "accepted" && answer.text !== undefined) {
        out.text = answer.text;
      }
      respond(text(out));
    });
  }

  /** Closes the diff `id`: its question answers `closed`. */
  close(id: string): boolean {
    const had = this.open.has(id);
    this.editor.closeDiff(id);
    return had;
  }

  /** The connection `connection` ended: nobody waits for its diffs' answers. */
  ended(connection: number): void {
    for (const [id, entry] of [...this.open]) {
      if (entry.connection === connection) {
        this.close(id);
      }
    }
  }

  /** Closes every diff: the editor stops. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) {
      this.close(id);
    }
  }
}

/** Answers one JSON-RPC message of Glut's. */
export function handle(
  editor: Editor,
  diffs: Diffs,
  version: string,
  ide: string,
  message: Message,
  respond: Respond,
  connection: number,
): void {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return respond({
        protocolVersion: string(params.protocolVersion) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: ide, version },
      });
    case "tools/list":
      return respond({ tools: LISTED });
    case "ping":
      return respond({});
    case "tools/call":
      break;
    default:
      return respond(undefined, `no method ${String(message.method)}`);
  }
  const args =
    typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
  switch (params.name) {
    case "openFiles":
      return respond(text({ files: editor.openFiles() }));
    case "diagnostics": {
      const path = string(args.path);
      const found = path ? editor.diagnostics(path) : undefined;
      return respond(text(found ?? { diagnostics: [] }));
    }
    case "getContext":
      return respond(text(editor.context()));
    case "readBuffer": {
      const path = string(args.path);
      const buffer = path ? editor.buffer(path) : undefined;
      return respond(text(buffer ? { loaded: true, ...buffer } : { loaded: false }));
    }
    case "openDiff": {
      const id = string(args.id) ?? (typeof args.id === "number" ? String(args.id) : "");
      const path = string(args.path);
      const newText = string(args.newText);
      if (id === "" || path === undefined || newText === undefined) {
        return respond(undefined, "openDiff needs id, path and newText");
      }
      return diffs.show(
        {
          id,
          path,
          oldText: string(args.oldText) ?? null,
          newText,
          title: string(args.title) ?? "",
          editable: args.editable !== false,
        },
        respond,
        connection,
      );
    }
    case "closeDiff":
      return respond(text({ closed: diffs.close(String(args.id ?? "")) }));
    case "changed": {
      const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string") : [];
      editor.changed(paths);
      return respond(text({}));
    }
    case "notify": {
      const said = string(args.message);
      if (said !== undefined) {
        editor.notify(plain(said));
      }
      return respond(text({}));
    }
    default:
      return respond(refusal(`no tool ${String(params.name)}`));
  }
}
