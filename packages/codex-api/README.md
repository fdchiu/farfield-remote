# @farfield/api

Typed client layer for the Codex app-server and desktop IPC.

## Goals

- Provide a clean TypeScript interface for bidirectional Codex interaction.
- Validate every untrusted payload with strict schemas.
- Fail fast on protocol drift.

## Main Pieces

- `AppServerClient`
  - Typed requests to `codex app-server`.
  - Strict response validation.
- `DesktopIpcClient`
  - Socket framing and strict IPC frame validation.
  - Request/response handling with explicit timeouts.
- `CodexMonitorService`
  - High-level actions:
    - send message
    - set collaboration mode
    - submit user input
    - interrupt turn
- `reduceThreadStreamEvents`
  - Strict reducer for thread stream snapshots and patches.

## Fail-Fast Rules

- No fallback parsers.
- No retry loops.
- Unknown shapes throw immediately.
- Invalid patch operations throw immediately.

## Example

```ts
import {
  CodexMonitorService,
  DesktopIpcClient,
  findLatestTurnParamsTemplate
} from "@farfield/api";
import { parseThreadConversationState } from "@farfield/protocol";

const ipc = new DesktopIpcClient({
  socketPath: "/tmp/codex-ipc/ipc-501.sock"
});

await ipc.connect();
await ipc.initialize("farfield/0.2.0");

const service = new CodexMonitorService(ipc);

const liveStatePayload = await fetch("http://127.0.0.1:4311/api/threads/thread-id/live-state").then((r) =>
  r.json()
);
const conversationState = parseThreadConversationState(liveStatePayload.conversationState);
const turnStartTemplate = findLatestTurnParamsTemplate(conversationState);

await service.sendMessage({
  threadId: "thread-id",
  ownerClientId: "desktop-client-id",
  text: "hello",
  turnStartTemplate
});
```
