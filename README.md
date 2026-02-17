# Codex Strict Monitor

Local web app for strict desktop socket tracing and replay.

This app is now built to avoid guesswork:
- no high level thread send endpoint usage
- no inferred payload construction
- replay only from captured outgoing IPC history entries

## What It Does

- shows app-server thread snapshots in read only mode
- captures IPC traffic from the monitor client
- records trace sessions to `traces/*.ndjson`
- lets you download trace files
- replays exact captured `request` or `broadcast` frames by history id

## Run

```bash
cd /Users/anshu/Code/codextemp
npm start
```

Then open:

```text
http://127.0.0.1:4311
```

## Strict Workflow

1. Start trace in the web app.
2. Do the action in the real desktop app.
3. Stop trace.
4. In Strict Replay, pick an outgoing IPC entry.
5. Replay that exact captured frame.

## API Endpoints

- `GET /api/state`
- `GET /api/trace/status`
- `POST /api/trace/start`
- `POST /api/trace/mark`
- `POST /api/trace/stop`
- `GET /api/trace/:id/download`
- `GET /api/history/:entryId`
- `POST /api/replay-history-entry`
- `POST /api/send-request` (strict raw mode, explicit target and version required)
- `POST /api/send-broadcast` (strict raw mode, explicit version required)

## Notes

- Everything is local to your machine.
- The desktop protocol is internal and can change between app versions.
- Trace files include full payloads for captured history events.
