import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

class MockEventSource {
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public constructor(_url: string) {}

  public close(): void {}
}

vi.stubGlobal("EventSource", MockEventSource);

// jsdom doesn't implement scrollTo or ResizeObserver.
Element.prototype.scrollTo = vi.fn();
window.scrollTo = vi.fn();
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
  matches: query === "(prefers-color-scheme: dark)",
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn()
})));

const codexCapabilities = {
  canListModels: true,
  canListCollaborationModes: true,
  canSetCollaborationMode: true,
  canSubmitUserInput: true,
  canReadLiveState: true,
  canReadStreamEvents: true
};

const opencodeCapabilities = {
  canListModels: false,
  canListCollaborationModes: false,
  canSetCollaborationMode: false,
  canSubmitUserInput: false,
  canReadLiveState: false,
  canReadStreamEvents: false
};

type CapabilityFixture = {
  canListModels: boolean;
  canListCollaborationModes: boolean;
  canSetCollaborationMode: boolean;
  canSubmitUserInput: boolean;
  canReadLiveState: boolean;
  canReadStreamEvents: boolean;
};

let agentsFixture: {
  ok: true;
  agents: Array<{
    id: "codex" | "opencode";
    label: string;
    enabled: boolean;
    connected: boolean;
    capabilities: CapabilityFixture;
    projectDirectories: string[];
  }>;
  defaultAgentId: "codex" | "opencode";
};

beforeEach(() => {
  agentsFixture = {
    ok: true,
    agents: [
      {
        id: "codex",
        label: "Codex",
        enabled: true,
        connected: true,
        capabilities: codexCapabilities,
        projectDirectories: []
      }
    ],
    defaultAgentId: "codex"
  };
});

afterEach(() => {
  cleanup();
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/api/health")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          state: {
            appReady: true,
            ipcConnected: true,
            ipcInitialized: true,
            lastError: null,
            historyCount: 0,
            threadOwnerCount: 0
          }
        })
      } as Response;
    }

    if (url.includes("/api/threads") && !url.includes("/live-state")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [],
          nextCursor: null,
          pages: 0,
          truncated: false
        })
      } as Response;
    }

    if (url.includes("/api/collaboration-modes")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [
            {
              name: "Plan",
              mode: "plan",
              model: null,
              reasoning_effort: "medium",
              developer_instructions: "x"
            }
          ]
        })
      } as Response;
    }

    if (url.includes("/api/models")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: [
            {
              id: "gpt-5.3-codex",
              model: "gpt-5.3-codex",
              upgrade: null,
              displayName: "GPT-5.3 Codex",
              description: "Test model",
              supportedReasoningEfforts: [
                {
                  reasoningEffort: "medium",
                  description: "Balanced"
                }
              ],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
              supportsPersonality: true,
              isDefault: true
            }
          ],
          nextCursor: null
        })
      } as Response;
    }

    if (url.includes("/api/debug/trace/status")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          active: null,
          recent: []
        })
      } as Response;
    }

    if (url.includes("/api/debug/history")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          history: []
        })
      } as Response;
    }

    if (url.includes("/api/agents")) {
      return {
        ok: true,
        json: async () => agentsFixture
      } as Response;
    }

    return {
      ok: true,
      json: async () => ({
        ok: true,
        threadId: "t",
        ownerClientId: null,
        conversationState: null,
        events: []
      })
    } as Response;
  })
);

describe("App", () => {
  it("renders core sections", async () => {
    render(<App />);
    expect((await screen.findAllByText("Farfield")).length).toBeGreaterThan(0);
    expect(await screen.findByText("No thread selected")).toBeTruthy();
  });

  it("hides mode controls when capability is disabled", async () => {
    agentsFixture = {
      ok: true,
      agents: [
        {
          id: "opencode",
          label: "OpenCode",
          enabled: true,
          connected: true,
          capabilities: opencodeCapabilities,
          projectDirectories: []
        }
      ],
      defaultAgentId: "opencode"
    };

    render(<App />);
    await screen.findAllByText("Farfield");
    expect(screen.queryByText("Plan")).toBeNull();
  });

  it("shows mode controls when capability is enabled", async () => {
    render(<App />);
    expect(await screen.findByText("Plan")).toBeTruthy();
  });
});
