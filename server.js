const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const net = require("node:net");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4311);
const STATIC_DIR = path.join(__dirname, "public");
const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || path.resolve(__dirname, "..");
const MAX_HISTORY = 600;
const SSE_HISTORY_LIMIT = 220;
const MAX_FRAME_SIZE = 256 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const HISTORY_PAYLOAD_MAX_BYTES = 64 * 1024;
const HISTORY_PAYLOAD_PREVIEW_CHARS = 12000;
const IPC_RECONNECT_MS = 1000;
const APP_RESTART_MS = 1500;
const APP_REQUEST_TIMEOUT_MS = 45000;
const IPC_REQUEST_TIMEOUT_MS = 12000;
const TRACE_DIR = path.join(__dirname, "traces");
const TRACE_RETENTION = 20;

const METHOD_VERSION = {
  "thread-stream-state-changed": 4,
  "thread-archived": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-interrupt-turn": 1,
  "thread-follower-set-model-and-reasoning": 1,
  "thread-follower-set-collaboration-mode": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const state = {
  ipc: {
    socketPath: null,
    transportConnected: false,
    initialized: false,
    clientId: null,
    lastError: null
  },
  app: {
    executablePath: null,
    running: false,
    initialized: false,
    pid: null,
    userAgent: null,
    lastError: null
  }
};

const history = [];
const historyFullPayloadById = new Map();
const threadOwnerClientById = new Map();
const sseClients = new Set();
const traceState = {
  active: null,
  recent: []
};

function nowIso() {
  return new Date().toISOString();
}

function toErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function ensureTraceDir() {
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  } catch {
    // best effort
  }
}

function compactTraceSummary(summary) {
  return {
    id: summary.id,
    label: summary.label,
    startedAt: summary.startedAt,
    stoppedAt: summary.stoppedAt || null,
    filePath: summary.filePath,
    eventCount: summary.eventCount || 0,
    active: Boolean(summary.active)
  };
}

function pushRecentTrace(summary) {
  const compact = compactTraceSummary(summary);
  traceState.recent.unshift(compact);
  if (traceState.recent.length > TRACE_RETENTION) {
    traceState.recent = traceState.recent.slice(0, TRACE_RETENTION);
  }
}

function startTraceSession(label = "") {
  if (traceState.active) {
    throw new Error("A trace is already active");
  }

  ensureTraceDir();
  const id = `${Date.now()}-${randomUUID()}`;
  const safeLabel =
    typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : "trace";
  const filePath = path.join(TRACE_DIR, `${id}.ndjson`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const startedAt = nowIso();

  traceState.active = {
    id,
    label: safeLabel,
    filePath,
    startedAt,
    stoppedAt: null,
    eventCount: 0,
    stream,
    active: true
  };

  stream.write(
    `${JSON.stringify({
      type: "trace-start",
      id,
      label: safeLabel,
      startedAt
    })}\n`
  );

  return compactTraceSummary(traceState.active);
}

function stopTraceSession() {
  if (!traceState.active) {
    throw new Error("No active trace");
  }

  const session = traceState.active;
  const stoppedAt = nowIso();
  session.stoppedAt = stoppedAt;
  session.active = false;
  session.stream.write(
    `${JSON.stringify({
      type: "trace-stop",
      id: session.id,
      stoppedAt
    })}\n`
  );
  session.stream.end();
  traceState.active = null;
  pushRecentTrace(session);
  return compactTraceSummary(session);
}

function recordTraceEvent(entry) {
  const session = traceState.active;
  if (!session) {
    return;
  }
  try {
    session.stream.write(`${JSON.stringify(entry)}\n`);
    session.eventCount += 1;
  } catch {
    // best effort
  }
}

function markTraceEvent(note = "") {
  const session = traceState.active;
  if (!session) {
    throw new Error("No active trace");
  }
  const marker = {
    type: "trace-marker",
    id: session.id,
    at: nowIso(),
    note: typeof note === "string" ? note : ""
  };
  recordTraceEvent(marker);
  return marker;
}

function getTraceStatusPayload() {
  const active = traceState.active ? compactTraceSummary(traceState.active) : null;
  return {
    active,
    recent: traceState.recent
  };
}

function findTraceSummaryById(traceId) {
  if (!traceId) {
    return null;
  }
  if (traceState.active && traceState.active.id === traceId) {
    return compactTraceSummary(traceState.active);
  }
  return traceState.recent.find((item) => item.id === traceId) || null;
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastSse(payload) {
  for (const res of sseClients) {
    sendSse(res, payload);
  }
}

function updateNestedState(section, patch) {
  Object.assign(state[section], patch);
  broadcastSse({ type: "state", state });
}

function summarizePayloadForHistory(payload) {
  try {
    const serialized = JSON.stringify(payload);
    const sizeBytes = Buffer.byteLength(serialized);
    if (sizeBytes <= HISTORY_PAYLOAD_MAX_BYTES) {
      return payload;
    }
    return {
      _truncated: true,
      _originalSizeBytes: sizeBytes,
      preview: serialized.slice(0, HISTORY_PAYLOAD_PREVIEW_CHARS)
    };
  } catch (error) {
    return {
      _truncated: true,
      _reason: "non-serializable-payload",
      error: toErrorMessage(error)
    };
  }
}

function extractThreadIdFromNotification(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const params = message.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  return (
    params.threadId ||
    params.conversationId ||
    params.thread?.id ||
    params.msg?.thread_id ||
    params.msg?.threadId ||
    params.msg?.conversationId ||
    null
  );
}

function pushHistory(source, direction, payload, meta = {}) {
  const entryId = randomUUID();
  const normalizedMeta = { ...meta };
  if (!normalizedMeta.method && payload && typeof payload === "object") {
    if (typeof payload.method === "string") {
      normalizedMeta.method = payload.method;
    } else if (typeof payload.type === "string") {
      normalizedMeta.method = payload.type;
    }
  }
  if (!normalizedMeta.threadId) {
    const inferredThreadId = extractThreadIdFromNotification(payload);
    if (inferredThreadId) {
      normalizedMeta.threadId = inferredThreadId;
    }
  }

  const fullEntry = {
    id: entryId,
    at: nowIso(),
    source,
    direction,
    payload,
    meta: normalizedMeta
  };

  if (
    source === "ipc" &&
    direction === "in" &&
    normalizedMeta.threadId &&
    payload &&
    typeof payload === "object" &&
    payload.method === "thread-stream-state-changed" &&
    typeof payload.sourceClientId === "string" &&
    payload.sourceClientId.trim()
  ) {
    threadOwnerClientById.set(normalizedMeta.threadId, payload.sourceClientId.trim());
  }

  historyFullPayloadById.set(entryId, payload);
  recordTraceEvent({
    type: "history",
    ...fullEntry
  });

  const entry = {
    id: entryId,
    at: fullEntry.at,
    source,
    direction,
    payload: summarizePayloadForHistory(payload),
    meta: normalizedMeta
  };

  history.push(entry);
  if (history.length > MAX_HISTORY) {
    const removed = history.shift();
    if (removed?.id) {
      historyFullPayloadById.delete(removed.id);
    }
  }

  broadcastSse({ type: "message", entry });
}

function findHistoryEntryById(entryId) {
  if (!entryId) {
    return null;
  }
  return history.find((entry) => entry.id === entryId) || null;
}

function getHistoryFullPayload(entryId) {
  if (!entryId) {
    return null;
  }
  return historyFullPayloadById.get(entryId) || null;
}

function getKnownThreadOwnerClientId(threadId) {
  if (!threadId) {
    return null;
  }
  return threadOwnerClientById.get(threadId) || null;
}

function findLatestConversationStateSnapshot(threadId) {
  if (!threadId) {
    return null;
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (
      entry.source !== "ipc" ||
      entry.direction !== "in" ||
      entry.meta?.threadId !== threadId ||
      entry.meta?.method !== "thread-stream-state-changed"
    ) {
      continue;
    }
    const payload = getHistoryFullPayload(entry.id) || entry.payload || {};
    const params = payload.params && typeof payload.params === "object" ? payload.params : {};
    const change = params.change && typeof params.change === "object" ? params.change : {};
    if (change.type !== "snapshot") {
      continue;
    }
    if (change.conversationState && typeof change.conversationState === "object") {
      return change.conversationState;
    }
  }
  return null;
}

function buildTurnStartParamsTemplate(threadId, text, body = {}) {
  const snapshot = findLatestConversationStateSnapshot(threadId);
  const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
  let template = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.params && typeof turns[i].params === "object") {
      template = turns[i].params;
      break;
    }
  }

  if (!template) {
    throw new Error(
      "No turn params template found in stream snapshots for this thread."
    );
  }

  let nextParams;
  try {
    nextParams = JSON.parse(JSON.stringify(template));
  } catch {
    throw new Error("Turn params template is not serializable.");
  }

  nextParams.threadId = threadId;
  nextParams.input = [{ type: "text", text }];

  if (typeof body.cwd === "string" && body.cwd.trim()) {
    nextParams.cwd = body.cwd.trim();
  }
  if (typeof body.model === "string" && body.model.trim()) {
    nextParams.model = body.model.trim();
  }
  if (typeof body.effort === "string" && body.effort.trim()) {
    nextParams.effort = body.effort.trim();
  }
  if (typeof body.summary === "string" && body.summary.trim()) {
    nextParams.summary = body.summary.trim();
  }
  if (!Array.isArray(nextParams.attachments)) {
    nextParams.attachments = [];
  }

  return nextParams;
}

function pushSystem(source, message, details) {
  const payload = details ? { message, details } : { message };
  pushHistory(source, "system", payload);
}

function versionForMethod(method) {
  return METHOD_VERSION[method] ?? 0;
}

function resolveIpcSocketPath() {
  if (process.env.CODEX_IPC_SOCKET) {
    return process.env.CODEX_IPC_SOCKET;
  }

  if (process.platform === "win32") {
    return "\\\\.\\pipe\\codex-ipc";
  }

  const tempDir = path.join(os.tmpdir(), "codex-ipc");
  const uid = process.getuid ? process.getuid() : null;
  const fileName = uid != null ? `ipc-${uid}.sock` : "ipc.sock";
  return path.join(tempDir, fileName);
}

function resolveCodexExecutablePath() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const desktopPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (fs.existsSync(desktopPath)) {
    return desktopPath;
  }

  return "codex";
}

class CodexIpcClient {
  constructor() {
    this.socketPath = resolveIpcSocketPath();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectTimer = null;
    this.connecting = false;
    this.clientId = null;
    this.pendingResponses = new Map();
    updateNestedState("ipc", { socketPath: this.socketPath });
  }

  connect() {
    if (this.connecting || this.socket) {
      return;
    }

    this.connecting = true;
    pushSystem("ipc", "Connecting to desktop socket", { socketPath: this.socketPath });

    const socket = net.createConnection(this.socketPath);
    this.socket = socket;

    socket.on("connect", () => {
      this.connecting = false;
      this.buffer = Buffer.alloc(0);
      updateNestedState("ipc", {
        transportConnected: true,
        initialized: false,
        clientId: null,
        lastError: null
      });
      pushSystem("ipc", "Connected to desktop socket");
      try {
        this.sendInitialize();
      } catch (error) {
        updateNestedState("ipc", { lastError: toErrorMessage(error) });
        pushSystem("ipc", "Failed to initialize desktop socket", {
          error: toErrorMessage(error)
        });
        socket.destroy();
      }
    });

    socket.on("data", (chunk) => {
      this.handleData(chunk);
    });

    socket.on("error", (error) => {
      updateNestedState("ipc", { lastError: toErrorMessage(error) });
      pushSystem("ipc", "Desktop socket error", { error: toErrorMessage(error) });
    });

    socket.on("close", () => {
      this.connecting = false;
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this.clientId = null;
      this.rejectPendingResponses(new Error("Desktop socket closed"));
      updateNestedState("ipc", {
        transportConnected: false,
        initialized: false,
        clientId: null
      });
      pushSystem("ipc", "Desktop socket closed");
      this.scheduleReconnect();
    });
  }

  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connecting = false;
    this.connect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, IPC_RECONNECT_MS);
  }

  sendInitialize() {
    const initializeMessage = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: "initializing-client",
      version: 1,
      method: "initialize",
      params: {
        clientType: "codex-monitor-web"
      }
    };

    this.sendFrame(initializeMessage);
  }

  buildRequestMessage(method, params, targetClientId, versionOverride) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Desktop socket is not connected.");
    }

    const version =
      Number.isInteger(versionOverride) && versionOverride >= 0
        ? versionOverride
        : versionForMethod(method);

    const requestMessage = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: this.clientId || "initializing-client",
      version,
      method,
      params
    };

    if (targetClientId && targetClientId.trim()) {
      requestMessage.targetClientId = targetClientId.trim();
    }

    return requestMessage;
  }

  sendRequest(method, params, targetClientId, versionOverride) {
    const requestMessage = this.buildRequestMessage(
      method,
      params,
      targetClientId,
      versionOverride
    );
    this.sendFrame(requestMessage);
    return requestMessage.requestId;
  }

  sendRequestAndWait(method, params, options = {}) {
    const {
      targetClientId = null,
      versionOverride = null,
      timeoutMs = IPC_REQUEST_TIMEOUT_MS
    } = options;

    const requestMessage = this.buildRequestMessage(
      method,
      params,
      targetClientId,
      versionOverride
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestMessage.requestId);
        reject(new Error(`IPC request timed out: ${method}`));
      }, timeoutMs);

      this.pendingResponses.set(requestMessage.requestId, {
        resolve,
        reject,
        timer,
        method
      });

      try {
        this.sendFrame(requestMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pendingResponses.delete(requestMessage.requestId);
        reject(error);
      }
    });
  }

  sendRawRequestAndWait(requestMessage, options = {}) {
    if (!requestMessage || typeof requestMessage !== "object") {
      throw new Error("Raw request must be an object.");
    }
    if (requestMessage.type !== "request") {
      throw new Error("Raw request type must be 'request'.");
    }
    if (typeof requestMessage.requestId !== "string" || !requestMessage.requestId.trim()) {
      throw new Error("Raw request must include requestId.");
    }

    const timeoutMs = Math.max(
      1000,
      Number.isInteger(options.timeoutMs) ? options.timeoutMs : IPC_REQUEST_TIMEOUT_MS
    );
    const requestId = requestMessage.requestId.trim();
    const method = typeof requestMessage.method === "string" ? requestMessage.method : "unknown";

    if (this.pendingResponses.has(requestId)) {
      throw new Error(`RequestId is already pending: ${requestId}`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`IPC raw request timed out: ${method}`));
      }, timeoutMs);

      this.pendingResponses.set(requestId, {
        resolve,
        reject,
        timer,
        method
      });

      try {
        this.sendFrame(requestMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pendingResponses.delete(requestId);
        reject(error);
      }
    });
  }

  sendBroadcast(method, params, versionOverride) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Desktop socket is not connected.");
    }

    const version =
      Number.isInteger(versionOverride) && versionOverride >= 0
        ? versionOverride
        : versionForMethod(method);

    const broadcastMessage = {
      type: "broadcast",
      sourceClientId: this.clientId || "initializing-client",
      version,
      method,
      params
    };

    this.sendFrame(broadcastMessage);
  }

  sendRawMessage(message) {
    if (!message || typeof message !== "object") {
      throw new Error("Raw message must be an object.");
    }
    this.sendFrame(message);
  }

  rejectPendingResponses(error) {
    for (const { reject, timer } of this.pendingResponses.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pendingResponses.clear();
  }

  sendFrame(message) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Desktop socket is not connected.");
    }

    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.socket.write(Buffer.concat([header, body]));
    pushHistory("ipc", "out", message);
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (frameLength > MAX_FRAME_SIZE) {
        pushSystem("ipc", "Desktop frame too large, closing", { frameLength });
        this.socket?.destroy();
        return;
      }

      if (this.buffer.length < frameLength + 4) {
        return;
      }

      const frameBody = this.buffer.subarray(4, frameLength + 4);
      this.buffer = this.buffer.subarray(frameLength + 4);

      let parsed;
      try {
        parsed = JSON.parse(frameBody.toString("utf8"));
      } catch (error) {
        pushSystem("ipc", "Failed to parse desktop frame", {
          error: toErrorMessage(error)
        });
        continue;
      }

      this.handleIncomingMessage(parsed);
    }
  }

  handleIncomingMessage(message) {
    pushHistory("ipc", "in", message);

    if (
      message &&
      message.type === "response" &&
      typeof message.requestId === "string"
    ) {
      const pending = this.pendingResponses.get(message.requestId);
      if (pending) {
        this.pendingResponses.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.resultType === "error") {
          pending.reject(
            new Error(
              message.error ? String(message.error) : `IPC request failed: ${pending.method}`
            )
          );
        } else {
          pending.resolve(message);
        }
      }
    }

    if (
      message &&
      message.type === "client-discovery-request" &&
      typeof message.requestId === "string"
    ) {
      const requested =
        message.request && typeof message.request === "object"
          ? message.request
          : null;
      const method = typeof requested?.method === "string" ? requested.method : "";
      const expectedVersion = versionForMethod(method);
      const requestVersion =
        Number.isInteger(requested?.version) && requested.version >= 0
          ? requested.version
          : 0;
      const canHandle = false;

      try {
        this.sendFrame({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: {
            canHandle: canHandle && requestVersion === expectedVersion
          }
        });
      } catch (error) {
        pushSystem("ipc", "Failed to answer client-discovery-request", {
          requestId: message.requestId,
          method,
          requestVersion,
          expectedVersion,
          error: toErrorMessage(error)
        });
      }
      return;
    }

    if (
      message &&
      message.type === "request" &&
      typeof message.requestId === "string"
    ) {
      try {
        this.sendFrame({
          type: "response",
          requestId: message.requestId,
          resultType: "error",
          error: "no-handler-for-request"
        });
      } catch (error) {
        pushSystem("ipc", "Failed to answer inbound request", {
          requestId: message.requestId,
          method: message.method || null,
          error: toErrorMessage(error)
        });
      }
      return;
    }

    if (
      message &&
      message.type === "response" &&
      message.method === "initialize" &&
      message.resultType === "success" &&
      message.result &&
      typeof message.result.clientId === "string"
    ) {
      this.clientId = message.result.clientId;
      updateNestedState("ipc", {
        initialized: true,
        clientId: this.clientId,
        lastError: null
      });
      pushSystem("ipc", "Monitor client initialized", { clientId: this.clientId });
    }
  }
}

class AppServerClient {
  constructor() {
    this.executablePath = resolveCodexExecutablePath();
    this.proc = null;
    this.stdoutInterface = null;
    this.pendingRequests = new Map();
    this.activeTurnsByThread = new Map();
    this.nextId = 1;
    this.restartingTimer = null;
    this.starting = false;
    this.readyWaiters = new Set();

    updateNestedState("app", { executablePath: this.executablePath });
  }

  start() {
    if (this.starting || this.proc) {
      return;
    }

    this.starting = true;
    pushSystem("app", "Starting app-server process", {
      executablePath: this.executablePath,
      cwd: DEFAULT_WORKSPACE
    });

    const proc = spawn(this.executablePath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: DEFAULT_WORKSPACE,
      env: process.env
    });

    this.proc = proc;

    proc.once("spawn", () => {
      this.starting = false;
      updateNestedState("app", {
        running: true,
        initialized: false,
        pid: proc.pid,
        userAgent: null,
        lastError: null
      });
      pushSystem("app", "app-server process started", { pid: proc.pid });
      this.initializeHandshake();
    });

    proc.on("error", (error) => {
      this.starting = false;
      updateNestedState("app", { lastError: toErrorMessage(error) });
      pushSystem("app", "app-server process error", { error: toErrorMessage(error) });
    });

    proc.on("close", (code, signal) => {
      this.handleProcessClosed(code, signal);
    });

    if (proc.stdout) {
      this.stdoutInterface = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity
      });
      this.stdoutInterface.on("line", (line) => {
        this.handleStdoutLine(line);
      });
    }

    if (proc.stderr) {
      const stderrReader = readline.createInterface({
        input: proc.stderr,
        crlfDelay: Infinity
      });
      stderrReader.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        pushHistory("app", "stderr", { line });
      });
    }
  }

  restartNow() {
    if (this.restartingTimer) {
      clearTimeout(this.restartingTimer);
      this.restartingTimer = null;
    }

    this.stopProcess("manual restart");
    this.start();
  }

  stopProcess(reason) {
    if (!this.proc) {
      return;
    }

    pushSystem("app", "Stopping app-server process", { reason });

    const proc = this.proc;
    this.proc = null;

    try {
      proc.kill();
    } catch (error) {
      pushSystem("app", "Failed to kill app-server process", {
        error: toErrorMessage(error)
      });
    }
  }

  handleProcessClosed(code, signal) {
    if (this.stdoutInterface) {
      this.stdoutInterface.close();
      this.stdoutInterface = null;
    }

    this.starting = false;
    this.proc = null;
    this.activeTurnsByThread.clear();

    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error("app-server closed"));
    }
    this.pendingRequests.clear();

    updateNestedState("app", {
      running: false,
      initialized: false,
      pid: null,
      userAgent: null
    });

    pushSystem("app", "app-server process closed", { code, signal });
    this.rejectReadyWaiters(new Error("app-server closed"));
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.restartingTimer) {
      return;
    }

    this.restartingTimer = setTimeout(() => {
      this.restartingTimer = null;
      this.start();
    }, APP_RESTART_MS);
  }

  async waitUntilReady(timeoutMs = 15000) {
    if (state.app.initialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error("Timed out waiting for app-server initialization"));
      }, timeoutMs);

      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };

      this.readyWaiters.add(waiter);
      this.start();
    });
  }

  resolveReadyWaiters() {
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  rejectReadyWaiters(error) {
    for (const waiter of this.readyWaiters) {
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  async initializeHandshake() {
    try {
      const result = await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex-monitor-web",
            version: "0.2.0"
          },
          capabilities: {
            experimentalApi: true
          }
        },
        {
          allowBeforeReady: true,
          timeoutMs: 20000
        }
      );

      updateNestedState("app", {
        initialized: true,
        userAgent: result?.userAgent || null,
        lastError: null
      });

      pushSystem("app", "app-server initialized", {
        userAgent: result?.userAgent || null
      });
      this.resolveReadyWaiters();
    } catch (error) {
      updateNestedState("app", {
        initialized: false,
        lastError: toErrorMessage(error)
      });
      pushSystem("app", "app-server initialize failed", {
        error: toErrorMessage(error)
      });
      this.rejectReadyWaiters(new Error(toErrorMessage(error)));
    }
  }

  handleStdoutLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      pushSystem("app", "Failed to parse app-server line", {
        line,
        error: toErrorMessage(error)
      });
      return;
    }

    const isNotification =
      message &&
      typeof message === "object" &&
      typeof message.method === "string" &&
      message.id === undefined;

    const threadId = isNotification ? extractThreadIdFromNotification(message) : null;
    const meta = isNotification ? { method: message.method, threadId } : {};

    pushHistory(
      "app",
      isNotification ? "in-notification" : "in-response",
      message,
      meta
    );

    if (isNotification) {
      if (message.method === "turn/started") {
        const threadIdFromEvent = message.params?.threadId;
        const turnIdFromEvent = message.params?.turn?.id;
        if (threadIdFromEvent && turnIdFromEvent) {
          this.activeTurnsByThread.set(threadIdFromEvent, turnIdFromEvent);
        }
      } else if (message.method === "turn/completed") {
        const threadIdFromEvent = message.params?.threadId;
        if (threadIdFromEvent) {
          this.activeTurnsByThread.delete(threadIdFromEvent);
        }
      }

      broadcastSse({
        type: "appNotification",
        method: message.method,
        threadId
      });
    }

    if (message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        const errMessage =
          message.error.message || message.error.error || JSON.stringify(message.error);
        pending.reject(new Error(errMessage));
        return;
      }

      if (pending.method === "turn/start") {
        const startedThreadId = pending.requestPayload?.params?.threadId;
        const startedTurnId = message.result?.turn?.id;
        if (startedThreadId && startedTurnId) {
          this.activeTurnsByThread.set(startedThreadId, startedTurnId);
        }
      } else if (pending.method === "turn/interrupt") {
        const interruptedThreadId = pending.requestPayload?.params?.threadId;
        if (interruptedThreadId) {
          this.activeTurnsByThread.delete(interruptedThreadId);
        }
      }

      pending.resolve(message.result);
    }
  }

  sendLine(message) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("app-server process is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params = {}, options = {}) {
    const {
      allowBeforeReady = false,
      timeoutMs = APP_REQUEST_TIMEOUT_MS
    } = options;

    if (!allowBeforeReady) {
      await this.waitUntilReady();
    } else {
      this.start();
    }

    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("app-server is not running");
    }

    const id = this.nextId++;
    const requestPayload = {
      id,
      method,
      params
    };

    pushHistory("app", "out-request", requestPayload, { method });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        method,
        requestPayload
      });

      try {
        this.sendLine(requestPayload);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async listThreads(limit = 50, archived = false, cursor = null) {
    const params = { limit, archived };
    if (typeof cursor === "string" && cursor.trim()) {
      params.cursor = cursor.trim();
    }
    return this.request("thread/list", params);
  }

  async listThreadsAll(options = {}) {
    const {
      limit = 100,
      archived = false,
      cursor = null,
      maxPages = 12
    } = options;

    const mergedData = [];
    let nextCursor = cursor;
    let pageCount = 0;

    while (pageCount < maxPages) {
      const result = await this.listThreads(limit, archived, nextCursor);
      const pageData = Array.isArray(result.data) ? result.data : [];
      mergedData.push(...pageData);
      pageCount += 1;

      const responseCursor =
        typeof result.nextCursor === "string" && result.nextCursor.trim()
          ? result.nextCursor.trim()
          : null;

      if (!responseCursor || pageData.length === 0) {
        nextCursor = null;
        break;
      }

      nextCursor = responseCursor;
    }

    return {
      data: mergedData,
      nextCursor,
      pages: pageCount,
      truncated: Boolean(nextCursor)
    };
  }

  async readThread(threadId, includeTurns = true) {
    return this.request("thread/read", {
      threadId,
      includeTurns
    });
  }

  async startThread(threadParams = {}) {
    return this.request("thread/start", threadParams);
  }

  async startTurn(threadId, text, options = {}) {
    try {
      await this.request("thread/resume", { threadId });
    } catch {
      // Best effort: some threads may already be loaded or in-progress.
    }

    const params = {
      threadId,
      input: [{ type: "text", text }],
      ...options
    };
    try {
      return await this.request("turn/start", params);
    } catch (error) {
      const message = toErrorMessage(error);
      if (!message.toLowerCase().includes("thread not found")) {
        throw error;
      }

      await this.request("thread/resume", { threadId });
      return this.request("turn/start", params);
    }
  }

  async listModels(limit = 100) {
    return this.request("model/list", { limit });
  }

  async findActiveTurn(threadId) {
    const trackedTurnId = this.activeTurnsByThread.get(threadId);
    if (trackedTurnId) {
      return { id: trackedTurnId, status: "inProgress" };
    }

    const response = await this.readThread(threadId, true);
    const turns = Array.isArray(response.thread?.turns) ? response.thread.turns : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].status === "inProgress") {
        return turns[i];
      }
    }
    return null;
  }

  async interruptTurn(threadId, turnId = null) {
    let finalTurnId = turnId;
    if (!finalTurnId) {
      const activeTurn = await this.findActiveTurn(threadId);
      if (!activeTurn) {
        throw new Error("No active turn found for this thread.");
      }
      finalTurnId = activeTurn.id;
    }

    try {
      const result = await this.request("turn/interrupt", {
        threadId,
        turnId: finalTurnId
      });
      return {
        ...result,
        turnId: finalTurnId
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (!message.toLowerCase().includes("thread not found")) {
        throw error;
      }

      await this.request("thread/resume", { threadId });
      const result = await this.request("turn/interrupt", {
        threadId,
        turnId: finalTurnId
      });
      return {
        ...result,
        turnId: finalTurnId
      };
    }
  }
}

const ipcClient = new CodexIpcClient();
const appClient = new AppServerClient();
ipcClient.connect();
appClient.start();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function badRequest(res, message) {
  sendJson(res, 400, { ok: false, error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function parseBooleanQuery(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

function parseOptionalInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

async function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(decodeURIComponent(requestPath));
  const absolutePath = path.join(STATIC_DIR, safePath);

  if (!absolutePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let fileBuffer;
  try {
    fileBuffer = await fsPromises.readFile(absolutePath);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileBuffer.length
  });
  res.end(fileBuffer);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = requestUrl;
  const segments = pathname.split("/").filter(Boolean);

  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("\n");

    sseClients.add(res);
    sendSse(res, { type: "state", state });
    sendSse(res, {
      type: "history",
      messages: history.slice(-SSE_HISTORY_LIMIT)
    });

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, { ok: true, state, historySize: history.length });
    return;
  }

  if (req.method === "GET" && segments[0] === "api" && segments[1] === "history" && segments.length === 3) {
    const entryId = decodeURIComponent(segments[2] || "");
    const entry = findHistoryEntryById(entryId);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: "History entry not found" });
      return;
    }
    const fullPayload = getHistoryFullPayload(entryId);
    sendJson(res, 200, {
      ok: true,
      entry,
      fullPayload: fullPayload || null
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/trace/status") {
    sendJson(res, 200, { ok: true, ...getTraceStatusPayload() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trace/start") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    try {
      const trace = startTraceSession(body?.label || "");
      sendJson(res, 200, { ok: true, trace });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trace/mark") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    try {
      const marker = markTraceEvent(body?.note || "");
      sendJson(res, 200, { ok: true, marker });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trace/stop") {
    try {
      const trace = stopTraceSession();
      sendJson(res, 200, { ok: true, trace });
    } catch (error) {
      sendJson(res, 409, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (
    req.method === "GET" &&
    segments[0] === "api" &&
    segments[1] === "trace" &&
    segments[3] === "download"
  ) {
    const traceId = decodeURIComponent(segments[2] || "");
    const trace = findTraceSummaryById(traceId);
    if (!trace) {
      sendJson(res, 404, { ok: false, error: "Trace not found" });
      return;
    }

    try {
      const stat = await fsPromises.stat(trace.filePath);
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename=\"${trace.id}.ndjson\"`
      });
      fs.createReadStream(trace.filePath).pipe(res);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/reconnect") {
    ipcClient.reconnectNow();
    appClient.restartNow();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/reconnect-ipc") {
    ipcClient.reconnectNow();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/app/restart") {
    appClient.restartNow();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/threads") {
    try {
      const limit = parseOptionalInteger(searchParams.get("limit"), 50);
      const archived = parseBooleanQuery(searchParams.get("archived"), false);
      const cursor =
        typeof searchParams.get("cursor") === "string" &&
        searchParams.get("cursor").trim()
          ? searchParams.get("cursor").trim()
          : null;
      const all = parseBooleanQuery(searchParams.get("all"), false);
      const maxPagesRaw = parseOptionalInteger(searchParams.get("maxPages"), 12);
      const maxPages = Math.max(1, Math.min(maxPagesRaw, 40));

      const result = all
        ? await appClient.listThreadsAll({ limit, archived, cursor, maxPages })
        : await appClient.listThreads(limit, archived, cursor);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/models") {
    try {
      const limit = parseOptionalInteger(searchParams.get("limit"), 100);
      const result = await appClient.listModels(limit);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/thread/start") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    const params = {};
    params.cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : DEFAULT_WORKSPACE;
    if (typeof body.model === "string" && body.model.trim()) {
      params.model = body.model.trim();
    }
    if (typeof body.modelProvider === "string" && body.modelProvider.trim()) {
      params.modelProvider = body.modelProvider.trim();
    }
    if (typeof body.personality === "string" && body.personality.trim()) {
      params.personality = body.personality.trim();
    }
    if (typeof body.sandbox === "string" && body.sandbox.trim()) {
      params.sandbox = body.sandbox.trim();
    }
    if (typeof body.approvalPolicy === "string" && body.approvalPolicy.trim()) {
      params.approvalPolicy = body.approvalPolicy.trim();
    }
    if (typeof body.ephemeral === "boolean") {
      params.ephemeral = body.ephemeral;
    }

    try {
      const result = await appClient.startThread(params);
      sendJson(res, 200, { ok: true, path: "app-server", ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (
    segments[0] === "api" &&
    segments[1] === "thread" &&
    segments.length >= 3
  ) {
    const threadId = decodeURIComponent(segments[2]);

    if (req.method === "GET" && segments.length === 3) {
      const includeTurns = parseBooleanQuery(searchParams.get("includeTurns"), true);
      try {
        const result = await appClient.readThread(threadId, includeTurns);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && segments[3] === "stream-events") {
      const limitRaw = parseOptionalInteger(searchParams.get("limit"), 60);
      const limit = Math.max(1, Math.min(limitRaw, 200));
      let ownerClientId = getKnownThreadOwnerClientId(threadId);

      const events = history
        .filter((entry) => {
          return (
            entry.source === "ipc" &&
            entry.direction === "in" &&
            entry.meta?.threadId === threadId &&
            entry.meta?.method === "thread-stream-state-changed"
          );
        })
        .slice(-limit)
        .map((entry) => {
          const payload = getHistoryFullPayload(entry.id) || entry.payload || {};
          const params = payload.params && typeof payload.params === "object" ? payload.params : {};
          const change = params.change && typeof params.change === "object" ? params.change : {};
          const patches = Array.isArray(change.patches) ? change.patches : [];
          return {
            id: entry.id,
            at: entry.at,
            sourceClientId:
              typeof payload.sourceClientId === "string" ? payload.sourceClientId : null,
            method: typeof payload.method === "string" ? payload.method : null,
            version: Number.isInteger(payload.version) ? payload.version : null,
            changeType: typeof change.type === "string" ? change.type : null,
            patchCount: patches.length
          };
        });

      if (!ownerClientId && events.length) {
        ownerClientId = events[events.length - 1].sourceClientId || null;
      }

      sendJson(res, 200, {
        ok: true,
        threadId,
        ownerClientId,
        events
      });
      return;
    }

    if (req.method === "POST" && segments[3] === "message") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        badRequest(res, toErrorMessage(error));
        return;
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        badRequest(res, "text is required");
        return;
      }

      const ownerClientId = getKnownThreadOwnerClientId(threadId);
      if (!ownerClientId) {
        sendJson(res, 409, {
          ok: false,
          threadId,
          error:
            "No known owner client id for this thread yet. Open the thread in the desktop app first so stream events identify the owner."
        });
        return;
      }

      try {
        const turnStartParams = buildTurnStartParamsTemplate(threadId, text, body);
        const response = await ipcClient.sendRequestAndWait(
          "thread-follower-start-turn",
          {
            conversationId: threadId,
            turnStartParams,
            isSteering: Boolean(body?.isSteering)
          },
          {
            targetClientId: ownerClientId,
            versionOverride: 1,
            timeoutMs: IPC_REQUEST_TIMEOUT_MS
          }
        );

        sendJson(res, 200, {
          ok: true,
          path: "ipc-owner",
          threadId,
          ownerClientId,
          response
        });
      } catch (error) {
        const message = toErrorMessage(error);
        if (message.includes("No turn params template found")) {
          sendJson(res, 409, {
            ok: false,
            threadId,
            error:
              "No stream snapshot template found for this thread yet. Open the thread in the desktop app and wait for a snapshot event."
          });
          return;
        }
        if (message.includes("no-client-found")) {
          threadOwnerClientById.delete(threadId);
          sendJson(res, 409, {
            ok: false,
            threadId,
            error:
              "Owner client id is stale. Open the thread in the desktop app and try again."
          });
          return;
        }
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === "POST" && segments[3] === "interrupt") {
      const ownerClientId = getKnownThreadOwnerClientId(threadId);
      if (!ownerClientId) {
        sendJson(res, 409, {
          ok: false,
          threadId,
          error:
            "No known owner client id for this thread yet. Open the thread in the desktop app first so stream events identify the owner."
        });
        return;
      }

      try {
        const response = await ipcClient.sendRequestAndWait(
          "thread-follower-interrupt-turn",
          {
            conversationId: threadId
          },
          {
            targetClientId: ownerClientId,
            versionOverride: 1,
            timeoutMs: IPC_REQUEST_TIMEOUT_MS
          }
        );

        sendJson(res, 200, {
          ok: true,
          path: "ipc-owner",
          threadId,
          ownerClientId,
          response
        });
      } catch (error) {
        const message = toErrorMessage(error);
        if (message.includes("no-client-found")) {
          threadOwnerClientById.delete(threadId);
          sendJson(res, 409, {
            ok: false,
            threadId,
            error:
              "Owner client id is stale. Open the thread in the desktop app and try again."
          });
          return;
        }
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === "POST" && segments[3] === "sync") {
      sendJson(res, 409, {
        ok: false,
        threadId,
        error: "High-level sync is disabled in strict mode. Capture and replay exact socket requests instead."
      });
      return;
    }
  }

  if (req.method === "POST" && pathname === "/api/send-request") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    const method = typeof body.method === "string" ? body.method.trim() : "";
    if (!method) {
      badRequest(res, "method is required");
      return;
    }

    const params =
      body.params && typeof body.params === "object" ? body.params : {};
    const targetClientId =
      typeof body.targetClientId === "string" ? body.targetClientId : "";
    const version =
      Number.isInteger(body.version) && body.version >= 0 ? body.version : null;
    const waitForResponse =
      body.waitForResponse === undefined ? true : Boolean(body.waitForResponse);
    const timeoutMs = parseOptionalInteger(body.timeoutMs, IPC_REQUEST_TIMEOUT_MS);

    if (!targetClientId.trim()) {
      badRequest(res, "targetClientId is required in strict mode");
      return;
    }
    if (!Number.isInteger(version) || version < 0) {
      badRequest(res, "version is required in strict mode");
      return;
    }

    try {
      if (!waitForResponse) {
        const requestId = ipcClient.sendRequest(method, params, targetClientId, version);
        sendJson(res, 200, { ok: true, requestId });
        return;
      }

      const response = await ipcClient.sendRequestAndWait(method, params, {
        targetClientId: targetClientId.trim(),
        versionOverride: version,
        timeoutMs: Math.max(1000, timeoutMs)
      });
      sendJson(res, 200, { ok: true, response });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/send-broadcast") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    const method = typeof body.method === "string" ? body.method.trim() : "";
    if (!method) {
      badRequest(res, "method is required");
      return;
    }

    const params =
      body.params && typeof body.params === "object" ? body.params : {};
    const version =
      Number.isInteger(body.version) && body.version >= 0 ? body.version : null;

    if (!Number.isInteger(version) || version < 0) {
      badRequest(res, "version is required in strict mode");
      return;
    }

    try {
      ipcClient.sendBroadcast(method, params, version);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/replay-history-entry") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      badRequest(res, toErrorMessage(error));
      return;
    }

    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    const waitForResponse =
      body.waitForResponse === undefined ? false : Boolean(body.waitForResponse);
    const timeoutMs = parseOptionalInteger(body.timeoutMs, IPC_REQUEST_TIMEOUT_MS);

    if (!entryId) {
      badRequest(res, "entryId is required");
      return;
    }

    const historyEntry = findHistoryEntryById(entryId);
    if (!historyEntry) {
      sendJson(res, 404, { ok: false, error: "History entry not found" });
      return;
    }

    if (historyEntry.source !== "ipc" || historyEntry.direction !== "out") {
      badRequest(res, "History entry must be an outgoing IPC message");
      return;
    }

    const payload = getHistoryFullPayload(entryId);
    if (!payload || typeof payload !== "object") {
      sendJson(res, 409, {
        ok: false,
        error: "Full payload is not available for this history entry"
      });
      return;
    }

    const messageType = payload.type;
    if (messageType !== "request" && messageType !== "broadcast") {
      badRequest(res, "Only request or broadcast messages can be replayed");
      return;
    }

    if (messageType === "broadcast" && waitForResponse) {
      badRequest(res, "waitForResponse is not supported for broadcasts");
      return;
    }

    try {
      if (messageType === "request" && waitForResponse) {
        const response = await ipcClient.sendRawRequestAndWait(payload, {
          timeoutMs: Math.max(1000, timeoutMs)
        });
        sendJson(res, 200, {
          ok: true,
          replayed: {
            entryId,
            type: messageType,
            method: typeof payload.method === "string" ? payload.method : null
          },
          response
        });
        return;
      }

      ipcClient.sendRawMessage(payload);
      sendJson(res, 200, {
        ok: true,
        replayed: {
          entryId,
          type: messageType,
          method: typeof payload.method === "string" ? payload.method : null
        }
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
    }
    return;
  }

  if (req.method === "GET") {
    await serveStatic(res, pathname);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  const socketExists = fs.existsSync(state.ipc.socketPath || "");
  console.log(`Codex monitor running at ${url}`);
  console.log(`Desktop socket path: ${state.ipc.socketPath}`);
  console.log(`Desktop socket exists: ${socketExists ? "yes" : "no"}`);
  console.log(`App-server executable: ${state.app.executablePath}`);
});
