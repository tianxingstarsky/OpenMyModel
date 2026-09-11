import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { AuthResult } from "./auth";

export class RelayError extends Error {
  constructor(message: string, readonly statusCode = 502) { super(message); }
}

export interface NodeInfo {
  id: string;
  name: string;
  modelName: string;
  modelConfig: string;
  isOnline: boolean;
  serverRunning: boolean;
}

export interface TunnelOptions {
  authenticate: (password: unknown, address: string) => Promise<AuthResult>;
  onNodeChange?: (node: NodeInfo) => void;
  requestTimeoutMs?: number;
  keyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  authTimeoutMs?: number;
}

export interface RelayTarget {
  nodeId: string;
  connectionId: string;
}

export interface RelayOptions {
  requestId?: string;
  signal?: AbortSignal;
  onHeaders: (statusCode: number, headers: Record<string, unknown>) => void;
  onChunk?: (chunk: string) => void;
}

interface PendingRequest {
  kind: "key" | "http";
  resolve: (value: boolean | string) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  cleanup: () => void;
  headersReceived: boolean;
  chunks?: string[];
  onHeaders?: RelayOptions["onHeaders"];
  onChunk?: RelayOptions["onChunk"];
}

interface TunnelConnection {
  ws: WebSocket;
  connectionId: string;
  node: NodeInfo;
  authenticated: boolean;
  authenticating: boolean;
  retired: boolean;
  awaitingPong?: number;
  lastPing?: number;
  authTimeout?: NodeJS.Timeout;
  pending: Map<string, PendingRequest>;
}

export class WebSocketTunnel {
  private connections = new Map<string, TunnelConnection>();
  private sockets = new Set<TunnelConnection>();
  private heartbeat?: NodeJS.Timeout;
  private selectionCursor = 0;

  constructor(private readonly options: TunnelOptions) {}

  registerRoutes(app: FastifyInstance): void {
    app.get("/ws/node", { websocket: true }, (socket, request) => {
      const conn: TunnelConnection = {
        ws: socket, connectionId: randomUUID(),
        node: { id: "", name: "Unnamed node", modelName: "", modelConfig: "", isOnline: true, serverRunning: true },
        authenticated: false, authenticating: false, retired: false, pending: new Map(),
      };
      this.sockets.add(conn);
      conn.authTimeout = setTimeout(() => this.retire(conn, new RelayError("Node authentication timed out")), this.options.authTimeoutMs ?? 10000);
      socket.on("message", (raw) => {
        if (conn.retired) return;
        let msg: Record<string, unknown>;
        try {
          const text = raw.toString();
          if (!conn.authenticated && Buffer.byteLength(text) > 8192) throw new Error("Oversized authentication");
          msg = JSON.parse(text);
          if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new Error("Invalid message");
        } catch {
          this.retire(conn, new RelayError("Invalid node message"));
          return;
        }
        if (!conn.authenticated) {
          if (!conn.authenticating) void this.authenticate(conn, msg, request.ip);
          return;
        }
        if (this.connections.get(conn.node.id) !== conn) return;
        try {
          this.handleMessage(conn, msg);
        } catch {
          this.retire(conn, new RelayError("Invalid relay response"));
        }
      });
      socket.on("pong", () => this.pong(conn));
      socket.on("close", () => this.retire(conn, new RelayError("Compute node disconnected")));
      socket.on("error", () => this.retire(conn, new RelayError("Compute node connection failed")));
    });
  }

  private async authenticate(conn: TunnelConnection, msg: Record<string, unknown>, address: string): Promise<void> {
    if (msg.type !== "auth") {
      this.send(conn, { type: "auth_required", message: "Authenticate first" });
      return;
    }
    conn.authenticating = true;
    try {
      const result = await this.options.authenticate(msg.password, address);
      if (conn.retired || conn.ws.readyState !== WebSocket.OPEN) return;
      if (result !== "ok") {
        this.send(conn, { type: "auth_error", message: result === "limited" ? "Too many authentication attempts" : "Invalid password" });
        conn.ws.close(1008, "Authentication failed");
        return;
      }
      conn.authenticated = true;
      clearTimeout(conn.authTimeout);
      conn.node = {
        id: typeof msg.nodeId === "string" && msg.nodeId.length > 0 && msg.nodeId.length <= 256 ? msg.nodeId : randomUUID(),
        name: typeof msg.nodeName === "string" ? msg.nodeName : "Unnamed node",
        modelName: typeof msg.modelName === "string" ? msg.modelName : "",
        modelConfig: typeof msg.modelConfig === "string" ? msg.modelConfig : "",
        serverRunning: typeof msg.serverRunning === "boolean" ? msg.serverRunning : true,
        isOnline: true,
      };
      const previous = this.connections.get(conn.node.id);
      this.connections.set(conn.node.id, conn);
      if (previous) this.retire(previous, new RelayError("Compute node connection replaced"));
      this.options.onNodeChange?.({ ...conn.node });
      this.send(conn, { type: "auth_ok", nodeId: conn.node.id, message: "Connected" });
    } catch {
      this.retire(conn, new RelayError("Node authentication failed"));
    } finally {
      conn.authenticating = false;
    }
  }

  private handleMessage(conn: TunnelConnection, msg: Record<string, unknown>): void {
    if (msg.type === "pong") { this.pong(conn); return; }
    if (msg.type === "status_update") {
      if (typeof msg.modelName === "string") conn.node.modelName = msg.modelName;
      if (typeof msg.serverRunning === "boolean") conn.node.serverRunning = msg.serverRunning;
      this.options.onNodeChange?.({ ...conn.node });
      return;
    }
    if (typeof msg.requestId !== "string") return;
    const pending = conn.pending.get(msg.requestId);
    if (!pending) return;
    const fail = (message: string) => this.fail(conn, msg.requestId as string, new RelayError(message), true);
    if (pending.kind === "key") {
      if (msg.type === "key_valid") this.finish(conn, msg.requestId, msg.valid === true);
      return;
    }
    switch (msg.type) {
      case "http_headers":
        if (pending.headersReceived || !Number.isInteger(msg.statusCode) || (msg.statusCode as number) < 200
          || (msg.statusCode as number) > 599 || !msg.headers || typeof msg.headers !== "object" || Array.isArray(msg.headers)) {
          fail("Invalid upstream headers"); return;
        }
        try {
          pending.onHeaders!(msg.statusCode as number, msg.headers as Record<string, unknown>);
          pending.headersReceived = true;
          this.arm(conn, msg.requestId, pending);
        } catch { fail("Invalid upstream headers"); }
        break;
      case "http_chunk":
        if (!pending.headersReceived) { fail("Upstream omitted http_headers; update the compute node bridge"); return; }
        if (typeof msg.data !== "string") { fail("Invalid upstream chunk"); return; }
        try {
          if (pending.onChunk) pending.onChunk(msg.data);
          else pending.chunks!.push(msg.data);
          this.arm(conn, msg.requestId, pending);
        } catch { fail("Downstream response unavailable"); }
        break;
      case "http_done":
        if (!pending.headersReceived) { fail("Upstream completed without headers"); return; }
        this.finish(conn, msg.requestId, pending.chunks?.join("") ?? "");
        break;
      case "http_error":
        this.fail(conn, msg.requestId, new RelayError(
          typeof msg.message === "string" ? msg.message : "Upstream request failed",
          Number.isInteger(msg.statusCode) && (msg.statusCode as number) >= 400 && (msg.statusCode as number) <= 599
            ? msg.statusCode as number : 502,
        ));
        break;
    }
  }

  private send(conn: TunnelConnection, message: object): boolean {
    if (conn.retired || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(message), (error) => {
        if (error) this.retire(conn, new RelayError("Compute node send failed"));
      });
      return true;
    } catch { return false; }
  }

  private arm(conn: TunnelConnection, requestId: string, pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    // The pending entry always owns the current idle timer, including after chunks.
    if (conn.pending.get(requestId) !== pending) return;
    pending.timeout = setTimeout(() => {
      this.fail(conn, requestId, new RelayError("Upstream request timed out", 504), true);
    }, pending.kind === "key" ? this.options.keyTimeoutMs ?? 10000 : this.options.requestTimeoutMs ?? 120000);
  }

  private take(conn: TunnelConnection, requestId: string): PendingRequest | undefined {
    const pending = conn.pending.get(requestId);
    if (pending) {
      conn.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.cleanup();
    }
    return pending;
  }

  private finish(conn: TunnelConnection, requestId: string, value: string | boolean): void {
    this.take(conn, requestId)?.resolve(value);
  }

  private fail(conn: TunnelConnection, requestId: string, error: Error, cancel = false): void {
    const pending = this.take(conn, requestId);
    if (!pending) return;
    if (cancel) this.send(conn, { type: "cancel_request", requestId });
    pending.reject(error);
  }

  private addPending(conn: TunnelConnection, requestId: string, pending: PendingRequest, signal?: AbortSignal): void {
    if (conn.pending.has(requestId)) throw new RelayError("Duplicate request ID");
    conn.pending.set(requestId, pending);
    const abort = () => this.fail(conn, requestId, new RelayError("HTTP client disconnected", 499), true);
    pending.cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    this.arm(conn, requestId, pending);
    if (signal?.aborted) abort();
  }

  async validateKey(apiKey: string, nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const conn = this.connections.get(nodeId);
    if (!conn || conn.retired) throw new RelayError("Compute node disconnected");
    return new Promise<boolean>((resolve, reject) => {
      const requestId = randomUUID();
      this.addPending(conn, requestId, {
        kind: "key", resolve: value => resolve(value === true), reject, cleanup: () => {}, headersReceived: false,
      }, signal);
      if (conn.pending.has(requestId) && !this.send(conn, { type: "validate_key", requestId, key: apiKey })) {
        this.fail(conn, requestId, new RelayError("Compute node send failed"));
      }
    });
  }

  async findNode(apiKey: string, model?: string, signal?: AbortSignal): Promise<RelayTarget> {
    const available = [...this.connections.values()].filter(conn => !conn.retired && conn.authenticated
      && conn.ws.readyState === WebSocket.OPEN && conn.node.serverRunning);
    if (!available.length) throw new RelayError("No compute node online", 503);
    const cursor = this.selectionCursor++;
    const rotate = (group: TunnelConnection[]) => {
      const start = group.length ? cursor % group.length : 0;
      return [...group.slice(start), ...group.slice(0, start)];
    };
    const candidates = !model || model === "local-model" ? rotate(available) : [
      ...rotate(available.filter(conn => conn.node.modelName === model)),
      ...rotate(available.filter(conn => !conn.node.modelName || conn.node.modelName === "local-model")),
    ];
    if (!candidates.length) throw new RelayError("Requested model is not available", 404);
    let failure: Error | undefined;
    for (const conn of candidates) {
      if (signal?.aborted) throw new RelayError("HTTP client disconnected", 499);
      try {
        // Probe one candidate at a time. Only the actual key owner receives the body.
        if (await this.validateKey(apiKey, conn.node.id, signal)) {
          if (this.connections.get(conn.node.id) === conn && conn.node.serverRunning) return { nodeId: conn.node.id, connectionId: conn.connectionId };
          failure = new RelayError("Compute node changed during key validation");
        }
      } catch (error) {
        failure = error as Error;
      }
    }
    if (failure) throw failure;
    throw new RelayError("Invalid API Key", 401);
  }

  relayHttp(target: RelayTarget, request: { path: string; body: string }, options: RelayOptions): Promise<string> {
    const conn = this.connections.get(target.nodeId);
    if (!conn || conn.connectionId !== target.connectionId || conn.retired || !conn.node.serverRunning) {
      return Promise.reject(new RelayError("Compute node unavailable or replaced"));
    }
    return new Promise((resolve, reject) => {
      const requestId = options.requestId ?? randomUUID();
      this.addPending(conn, requestId, {
        kind: "http", resolve: value => resolve(value as string), reject, cleanup: () => {}, headersReceived: false,
        chunks: options.onChunk ? undefined : [], onHeaders: options.onHeaders, onChunk: options.onChunk,
      }, options.signal);
      if (conn.pending.has(requestId) && !this.send(conn, { type: "http_relay", requestId, path: request.path, body: request.body, method: "POST" })) {
        this.fail(conn, requestId, new RelayError("Compute node send failed"));
      }
    });
  }

  cancelRelay(nodeId: string, requestId: string): void {
    const conn = this.connections.get(nodeId);
    if (conn) this.fail(conn, requestId, new RelayError("HTTP client disconnected", 499), true);
  }

  getOnlineNodes(): NodeInfo[] {
    return [...this.connections.values()].map(conn => ({ ...conn.node }));
  }

  get pendingRequestCount(): number {
    return [...this.sockets].reduce((sum, conn) => sum + conn.pending.size, 0);
  }

  private pong(conn: TunnelConnection): void {
    if (conn.retired || !conn.authenticated || this.connections.get(conn.node.id) !== conn) return;
    conn.awaitingPong = undefined;
    this.options.onNodeChange?.({ ...conn.node });
  }

  private retire(conn: TunnelConnection, error: Error): void {
    if (conn.retired) return;
    conn.retired = true;
    clearTimeout(conn.authTimeout);
    this.sockets.delete(conn);
    for (const id of conn.pending.keys()) this.fail(conn, id, error);
    if (this.connections.get(conn.node.id) === conn) {
      this.connections.delete(conn.node.id);
      this.options.onNodeChange?.({ ...conn.node, isOnline: false });
    }
    if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate();
  }

  startHeartbeat(): void {
    if (this.heartbeat) return;
    const interval = this.options.heartbeatIntervalMs ?? 30000;
    const timeout = this.options.heartbeatTimeoutMs ?? 10000;
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const conn of this.connections.values()) {
        if (conn.awaitingPong !== undefined) {
          if (now - conn.awaitingPong >= timeout) this.retire(conn, new RelayError("Compute node heartbeat timed out"));
        } else if (conn.lastPing === undefined || now - conn.lastPing >= interval) {
          conn.awaitingPong = now;
          conn.lastPing = now;
          if (!this.send(conn, { type: "ping" })) { this.retire(conn, new RelayError("Compute node disconnected")); continue; }
          try { conn.ws.ping(); } catch { this.retire(conn, new RelayError("Compute node disconnected")); }
        }
      }
    }, Math.min(interval, timeout));
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const conn of this.sockets) this.retire(conn, new RelayError("Backend shutting down"));
  }
}
