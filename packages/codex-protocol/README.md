# @codex-monitor/codex-protocol

Strict schemas and types for Codex monitor protocol handling.

## Goals

- Fail fast when payloads drift.
- Keep one source of truth for wire and app-server data shapes.
- Export inferred TypeScript types from Zod schemas.

## What This Package Covers

- IPC frame schemas:
  - `initialize`
  - `request`
  - `response`
  - `broadcast`
- Thread stream schemas:
  - `thread-stream-state-changed` broadcast envelope
  - `snapshot` and `patches` change payloads
  - patch operations and paths
- Conversation state schemas:
  - thread turns and supported item types
  - pending user input requests
  - collaboration mode fields
- App-server response schemas we depend on:
  - list threads
  - read thread
  - list models
  - list collaboration modes

## Parse Helpers

Use parse helpers when reading any untrusted payload:

- `parseIpcFrame`
- `parseThreadStreamStateChangedBroadcast`
- `parseThreadConversationState`
- `parseUserInputResponsePayload`
- `parseAppServerListThreadsResponse`
- `parseAppServerReadThreadResponse`
- `parseAppServerListModelsResponse`
- `parseAppServerCollaborationModeListResponse`

All helpers throw `ProtocolValidationError` with issue paths.

## Strictness Policy

- Schemas use `.strict()` by default.
- Unknown fields are rejected unless explicitly allowed.
- No fallback parsing and no shape coercion.

## Development

```bash
pnpm --filter @codex-monitor/codex-protocol build
pnpm --filter @codex-monitor/codex-protocol test
```
