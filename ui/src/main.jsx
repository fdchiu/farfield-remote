import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const THREAD_LIMIT = 80;
const THREAD_MAX_PAGES = 20;
const MAX_VISIBLE_TURNS_STEP = 12;
const RAW_LOG_LIMIT = 80;
const STATUS_POLL_MS = 4000;
const THREADS_POLL_MS = 20000;
const TURN_POLL_IDLE_MS = 6000;
const TURN_POLL_ACTIVE_MS = 1400;

function formatEpochSeconds(seconds) {
  if (!Number.isFinite(seconds)) {
    return "-";
  }
  return new Date(seconds * 1000).toLocaleString();
}

function toErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function threadLabel(thread) {
  const text = (thread.preview || "").trim();
  if (!text) {
    return `(thread ${String(thread.id || "").slice(0, 8)})`;
  }
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function getItemRole(item) {
  if (!item || typeof item !== "object") {
    return "Unknown";
  }
  if (item.type === "userMessage") {
    return "You";
  }
  if (item.type === "agentMessage") {
    return "Codex";
  }
  if (item.type === "reasoning") {
    return "Reasoning";
  }
  if (item.type === "plan") {
    return "Plan";
  }
  return item.type || "Unknown";
}

function getItemClass(item) {
  if (!item || typeof item !== "object") {
    return "unknown";
  }
  if (item.type === "userMessage") {
    return "user";
  }
  if (item.type === "agentMessage") {
    return "agent";
  }
  if (item.type === "reasoning") {
    return "reasoning";
  }
  if (item.type === "plan") {
    return "plan";
  }
  return "unknown";
}

function getItemText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  if (item.type === "userMessage") {
    const parts = Array.isArray(item.content) ? item.content : [];
    return parts
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }

  if (item.type === "agentMessage") {
    return item.text || "";
  }

  if (item.type === "reasoning") {
    return Array.isArray(item.summary) ? item.summary.join("\n") : item.text || "";
  }

  if (item.type === "plan") {
    return item.text || "";
  }

  return JSON.stringify(item, null, 2);
}

async function apiGet(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function StatusPill({ label, healthy, text }) {
  return (
    <span className={`pill ${healthy ? "good" : "bad"}`}>
      {label}: {text}
    </span>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [selectedThread, setSelectedThread] = useState(null);
  const [visibleTurns, setVisibleTurns] = useState(MAX_VISIBLE_TURNS_STEP);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [threadsTruncated, setThreadsTruncated] = useState(false);
  const [threadsPageCount, setThreadsPageCount] = useState(0);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [streamEvents, setStreamEvents] = useState([]);
  const [streamOwnerClientId, setStreamOwnerClientId] = useState(null);
  const [streamLoading, setStreamLoading] = useState(false);

  const [traceLabel, setTraceLabel] = useState("capture");
  const [traceNote, setTraceNote] = useState("");
  const [traceStatus, setTraceStatus] = useState({ active: null, recent: [] });
  const [traceBusy, setTraceBusy] = useState(false);

  const [rawLive, setRawLive] = useState(false);
  const [rawEntries, setRawEntries] = useState([]);

  const [selectedReplayEntryId, setSelectedReplayEntryId] = useState("");
  const [selectedReplayDetail, setSelectedReplayDetail] = useState(null);
  const [replayWaitForResponse, setReplayWaitForResponse] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayResult, setReplayResult] = useState("");

  const selectedThreadRequestRef = useRef(0);

  const setError = useCallback((error) => {
    setErrorMessage(toErrorMessage(error));
  }, []);

  const clearError = useCallback(() => {
    setErrorMessage("");
  }, []);

  const loadState = useCallback(async () => {
    const data = await apiGet("/api/state");
    setState(data.state || null);
  }, []);

  const loadTraceStatus = useCallback(async () => {
    const data = await apiGet("/api/trace/status");
    setTraceStatus({
      active: data.active || null,
      recent: Array.isArray(data.recent) ? data.recent : []
    });
  }, []);

  const loadThreads = useCallback(async (options = {}) => {
    const { all = true } = options;
    setThreadsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(THREAD_LIMIT));
      params.set("archived", includeArchived ? "1" : "0");
      if (all) {
        params.set("all", "1");
        params.set("maxPages", String(THREAD_MAX_PAGES));
      }

      const data = await apiGet(`/api/threads?${params.toString()}`);
      const nextThreads = Array.isArray(data.data) ? data.data : [];

      if (all) {
        setThreadsTruncated(Boolean(data.truncated));
        setThreadsPageCount(Number.isFinite(data.pages) ? data.pages : 0);
        setThreads(nextThreads);
        setSelectedThreadId((current) => {
          if (!current && nextThreads.length) {
            return nextThreads[0].id;
          }
          if (current && nextThreads.some((thread) => thread.id === current)) {
            return current;
          }
          if (!nextThreads.length) {
            return null;
          }
          return nextThreads[0].id;
        });
      } else {
        setThreads((current) => {
          if (!current.length) {
            return nextThreads;
          }
          const merged = new Map(current.map((thread) => [thread.id, thread]));
          for (const thread of nextThreads) {
            merged.set(thread.id, { ...(merged.get(thread.id) || {}), ...thread });
          }
          return Array.from(merged.values()).sort(
            (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
          );
        });
        setSelectedThreadId((current) => current || nextThreads[0]?.id || null);
      }
    } finally {
      setThreadsLoading(false);
    }
  }, [includeArchived]);

  const loadSelectedThread = useCallback(async (threadId) => {
    if (!threadId) {
      setSelectedThread(null);
      return;
    }

    const requestId = selectedThreadRequestRef.current + 1;
    selectedThreadRequestRef.current = requestId;

    setThreadLoading(true);
    try {
      const data = await apiGet(
        `/api/thread/${encodeURIComponent(threadId)}?includeTurns=true`
      );
      if (requestId !== selectedThreadRequestRef.current) {
        return;
      }
      setSelectedThread(data.thread || null);
    } finally {
      if (requestId === selectedThreadRequestRef.current) {
        setThreadLoading(false);
      }
    }
  }, []);

  const loadReplayEntryDetail = useCallback(async (entryId) => {
    if (!entryId) {
      setSelectedReplayDetail(null);
      return;
    }

    const data = await apiGet(`/api/history/${encodeURIComponent(entryId)}`);
    setSelectedReplayDetail(data);
  }, []);

  const loadThreadStreamEvents = useCallback(async (threadId, options = {}) => {
    const { silent = false } = options;
    if (!threadId) {
      setStreamOwnerClientId(null);
      setStreamEvents([]);
      return;
    }

    if (!silent) {
      setStreamLoading(true);
    }
    try {
      const data = await apiGet(
        `/api/thread/${encodeURIComponent(threadId)}/stream-events?limit=60`
      );
      setStreamOwnerClientId(data.ownerClientId || null);
      setStreamEvents(Array.isArray(data.events) ? data.events : []);
    } finally {
      if (!silent) {
        setStreamLoading(false);
      }
    }
  }, []);

  const hasActiveTurn = useMemo(() => {
    const turns = Array.isArray(selectedThread?.turns) ? selectedThread.turns : [];
    return turns.some((turn) => turn.status === "inProgress");
  }, [selectedThread]);

  const visibleTurnData = useMemo(() => {
    const turns = Array.isArray(selectedThread?.turns) ? selectedThread.turns : [];
    const clipped = turns.slice(-visibleTurns);
    return {
      allCount: turns.length,
      turns: clipped,
      hasOlder: turns.length > clipped.length
    };
  }, [selectedThread, visibleTurns]);

  const replayCandidates = useMemo(() => {
    return rawEntries
      .filter((entry) => {
        if (entry.source !== "ipc" || entry.direction !== "out") {
          return false;
        }
        const type = entry.payload?.type;
        return type === "request" || type === "broadcast";
      })
      .slice()
      .reverse();
  }, [rawEntries]);

  const selectedReplayPayload = selectedReplayDetail?.fullPayload || null;
  const selectedReplayType = selectedReplayPayload?.type || null;
  const selectedReplayIsRequest = selectedReplayType === "request";

  useEffect(() => {
    const run = async () => {
      try {
        clearError();
        await Promise.all([loadState(), loadTraceStatus()]);
      } catch (error) {
        setError(error);
      }
    };

    void run();
  }, [clearError, loadState, loadTraceStatus, setError]);

  useEffect(() => {
    const timer = setInterval(() => {
      Promise.all([loadState(), loadTraceStatus()]).catch(() => {
        // Silent background retry.
      });
    }, STATUS_POLL_MS);

    return () => clearInterval(timer);
  }, [loadState, loadTraceStatus]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadThreads({ all: false }).catch(() => {
        // Silent background retry.
      });
    }, THREADS_POLL_MS);

    return () => clearInterval(timer);
  }, [loadThreads]);

  useEffect(() => {
    loadThreads({ all: true }).catch((error) => {
      setError(error);
    });
  }, [includeArchived, loadThreads, setError]);

  useEffect(() => {
    setVisibleTurns(MAX_VISIBLE_TURNS_STEP);
    if (!selectedThreadId) {
      setSelectedThread(null);
      return;
    }

    loadSelectedThread(selectedThreadId).catch((error) => {
      setError(error);
    });
  }, [loadSelectedThread, selectedThreadId, setError]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    const intervalMs = hasActiveTurn ? TURN_POLL_ACTIVE_MS : TURN_POLL_IDLE_MS;
    const timer = setInterval(() => {
      loadSelectedThread(selectedThreadId).catch(() => {
        // Silent background retry.
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [hasActiveTurn, loadSelectedThread, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) {
      setStreamOwnerClientId(null);
      setStreamEvents([]);
      return;
    }
    loadThreadStreamEvents(selectedThreadId).catch((error) => {
      setError(error);
    });
  }, [loadThreadStreamEvents, selectedThreadId, setError]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }
    const timer = setInterval(() => {
      loadThreadStreamEvents(selectedThreadId, { silent: true }).catch(() => {
        // Silent background retry.
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [loadThreadStreamEvents, selectedThreadId]);

  useEffect(() => {
    if (!rawLive) {
      return;
    }

    const source = new EventSource("/events");
    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "state" && payload.state) {
        setState(payload.state);
        return;
      }

      if (payload.type === "history" && Array.isArray(payload.messages)) {
        const onlyIpc = payload.messages.filter((entry) => entry.source === "ipc");
        setRawEntries(onlyIpc.slice(-RAW_LOG_LIMIT));
        return;
      }

      if (payload.type !== "message" || !payload.entry || payload.entry.source !== "ipc") {
        return;
      }

      setRawEntries((current) => {
        const next = [...current, payload.entry];
        if (next.length <= RAW_LOG_LIMIT) {
          return next;
        }
        return next.slice(next.length - RAW_LOG_LIMIT);
      });
    };

    return () => {
      source.close();
    };
  }, [rawLive]);

  useEffect(() => {
    if (!selectedReplayEntryId) {
      setSelectedReplayDetail(null);
      return;
    }
    loadReplayEntryDetail(selectedReplayEntryId).catch((error) => {
      setError(error);
    });
  }, [loadReplayEntryDetail, selectedReplayEntryId, setError]);

  const refreshEverything = useCallback(async () => {
    try {
      clearError();
      await Promise.all([
        loadState(),
        loadTraceStatus(),
        loadThreads({ all: true })
      ]);
      if (selectedThreadId) {
        await loadSelectedThread(selectedThreadId);
        await loadThreadStreamEvents(selectedThreadId);
      }
      if (selectedReplayEntryId) {
        await loadReplayEntryDetail(selectedReplayEntryId);
      }
    } catch (error) {
      setError(error);
    }
  }, [
    clearError,
    loadReplayEntryDetail,
    loadSelectedThread,
    loadThreadStreamEvents,
    loadState,
    loadThreads,
    loadTraceStatus,
    selectedReplayEntryId,
    selectedThreadId,
    setError
  ]);

  const sendMessage = useCallback(
    async (event) => {
      event.preventDefault();
      if (!selectedThreadId || sending) {
        return;
      }
      const text = composeText.trim();
      if (!text) {
        return;
      }

      setSending(true);
      try {
        clearError();
        const payload = { text };
        if (typeof selectedThread?.cwd === "string" && selectedThread.cwd.trim()) {
          payload.cwd = selectedThread.cwd.trim();
        }
        await apiPost(`/api/thread/${encodeURIComponent(selectedThreadId)}/message`, payload);
        setComposeText("");
        await Promise.all([
          loadSelectedThread(selectedThreadId),
          loadThreadStreamEvents(selectedThreadId, { silent: true })
        ]);
      } catch (error) {
        setError(error);
      } finally {
        setSending(false);
      }
    },
    [
      clearError,
      composeText,
      loadSelectedThread,
      loadThreadStreamEvents,
      selectedThread,
      selectedThreadId,
      sending,
      setError
    ]
  );

  const startTrace = useCallback(async () => {
    if (traceBusy) {
      return;
    }
    setTraceBusy(true);
    try {
      clearError();
      await apiPost("/api/trace/start", { label: traceLabel.trim() });
      await loadTraceStatus();
    } catch (error) {
      setError(error);
    } finally {
      setTraceBusy(false);
    }
  }, [clearError, loadTraceStatus, setError, traceBusy, traceLabel]);

  const markTrace = useCallback(async () => {
    if (traceBusy) {
      return;
    }
    setTraceBusy(true);
    try {
      clearError();
      await apiPost("/api/trace/mark", { note: traceNote });
      setTraceNote("");
      await loadTraceStatus();
    } catch (error) {
      setError(error);
    } finally {
      setTraceBusy(false);
    }
  }, [clearError, loadTraceStatus, setError, traceBusy, traceNote]);

  const stopTrace = useCallback(async () => {
    if (traceBusy) {
      return;
    }
    setTraceBusy(true);
    try {
      clearError();
      await apiPost("/api/trace/stop", {});
      await loadTraceStatus();
    } catch (error) {
      setError(error);
    } finally {
      setTraceBusy(false);
    }
  }, [clearError, loadTraceStatus, setError, traceBusy]);

  const replaySelected = useCallback(async () => {
    if (!selectedReplayEntryId || replayBusy) {
      return;
    }

    setReplayBusy(true);
    try {
      clearError();
      const result = await apiPost("/api/replay-history-entry", {
        entryId: selectedReplayEntryId,
        waitForResponse: selectedReplayIsRequest ? replayWaitForResponse : false
      });
      setReplayResult(JSON.stringify(result, null, 2));
      await loadReplayEntryDetail(selectedReplayEntryId);
    } catch (error) {
      setError(error);
    } finally {
      setReplayBusy(false);
    }
  }, [
    clearError,
    loadReplayEntryDetail,
    replayBusy,
    replayWaitForResponse,
    selectedReplayEntryId,
    selectedReplayIsRequest,
    setError
  ]);

  const appState = state?.app;
  const ipcState = state?.ipc;

  const appHealthy = Boolean(appState?.running && appState?.initialized);
  const ipcHealthy = Boolean(ipcState?.transportConnected && ipcState?.initialized);

  const appStatusText = appHealthy
    ? `ready (pid ${appState?.pid || "?"})`
    : appState?.running
      ? "starting"
      : "disconnected";

  const ipcStatusText = ipcHealthy ? "connected" : "disconnected";

  return (
    <div className="page">
      <header className="topbar panel">
        <div>
          <h1>Codex Strict Monitor</h1>
          <p className="sub">
            Capture real socket traffic, then replay exact proven messages.
          </p>
        </div>
        <div className="statusRow">
          <StatusPill label="App server" healthy={appHealthy} text={appStatusText} />
          <StatusPill label="Desktop socket" healthy={ipcHealthy} text={ipcStatusText} />
        </div>
      </header>

      {errorMessage ? (
        <div className="errorBar panel">
          <p>{errorMessage}</p>
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <section className="layout">
        <aside className="panel sidebar">
          <div className="sectionHead">
            <h2>Thread Snapshot</h2>
            <div className="buttonRow">
              <button type="button" onClick={refreshEverything}>
                Refresh
              </button>
            </div>
          </div>

          <p className="sub callout">
            This is read only. It comes from app-server and can differ from what the desktop
            window currently shows.
          </p>

          <label className="threadsFilter">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include archived
          </label>
          <p className="sub threadsMeta">
            Showing {threads.length} thread{threads.length === 1 ? "" : "s"}
            {threadsPageCount > 0
              ? ` from ${threadsPageCount} page${threadsPageCount === 1 ? "" : "s"}`
              : ""}
            {threadsTruncated ? " (not all loaded, click Refresh)" : ""}
          </p>

          <div className="threadListWrap">
            {threadsLoading && !threads.length ? <p className="sub">Loading threads...</p> : null}

            {!threads.length ? (
              <p className="sub">No threads found.</p>
            ) : (
              <ul className="threadList">
                {threads.map((thread) => {
                  const active = thread.id === selectedThreadId;
                  return (
                    <li key={thread.id}>
                      <button
                        type="button"
                        className={`threadCard ${active ? "active" : ""}`}
                        onClick={() => setSelectedThreadId(thread.id)}
                      >
                        <p className="threadTitle">{threadLabel(thread)}</p>
                        <p className="threadMeta">
                          {formatEpochSeconds(thread.updatedAt)} | {thread.source || "unknown"}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <section className="mainStack">
          <section className="panel conversationPanel">
            <div className="sectionHead">
              <div>
                <h2>{selectedThread ? threadLabel(selectedThread) : "No thread selected"}</h2>
                <p className="sub">
                  {selectedThread
                    ? `${selectedThread.id} | created ${formatEpochSeconds(selectedThread.createdAt)} | updated ${formatEpochSeconds(selectedThread.updatedAt)}`
                    : "Choose a thread from the list on the left."}
                </p>
              </div>
              <div className="buttonRow">
                <button
                  type="button"
                  disabled={!selectedThreadId || threadLoading}
                  onClick={() =>
                    selectedThreadId
                      ? loadSelectedThread(selectedThreadId).catch(setError)
                      : undefined
                  }
                >
                  Refresh thread
                </button>
              </div>
            </div>

            <div className="timeline" aria-live="polite">
              {threadLoading && !selectedThread ? <p className="sub">Loading thread...</p> : null}

              {!selectedThread ? <p className="sub">No thread loaded.</p> : null}

              {selectedThread && visibleTurnData.hasOlder ? (
                <button
                  type="button"
                  className="showOlderBtn"
                  onClick={() => setVisibleTurns((count) => count + MAX_VISIBLE_TURNS_STEP)}
                >
                  Show older turns ({visibleTurnData.allCount - visibleTurnData.turns.length} hidden)
                </button>
              ) : null}

              {selectedThread
                ? visibleTurnData.turns.map((turn, turnIndex) => (
                    <section className="turnBlock" key={turn.id || `${turnIndex}-${turn.status}`}>
                      <div className="turnBar">
                        <span>
                          Turn{" "}
                          {visibleTurnData.allCount - visibleTurnData.turns.length + turnIndex + 1}
                        </span>
                        <span>{turn.status || "unknown"}</span>
                      </div>

                      {(Array.isArray(turn.items) ? turn.items : []).map((item, itemIndex) => (
                        <article
                          className={`bubble ${getItemClass(item)}`}
                          key={`${turn.id || turnIndex}-${item.id || itemIndex}`}
                        >
                          <p className="bubbleRole">{getItemRole(item)}</p>
                          <pre>{getItemText(item)}</pre>
                        </article>
                      ))}
                    </section>
                  ))
                : null}
            </div>

            <form className="compose" onSubmit={sendMessage}>
              <textarea
                rows={3}
                value={composeText}
                onChange={(event) => setComposeText(event.target.value)}
                placeholder="Send message to this thread"
              />
              <div className="composeFooter">
                <p className="sub">
                  Owner client:{" "}
                  <code>{streamOwnerClientId || "unknown yet"}</code>
                </p>
                <button type="submit" disabled={!selectedThreadId || sending || !composeText.trim()}>
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </form>

            <section className="streamPanel">
              <div className="sectionHead">
                <h2>Stream Events</h2>
                <p className="sub">{streamLoading ? "Loading..." : `${streamEvents.length} recent`}</p>
              </div>
              <div className="streamList">
                {!streamEvents.length ? (
                  <p className="sub">No stream events for this thread yet.</p>
                ) : (
                  streamEvents
                    .slice()
                    .reverse()
                    .map((event) => (
                      <article key={event.id} className="streamEvent">
                        <p className="streamHead">
                          {event.at} | {event.sourceClientId || "unknown source"}
                        </p>
                        <p className="sub">
                          {event.method || "unknown"} | {event.changeType || "unknown"} | patches{" "}
                          {Number.isInteger(event.patchCount) ? event.patchCount : "-"}
                        </p>
                      </article>
                    ))
                )}
              </div>
            </section>
          </section>

          <section className="panel tracePanel">
            <div className="sectionHead">
              <h2>Trace Controls</h2>
              <div className="buttonRow">
                <button type="button" disabled={traceBusy || Boolean(traceStatus.active)} onClick={startTrace}>
                  Start trace
                </button>
                <button type="button" disabled={traceBusy || !traceStatus.active} onClick={markTrace}>
                  Mark
                </button>
                <button type="button" disabled={traceBusy || !traceStatus.active} onClick={stopTrace}>
                  Stop
                </button>
              </div>
            </div>

            <p className="sub traceHint">
              Start a trace, do the action in the desktop app, stop the trace, then replay only
              the captured messages.
            </p>

            <div className="traceControls">
              <label>
                Trace label
                <input
                  value={traceLabel}
                  onChange={(event) => setTraceLabel(event.target.value)}
                  placeholder="capture"
                />
              </label>
              <label>
                Marker note
                <input
                  value={traceNote}
                  onChange={(event) => setTraceNote(event.target.value)}
                  placeholder="optional note"
                />
              </label>
            </div>

            <div className="traceState">
              {traceStatus.active ? (
                <p className="sub">
                  Active trace: <code>{traceStatus.active.id}</code> ({traceStatus.active.eventCount} events)
                </p>
              ) : (
                <p className="sub">No active trace.</p>
              )}
            </div>

            <div className="traceList">
              {!traceStatus.recent.length ? (
                <p className="sub">No saved traces yet.</p>
              ) : (
                traceStatus.recent.map((trace) => (
                  <article key={trace.id} className="traceItem">
                    <div>
                      <p className="traceItemTitle">{trace.label}</p>
                      <p className="sub">
                        {trace.id} | {trace.eventCount} events | started {trace.startedAt}
                      </p>
                    </div>
                    <a
                      className="downloadLink"
                      href={`/api/trace/${encodeURIComponent(trace.id)}/download`}
                    >
                      Download
                    </a>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="panel replayPanel">
            <div className="sectionHead">
              <h2>Strict Replay</h2>
              <div className="buttonRow">
                <button type="button" onClick={() => setRawLive((active) => !active)}>
                  {rawLive ? "Stop live feed" : "Start live feed"}
                </button>
                <button type="button" onClick={() => setRawEntries([])}>
                  Clear feed
                </button>
              </div>
            </div>

            <p className="sub traceHint">
              This list only shows outgoing desktop socket messages from this monitor.
            </p>

            <div className="replayLayout">
              <div className="candidateList">
                {!replayCandidates.length ? (
                  <p className="sub">No replay candidates yet.</p>
                ) : (
                  replayCandidates.map((entry) => {
                    const payload = entry.payload || {};
                    const active = selectedReplayEntryId === entry.id;
                    const method = payload.method || entry.meta?.method || "unknown";
                    const target = payload.targetClientId || "broadcast";
                    const version =
                      Number.isInteger(payload.version) && payload.version >= 0
                        ? payload.version
                        : "-";
                    return (
                      <button
                        type="button"
                        key={entry.id}
                        className={`candidateRow ${active ? "active" : ""}`}
                        onClick={() => {
                          setSelectedReplayEntryId(entry.id);
                          setReplayResult("");
                        }}
                      >
                        <p className="candidateHead">
                          {payload.type || "unknown"} | {method}
                        </p>
                        <p className="candidateMeta">
                          {entry.at} | target {target} | v{version}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="replayDetail">
                {!selectedReplayEntryId ? (
                  <p className="sub">Pick an entry from the list to inspect and replay.</p>
                ) : null}

                {selectedReplayEntryId && !selectedReplayDetail ? (
                  <p className="sub">Loading selected entry...</p>
                ) : null}

                {selectedReplayDetail ? (
                  <>
                    <p className="sub">
                      Selected entry: <code>{selectedReplayEntryId}</code>
                    </p>
                    <p className="sub">
                      Type: {selectedReplayType || "unknown"} | Method:{" "}
                      {selectedReplayPayload?.method || "unknown"}
                    </p>

                    {selectedReplayIsRequest ? (
                      <label className="inlineCheck">
                        <input
                          type="checkbox"
                          checked={replayWaitForResponse}
                          onChange={(event) => setReplayWaitForResponse(event.target.checked)}
                        />
                        Wait for response before returning
                      </label>
                    ) : null}

                    <button
                      type="button"
                      disabled={replayBusy}
                      onClick={replaySelected}
                    >
                      {replayBusy ? "Replaying..." : "Replay exact captured frame"}
                    </button>

                    <pre className="payloadView">
                      {JSON.stringify(selectedReplayPayload, null, 2)}
                    </pre>
                  </>
                ) : null}

                {replayResult ? <pre className="payloadView">{replayResult}</pre> : null}
              </div>
            </div>
          </section>
        </section>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
