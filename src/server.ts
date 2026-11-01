// The editor's side of Glut's editor protocol (docs/editor-protocol.md in Glut): MCP over HTTP on loopback, a bearer
// token on every request. Glut connects; this answers — one JSON-RPC message a request, JSON answers, keep-alive.
//
// A request is judged by its head alone before any of its body is read: without the token, or not `POST /mcp`, or
// with a length that is no plain number or any transfer encoding, it is answered and the connection closed.

import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";

/** The largest request body taken: a file's proposed text, not a disk. */
const MAX_BODY = 8 * 1024 * 1024;
/** The largest head of a request. */
const MAX_HEAD = 16 * 1024;
/** How many connections at once: Glut opens one for its questions and one for each diff. */
const MOST_CONNECTIONS = 32;
/** How long a connection may say nothing, with no question of its own waiting, before it is closed, in ms. */
const IDLE_MS = 60 * 1000;
/** How long a connection may take to show the token at all: a stranger holds no slot for long. */
const UNPROVEN_MS = 10 * 1000;

/** How long connections may wait; shorter in the tests. */
export interface Times {
  idleMs: number;
  unprovenMs: number;
}

/** A JSON-RPC message as Glut sends it. */
export interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Answers a request: a result, or why there is none. Called once; later calls are dropped. */
export type Respond = (result: unknown, failure?: string) => void;

/** Handles one message of the connection numbered `connection`. */
export type Handle = (message: Message, respond: Respond, connection: number) => void;

/** Compares two strings in time that does not depend on where they differ. */
export function same(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") {
    return false;
  }
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Why a head is refused, by its status; `undefined` where it may go on. */
export function judgeHead(request: http.IncomingMessage, token: string): number | undefined {
  // The token and the place first, by the head alone: nothing of a stranger's body is read.
  if (!same(request.headers.authorization, `Bearer ${token}`)) {
    return 401;
  }
  if (request.method !== "POST" || request.url !== "/mcp") {
    return 404;
  }
  if (request.headers["transfer-encoding"] !== undefined) {
    return 400;
  }
  const raw = request.rawHeaders;
  let lengths = 0;
  let length = "0";
  for (let at = 0; at < raw.length; at += 2) {
    if (raw[at].toLowerCase() === "content-length") {
      lengths += 1;
      length = raw[at + 1];
    }
  }
  if (lengths > 1 || !/^\s*\d{1,9}\s*$/.test(length)) {
    return 400;
  }
  if (Number(length) > MAX_BODY) {
    return 413;
  }
  return undefined;
}

/** A running server: its port, and how to stop it. */
export interface Served {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Serves `handle` for every JSON-RPC message with the right token; `closed(connection)` hears when a connection ends.
 */
export function start(
  token: string,
  handle: Handle,
  closed: (connection: number) => void,
  times: Times = { idleMs: IDLE_MS, unprovenMs: UNPROVEN_MS },
): Promise<Served> {
  let next = 0;
  const ids = new WeakMap<Socket, number>();
  const sockets = new Set<Socket>();
  const server = http.createServer({ maxHeaderSize: MAX_HEAD });
  server.maxConnections = MOST_CONNECTIONS;
  server.keepAliveTimeout = times.idleMs;
  server.headersTimeout = times.unprovenMs;
  // Questions of each connection still waiting for their answer (a diff waits for the owner): no idleness then.
  const waiting = new WeakMap<Socket, number>();
  // Glut waits for a diff as long as the owner takes: a request is not timed out, the connection's idleness is.
  server.requestTimeout = 0;
  server.on("connection", (socket: Socket) => {
    next += 1;
    ids.set(socket, next);
    sockets.add(socket);
    const connection = next;
    // Until a head with the token came, a short deadline; then idleness counts only while nothing waits.
    socket.setTimeout(times.unprovenMs, () => {
      if ((waiting.get(socket) ?? 0) === 0) {
        socket.destroy();
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      closed(connection);
    });
  });
  const refuse = (request: http.IncomingMessage, response: http.ServerResponse, status: number) => {
    response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
    response.end();
    request.socket.destroySoon();
  };
  // `Expect: 100-continue` is judged like any head: a stranger hears no "go on".
  server.on("checkContinue", (request: http.IncomingMessage, response: http.ServerResponse) => {
    const refused = judgeHead(request, token);
    if (refused !== undefined) {
      refuse(request, response, refused);
      return;
    }
    response.writeContinue();
    server.emit("request", request, response);
  });
  server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => {
    const refused = judgeHead(request, token);
    if (refused !== undefined) {
      refuse(request, response, refused);
      return;
    }
    const socket = request.socket;
    waiting.set(socket, (waiting.get(socket) ?? 0) + 1);
    socket.setTimeout(0);
    response.on("close", () => {
      const left = (waiting.get(socket) ?? 1) - 1;
      waiting.set(socket, left);
      if (left === 0 && !socket.destroyed) {
        socket.setTimeout(times.idleMs, () => {
          if ((waiting.get(socket) ?? 0) === 0) {
            socket.destroy();
          }
        });
      }
    });
    const connection = ids.get(request.socket) ?? 0;
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        request.socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      let message: Message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Message;
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        response.writeHead(400).end();
        return;
      }
      if (message.id === undefined || message.id === null) {
        // A notification: nothing to answer but that it came.
        try {
          handle(message, () => undefined, connection);
        } catch {
          // A notification has no one to tell.
        }
        response.writeHead(202).end();
        return;
      }
      let answered = false;
      const respond: Respond = (result, failure) => {
        if (answered || response.writableEnded) {
          return;
        }
        answered = true;
        const out: Record<string, unknown> = { jsonrpc: "2.0", id: message.id };
        if (failure !== undefined) {
          out.error = { code: -32603, message: failure };
        } else {
          out.result = result ?? {};
        }
        const body = JSON.stringify(out);
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
      };
      try {
        handle(message, respond, connection);
      } catch (error) {
        respond(undefined, String(error));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}
