/**
 * Tests du bridge HTTP — mock global.fetch, vérifie que chaque fn appelle le
 * bon endpoint avec la bonne method/body et propage les erreurs proprement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../shared/agent-types.js";
import {
  FleetViewHttpError,
  FleetViewUnreachableError,
  getAgent,
  killSession,
  listAgents,
  resolveSessionIdToPtyId,
  spawnSession,
  writeToSession,
} from "./bridge.js";

// Captured fetch calls so each test can assert on the URL/method/body.
type FetchCall = { url: string; method: string; body: unknown };
let calls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  calls = [];
  fetchImpl = async () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return fetchImpl(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    sessionId: "s-1",
    cwd: "/tmp/a",
    projectName: "a",
    filePath: "/tmp/a/a.jsonl",
    status: "idle",
    startedAt: 1000,
    lastActivityAt: 2000,
    turnEnded: true,
    subAgents: [],
    ...overrides,
  };
}

describe("bridge — reads", () => {
  it("listAgents GETs /api/state and returns the agents array", async () => {
    const agent = makeAgent();
    fetchImpl = async () => jsonResponse({ agents: [agent] });

    const result = await listAgents();

    expect(result).toEqual([agent]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:4000/api/state");
    expect(calls[0].method).toBe("GET");
  });

  it("getAgent returns the matching agent by sessionId", async () => {
    fetchImpl = async () =>
      jsonResponse({
        agents: [makeAgent({ sessionId: "s-1" }), makeAgent({ sessionId: "s-2" })],
      });

    const found = await getAgent("s-2");

    expect(found?.sessionId).toBe("s-2");
  });

  it("getAgent returns null when sessionId is absent", async () => {
    fetchImpl = async () => jsonResponse({ agents: [makeAgent({ sessionId: "s-1" })] });

    const found = await getAgent("missing");

    expect(found).toBeNull();
  });

  it("resolveSessionIdToPtyId GETs /api/sessions/by-session/:id and unwraps ptyId", async () => {
    fetchImpl = async () => jsonResponse({ ptyId: "pty-abc" });

    const ptyId = await resolveSessionIdToPtyId("s-1");

    expect(ptyId).toBe("pty-abc");
    expect(calls[0].url).toBe("http://localhost:4000/api/sessions/by-session/s-1");
  });

  it("resolveSessionIdToPtyId returns null when the session is unbound", async () => {
    fetchImpl = async () => jsonResponse({ ptyId: null });

    expect(await resolveSessionIdToPtyId("s-orphan")).toBeNull();
  });

  it("resolveSessionIdToPtyId URL-encodes the sessionId", async () => {
    fetchImpl = async () => jsonResponse({ ptyId: null });

    await resolveSessionIdToPtyId("foo/bar");

    expect(calls[0].url).toBe("http://localhost:4000/api/sessions/by-session/foo%2Fbar");
  });
});

describe("bridge — writes", () => {
  it("spawnSession POSTs /api/sessions with the cwd payload", async () => {
    fetchImpl = async () => jsonResponse({ ptyId: "pty-new" }, 201);

    const result = await spawnSession("/path/to/project");

    expect(result.ptyId).toBe("pty-new");
    expect(calls[0]).toMatchObject({
      url: "http://localhost:4000/api/sessions",
      method: "POST",
      body: { cwd: "/path/to/project" },
    });
  });

  it("writeToSession POSTs /api/sessions/:ptyId/write with the text payload", async () => {
    fetchImpl = async () => jsonResponse({ ok: true });

    await writeToSession("pty-1", "hello\r");

    expect(calls[0]).toMatchObject({
      url: "http://localhost:4000/api/sessions/pty-1/write",
      method: "POST",
      body: { text: "hello\r" },
    });
  });

  it("killSession DELETEs /api/sessions/:ptyId", async () => {
    fetchImpl = async () => jsonResponse({ ok: true });

    await killSession("pty-1");

    expect(calls[0]).toMatchObject({
      url: "http://localhost:4000/api/sessions/pty-1",
      method: "DELETE",
    });
  });
});

describe("bridge — error handling", () => {
  it("throws FleetViewUnreachableError when fetch rejects (server down)", async () => {
    fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(listAgents()).rejects.toBeInstanceOf(FleetViewUnreachableError);
  });

  it("throws FleetViewHttpError on 4xx with the parsed payload", async () => {
    fetchImpl = async () => jsonResponse({ error: "cwd required" }, 400);

    const err = await listAgents().catch((e) => e);
    expect(err).toBeInstanceOf(FleetViewHttpError);
    expect((err as FleetViewHttpError).status).toBe(400);
    expect((err as FleetViewHttpError).payload).toEqual({ error: "cwd required" });
  });

  it("throws FleetViewHttpError on 5xx", async () => {
    fetchImpl = async () => jsonResponse({ error: "boom" }, 503);

    await expect(spawnSession("/anywhere")).rejects.toBeInstanceOf(FleetViewHttpError);
  });

  it("handles 204 No Content (DELETE) without choking on empty body", async () => {
    fetchImpl = async () => new Response(null, { status: 204 });

    await expect(killSession("pty-1")).resolves.toBeUndefined();
  });
});
