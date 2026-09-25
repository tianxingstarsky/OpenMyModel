import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OutgoingHttpHeaders, validateHeaderName, validateHeaderValue } from "http";
import { WebSocketTunnel, RelayError } from "../services/websocket";
import { PlatformService } from "../services/platform";

const MAX_WRITE_QUEUE = 8 * 1024 * 1024;
const MAX_PROVIDER_OUTPUT_TOKENS = 65_536;

export function relayHeaders(headers: Record<string, unknown>): OutgoingHttpHeaders {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding",
    "upgrade", "content-length", "content-encoding", "set-cookie", "authorization", "www-authenticate",
    "authentication-info", "api-key", "x-api-key", "x-auth-token", "x-access-token", "x-goog-api-key",
    "x-llama-api-key", "x-node-api-key", "x-upstream-api-key",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-encoding" && value !== "identity") throw new RelayError("Unsupported upstream content encoding");
    if (name.toLowerCase() === "connection" && typeof value === "string") {
      for (const token of value.split(",")) blocked.add(token.trim().toLowerCase());
    }
  }
  const result: OutgoingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower.startsWith("access-control-")) continue;
    validateHeaderName(lower);
    if (typeof value !== "string" && !(Array.isArray(value) && value.every(item => typeof item === "string"))) {
      throw new RelayError("Invalid upstream header value");
    }
    for (const item of Array.isArray(value) ? value : [value]) validateHeaderValue(lower, item);
    result[lower] = value;
  }
  return result;
}

function requestCompletionBudget(body: Record<string, unknown>): { requestedMaxTokens?: number; completionCount: number } {
  const maxTokenValues = [body.max_tokens, body.max_completion_tokens, body.n_predict]
    .filter(value => value !== undefined && value !== null);
  if (maxTokenValues.some(value => typeof value !== "number" || !Number.isInteger(value)
    || value < 0 || value > MAX_PROVIDER_OUTPUT_TOKENS)) {
    throw new RelayError("max_tokens must be a non-negative integer", 400);
  }
  const requestedMaxTokens = maxTokenValues.length ? Math.min(...maxTokenValues as number[]) : undefined;
  const completionValues = [body.n, body.n_cmpl].filter(value => value !== undefined && value !== null);
  if (completionValues.some(value => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8)) {
    throw new RelayError("n must be an integer from 1 to 8", 400);
  }
  const completionCount = completionValues.length ? Math.min(...completionValues as number[]) : 1;
  if (requestedMaxTokens !== undefined && requestedMaxTokens * completionCount > MAX_PROVIDER_OUTPUT_TOKENS) {
    throw new RelayError(`The total output limit cannot exceed ${MAX_PROVIDER_OUTPUT_TOKENS} tokens`, 400);
  }
  return { requestedMaxTokens, completionCount };
}

function hasTextOnlyMessages(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.every(message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const content = (message as Record<string, unknown>).content;
    if (content === undefined || content === null || typeof content === "string") return true;
    return Array.isArray(content) && content.every(part => !!part && typeof part === "object" && !Array.isArray(part)
      && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string");
  });
}

function relayJson(tunnel: WebSocketTunnel, node: { nodeId: string; connectionId: string }, path: string,
  body: Record<string, unknown>, upstreamApiKey: string, signal: AbortSignal): Promise<Record<string, unknown>>;
function relayJson(tunnel: WebSocketTunnel, node: { nodeId: string; connectionId: string }, path: string,
  body: Record<string, unknown>, upstreamApiKey: string, signal: AbortSignal, unsupportedIsNull: true): Promise<Record<string, unknown> | null>;
async function relayJson(tunnel: WebSocketTunnel, node: { nodeId: string; connectionId: string }, path: string,
  body: Record<string, unknown>, upstreamApiKey: string, signal: AbortSignal,
  unsupportedIsNull = false): Promise<Record<string, unknown> | null> {
  let statusCode = 0;
  let raw: string;
  try {
    raw = await tunnel.relayHttp(node, { path, body: JSON.stringify(body), upstreamApiKey }, {
      signal, trackStats: false, onHeaders: status => { statusCode = status; },
    });
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("Node billing preflight failed", 503);
  }
  if (unsupportedIsNull && [400, 404, 405, 422].includes(statusCode)) return null;
  if (statusCode === 404) throw new RelayError("The compute node does not support balance-safe token billing", 503);
  if (statusCode === 429 || statusCode >= 500 || statusCode < 200) {
    throw new RelayError("Node is temporarily unable to calculate the request token budget", 503);
  }
  if (statusCode >= 400) throw new RelayError("Node could not calculate the request token budget", 400);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new RelayError("Node returned an invalid token budget response", 503);
  }
}

function tokenCount(response: Record<string, unknown>, label: string): number {
  if (Array.isArray(response.tokens) && response.tokens.every(token => Number.isSafeInteger(token) && (token as number) >= 0)) {
    return response.tokens.length;
  }
  if (Number.isSafeInteger(response.count) && (response.count as number) >= 0) return response.count as number;
  throw new RelayError(`Node did not return valid ${label} tokens`, 503);
}

async function managedPromptTokenCount(tunnel: WebSocketTunnel, node: { nodeId: string; connectionId: string },
  body: Record<string, unknown>, upstreamApiKey: string, signal: AbortSignal): Promise<number> {
  if (!hasTextOnlyMessages(body)) {
    throw new RelayError("Service-provider billing currently supports text-only chat messages", 400);
  }
  const templated = await relayJson(tunnel, node, "/apply-template", body, upstreamApiKey, signal, true);
  if (templated && typeof templated.prompt === "string") {
    const tokenized = await relayJson(tunnel, node, "/tokenize", {
      content: templated.prompt, add_special: true, parse_special: true,
    }, upstreamApiKey, signal);
    return tokenCount(tokenized, "prompt");
  }

  // vLLM renders chat templates and tokenizes messages in one request. This keeps
  // provider-mode prebilling accurate without requiring llama.cpp-only endpoints.
  const vllmRequest: Record<string, unknown> = {
    model: body.model, messages: body.messages, add_generation_prompt: true,
    add_special_tokens: false, continue_final_message: false,
  };
  for (const field of ["tools", "chat_template", "chat_template_kwargs"] as const) {
    if (body[field] !== undefined) vllmRequest[field] = body[field];
  }
  const tokenized = await relayJson(tunnel, node, "/tokenize", vllmRequest, upstreamApiKey, signal);
  return tokenCount(tokenized, "prompt");
}

async function managedCompletionTokenCount(tunnel: WebSocketTunnel, node: { nodeId: string; connectionId: string },
  texts: string[], model: string, upstreamApiKey: string, signal: AbortSignal): Promise<number> {
  let total = 0;
  for (const content of texts) {
    if (!content) continue;
    const vllmTokenized = await relayJson(tunnel, node, "/tokenize", {
      model, prompt: content, add_special_tokens: false,
    }, upstreamApiKey, signal, true);
    const tokenized = vllmTokenized ?? await relayJson(tunnel, node, "/tokenize", {
      content, add_special: false, parse_special: true,
    }, upstreamApiKey, signal);
    total += tokenCount(tokenized, "completion");
    if (!Number.isSafeInteger(total)) throw new RelayError("Node returned an invalid completion token count", 503);
  }
  return total;
}

class UsageCapture {
  private buffer = "";
  private bufferTruncated = false;
  private readonly completionText = new Map<string, string>();
  private completionTextLength = 0;
  prompt = 0;
  completion = 0;
  completionReported = false;
  completionTextTruncated = false;

  constructor(private readonly captureCompletionText: boolean) {}

  completionTexts(): string[] {
    return [...this.completionText.values()];
  }

  private appendCompletion(index: string, value: unknown): void {
    if (!this.captureCompletionText || typeof value !== "string" || !value) return;
    if (this.completionTextLength + value.length > 4 * 1024 * 1024) {
      this.completionTextTruncated = true;
      return;
    }
    this.completionTextLength += value.length;
    this.completionText.set(index, (this.completionText.get(index) || "") + value);
  }

  private appendContent(index: string, value: unknown): void {
    if (typeof value === "string") {
      this.appendCompletion(index, value);
    } else if (Array.isArray(value)) {
      for (const part of value) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
          this.appendCompletion(index, (part as Record<string, unknown>).text);
        }
      }
    }
  }

  private take(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, any>;
    const usage = item.usage && typeof item.usage === "object" ? item.usage : item;
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens;
    const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens;
    const numeric = (candidate: unknown): number | undefined => {
      if (typeof candidate !== "number" && typeof candidate !== "string") return undefined;
      if (typeof candidate === "string" && !candidate.trim()) return undefined;
      const parsed = Number(candidate);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const promptCount = numeric(prompt);
    const completionCount = numeric(completion);
    if (promptCount !== undefined) this.prompt = promptCount;
    if (completionCount !== undefined) {
      this.completion = completionCount;
      this.completionReported = true;
    }

    if (!this.captureCompletionText || !Array.isArray(item.choices)) return;
    item.choices.forEach((choice: unknown, position: number) => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
      const candidate = choice as Record<string, any>;
      const index = Number.isSafeInteger(candidate.index) && candidate.index >= 0 ? candidate.index : position;
      const outputIndex = `choice:${index}`;
      this.appendContent(outputIndex, candidate.delta?.content ?? candidate.message?.content ?? candidate.text);
      this.appendCompletion(outputIndex, candidate.delta?.reasoning_content ?? candidate.message?.reasoning_content);
      this.appendCompletion(outputIndex, candidate.delta?.reasoning ?? candidate.message?.reasoning);
      this.appendCompletion(outputIndex, candidate.delta?.refusal ?? candidate.message?.refusal);
      const calls = candidate.delta?.tool_calls ?? candidate.message?.tool_calls;
      if (Array.isArray(calls)) {
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          const call = calls[callIndex];
          if (!call || typeof call !== "object") continue;
          const outputIndex = `tool:${index}:${Number.isSafeInteger(call.index) ? call.index : callIndex}`;
          this.appendCompletion(outputIndex, call.function?.name);
          this.appendCompletion(outputIndex, call.function?.arguments);
        }
      }
    });
  }

  private takeTrailingUsage(): boolean {
    const marker = '"usage"';
    let match = this.buffer.lastIndexOf(marker);
    while (match >= 0) {
      let precedingBackslashes = 0;
      for (let index = match - 1; index >= 0 && this.buffer[index] === "\\"; index--) precedingBackslashes++;
      if (precedingBackslashes % 2 === 0) {
        let cursor = match + marker.length;
        while (/\s/.test(this.buffer[cursor] || "")) cursor++;
        if (this.buffer[cursor] === ":") {
          cursor++;
          while (/\s/.test(this.buffer[cursor] || "")) cursor++;
          if (this.buffer[cursor] === "{") {
            const start = cursor;
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (; cursor < this.buffer.length; cursor++) {
              const character = this.buffer[cursor];
              if (inString) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') inString = false;
              } else if (character === '"') inString = true;
              else if (character === "{") depth++;
              else if (character === "}" && --depth === 0) {
                try {
                  const usage = JSON.parse(this.buffer.slice(start, cursor + 1));
                  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
                    this.take({ usage });
                    return true;
                  }
                } catch { /* Try an earlier usage key if this occurrence was inside unrelated JSON text. */ }
                break;
              }
            }
          }
        }
      }
      match = this.buffer.lastIndexOf(marker, match - 1);
    }
    return false;
  }

  consume(chunk: string, streaming: boolean): void {
    if (!streaming) {
      const joined = this.buffer + chunk;
      if (joined.length > 4 * 1024 * 1024) {
        this.bufferTruncated = true;
        this.buffer = joined.slice(-4 * 1024 * 1024);
      } else this.buffer = joined;
      return;
    }
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-256 * 1024);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { this.take(JSON.parse(data)); } catch { /* Ignore non-JSON SSE event lines. */ }
    }
  }

  finish(streaming: boolean): { prompt: number; completion: number } {
    if (streaming && this.buffer.startsWith("data:")) {
      try { this.take(JSON.parse(this.buffer.slice(5).trim())); } catch { /* Incomplete final event. */ }
    }
    if (!streaming) {
      if (this.bufferTruncated) this.takeTrailingUsage();
      else try { this.take(JSON.parse(this.buffer)); } catch { /* Upstream may return a non-JSON error. */ }
    }
    return { prompt: this.prompt, completion: this.completion };
  }
}

export function registerOpenAIRoutes(app: FastifyInstance, tunnel: WebSocketTunnel, platform: PlatformService): void {
  app.get("/v1/models", async (request, reply) => {
    const authorization = request.headers.authorization;
    const rawKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const managedKey = rawKey ? platform.findGatewayKey(rawKey) : null;
    if (managedKey) {
      let modelFilter: string[];
      try {
        platform.checkGatewayKey(managedKey);
        modelFilter = platform.allowedModels(managedKey);
      }
      catch (error) { const status = error instanceof RelayError ? error.statusCode : 401; return reply.status(status).send({ error: { message: (error as Error).message, type: "authentication_error" } }); }
      return { object: "list", data: platform.publicModels(modelFilter) };
    }
    if (!rawKey) {
      return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });
    }
    if (platform.isProviderMode() || /^sk-oom-gw-/.test(rawKey)) {
      return reply.status(401).send({ error: { message: "Invalid API Key", type: "authentication_error" } });
    }
    try {
      const target = await tunnel.findNode(rawKey);
      platform.recordDirectRequest(platform.directKeyId(rawKey));
      const node = tunnel.getOnlineNodes().find(candidate => candidate.id === target.nodeId);
      if (!node?.serverRunning) throw new RelayError("Compute node unavailable", 503);
      return { object: "list", data: [{ id: node.modelName || "local-model", object: "model",
        created: Math.floor(Date.now() / 1000), owned_by: node.name }] };
    } catch (error) {
      const status = error instanceof RelayError ? error.statusCode : 502;
      return reply.status(status).send({ error: { message: error instanceof RelayError ? error.message : "Node authentication failed",
        type: status === 401 ? "authentication_error" : "server_error" } });
    }
  });

  const relayHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || (body.stream !== undefined && typeof body.stream !== "boolean")
      || (body.model !== undefined && typeof body.model !== "string")) {
      return reply.status(400).send({ error: { message: "Expected a JSON object with boolean stream and string model", type: "invalid_request_error" } });
    }
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ") || !auth.slice(7).trim()) {
      return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });
    }

    const rawKey = auth.slice(7).trim();
    const managedKey = platform.findGatewayKey(rawKey);
    if (platform.isProviderMode() && !managedKey) {
      return reply.status(401).send({ error: { message: "Use an API Key issued by this service", type: "authentication_error" } });
    }
    if (/^sk-oom-gw-/.test(rawKey) && !managedKey) {
      return reply.status(401).send({ error: { message: "Invalid API Key", type: "authentication_error" } });
    }
    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.on("aborted", disconnect);
    reply.raw.on("close", disconnect);
    reply.raw.on("error", disconnect);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    let publicModel = typeof body.model === "string" && body.model ? body.model : "local-model";
    let inputPrice = 0;
    let outputPrice = 0;
    let targetKeyId = platform.directKeyId(rawKey);
    let usageReservationId: string | undefined;
    let tokenReservationId: string | undefined;
    let stopUsageReservationHeartbeat: (() => void) | undefined;
    let reservedPromptTokens = 0;
    let upstreamHeadersReceived = false;
    let upstreamStatus = 200;
    let capture: UsageCapture | undefined;
    let node: { nodeId: string; connectionId: string } | undefined;
    let upstreamApiKey: string | undefined;
    let upstreamModel = "";

    const settledCompletionTokens = async (): Promise<number> => {
      if (!capture) return 0;
      const texts = capture.completionTexts();
      if ((!usageReservationId && !tokenReservationId)
        || (capture.completionReported && (capture.completion > 0 || texts.length === 0))) {
        return capture.completion;
      }
      if (!node || !upstreamApiKey) return capture.completion;
      if (capture.completionTextTruncated) {
        request.log.error({ model: publicModel }, "Completion text exceeded the token metering buffer");
        return capture.completion;
      }
      try {
        // Settlement must still finish if the caller disconnects after receiving part of a stream.
        return await managedCompletionTokenCount(tunnel, node, texts, upstreamModel,
          upstreamApiKey, AbortSignal.timeout(10_000));
      } catch (error) {
        request.log.error({ err: error, model: publicModel }, "Completion token usage was unavailable; charging reported usage only");
        return capture.completion;
      }
    };

    try {
      let relayBody = body;
      if (managedKey) {
        platform.checkGatewayKey(managedKey);
        const allowed = platform.allowedModels(managedKey);
        if (allowed.length && !allowed.includes(publicModel)) throw new RelayError("Model is not allowed for this API Key", 403);
        const route = await platform.selectManagedRoute(publicModel, controller.signal);
        node = { nodeId: route.nodeId, connectionId: route.connectionId };
        upstreamApiKey = route.upstreamKey;
        upstreamModel = route.upstreamModel;
        inputPrice = route.inputPrice;
        outputPrice = route.outputPrice;
        publicModel = route.publicName;
        targetKeyId = managedKey.id;
        relayBody = { ...body, model: route.upstreamModel };
        if (platform.isProviderMode() || managedKey.token_limit > 0) {
          const budget = requestCompletionBudget(body);
          reservedPromptTokens = await managedPromptTokenCount(tunnel, node, relayBody, upstreamApiKey, controller.signal);
          let maxTokens = budget.requestedMaxTokens;
          if (platform.isProviderMode()) {
            const reservation = platform.reserveProviderUsage(targetKeyId, reservedPromptTokens, budget.requestedMaxTokens,
              budget.completionCount, inputPrice, outputPrice);
            usageReservationId = reservation.id;
            tokenReservationId = reservation.tokenReservationId;
            maxTokens = reservation.maxTokens;
          } else {
            const reservation = platform.reserveGatewayTokenUsage(targetKeyId, reservedPromptTokens, budget.requestedMaxTokens,
              budget.completionCount);
            if (reservation.id) {
              tokenReservationId = reservation.id;
              maxTokens = reservation.maxTokens;
            }
          }
          if (usageReservationId || tokenReservationId) {
            stopUsageReservationHeartbeat = platform.startUsageReservationHeartbeat(usageReservationId, tokenReservationId,
              error => request.log.error({ err: error }, "Usage reservation heartbeat failed"));
          }
          if (maxTokens !== undefined || platform.isProviderMode()) {
            relayBody = { ...relayBody, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), n: budget.completionCount };
            delete relayBody.max_completion_tokens;
            delete relayBody.n_predict;
            delete relayBody.n_cmpl;
          }
        }
      } else {
        node = await tunnel.findNode(rawKey, body.model as string | undefined, controller.signal);
        platform.recordDirectRequest(targetKeyId);
      }
      if (body.stream === true) {
        const streamOptions = body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options)
          ? body.stream_options as Record<string, unknown> : {};
        relayBody = { ...relayBody, stream_options: { ...streamOptions, include_usage: true } };
      }
      capture = new UsageCapture(!!usageReservationId || !!tokenReservationId);
      await tunnel.relayHttp(node, { path: request.url, body: JSON.stringify(relayBody), upstreamApiKey }, {
        signal: controller.signal,
        onHeaders: (statusCode, headers) => {
          upstreamStatus = statusCode;
          upstreamHeadersReceived = true;
          const safeHeaders = relayHeaders(headers);
          if (!safeHeaders["content-type"]) safeHeaders["content-type"] = body.stream === true && statusCode < 400
            ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8";
          if (body.stream === true) safeHeaders["x-accel-buffering"] = "no";
          if (reply.raw.destroyed || controller.signal.aborted) throw new RelayError("HTTP client disconnected", 499);
          reply.hijack();
          reply.raw.writeHead(statusCode, { ...reply.getHeaders(), ...safeHeaders } as OutgoingHttpHeaders);
          reply.raw.flushHeaders();
        },
        onChunk: chunk => {
          if (reply.raw.destroyed || controller.signal.aborted) throw new RelayError("HTTP client disconnected", 499);
          if (reply.raw.writableLength + Buffer.byteLength(chunk) > MAX_WRITE_QUEUE) {
            throw new RelayError("Downstream response is too slow");
          }
          platform.refreshUsageReservations(usageReservationId, tokenReservationId);
          capture!.consume(chunk, body.stream === true);
          reply.raw.write(chunk, "utf8");
        },
      });
      const usage = capture.finish(body.stream === true);
      const completionTokens = await settledCompletionTokens();
      try {
        platform.recordUsage(targetKeyId, publicModel, "/v1/chat/completions",
          upstreamStatus < 400 ? (usage.prompt || reservedPromptTokens) : 0, upstreamStatus < 400 ? completionTokens : 0,
          request.ip, String(request.headers["user-agent"] || ""), inputPrice, outputPrice, usageReservationId, tokenReservationId);
        usageReservationId = undefined;
        tokenReservationId = undefined;
      } catch (error) { request.log.error({ err: error }, "Usage could not be recorded"); }
      if (!reply.raw.destroyed) reply.raw.end();
    } catch (error) {
      if (upstreamHeadersReceived && upstreamStatus < 400) {
        const partialUsage = capture?.finish(body.stream === true);
        const completionTokens = await settledCompletionTokens();
        try {
          platform.recordUsage(targetKeyId, publicModel, "/v1/chat/completions",
            partialUsage?.prompt || reservedPromptTokens, completionTokens,
            request.ip, String(request.headers["user-agent"] || ""), inputPrice, outputPrice, usageReservationId, tokenReservationId);
          usageReservationId = undefined;
          tokenReservationId = undefined;
        } catch (recordError) { request.log.error({ err: recordError }, "Partial usage could not be recorded"); }
      }
      if (reply.raw.destroyed || controller.signal.aborted) return;
      if (reply.raw.headersSent) {
        // Once upstream headers have been forwarded an error must abort the body.
        reply.raw.destroy();
        return;
      }
      const statusCode = error instanceof RelayError ? error.statusCode : 502;
      const type = statusCode === 401 ? "authentication_error"
        : statusCode === 400 ? "invalid_request_error"
          : statusCode === 402 ? "billing_error"
            : statusCode === 403 ? "permission_error"
              : statusCode === 429 ? "rate_limit_error" : "server_error";
      return reply.status(statusCode).send({ error: {
        message: error instanceof RelayError ? error.message : "Upstream request failed",
        type,
      } });
    } finally {
      stopUsageReservationHeartbeat?.();
      if (usageReservationId) platform.releaseProviderUsage(usageReservationId);
      if (tokenReservationId) platform.releaseGatewayTokenUsage(tokenReservationId);
      request.raw.off("aborted", disconnect);
      reply.raw.off("close", disconnect);
      reply.raw.off("error", disconnect);
    }
  };

  app.post("/v1/chat/completions", {
    onRequest: async (request, reply) => {
      const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
      if (!contentType || !/^application\/(?:json|[\w.+-]+\+json)$/.test(contentType)) {
        return reply.status(415).send({ error: { message: "Content-Type must be application/json", type: "invalid_request_error" } });
      }
    },
  }, relayHandler);
}
