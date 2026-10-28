import { syntheticWorkflowFixtures } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { FetchWebApiClient } from "../src/api/client.js";

describe("FetchWebApiClient", () => {
  it("uses the in-memory bearer token and disables private response caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        cases: [syntheticWorkflowFixtures.dataAnalysis.case],
        nextCursor: null,
      }),
    );
    const client = new FetchWebApiClient({
      getToken: () => "session-token",
      onUnauthorized: vi.fn(),
      fetcher,
    });

    const result = await client.listCases();
    const [, init] = fetcher.mock.calls[0];
    expect(result[0].id).toBe("sample-sales-quarter");
    expect(init?.cache).toBe("no-store");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer session-token",
    );
  });

  it("clears private streams and the session on an unauthorized response", async () => {
    const onUnauthorized = vi.fn();
    const client = new FetchWebApiClient({
      getToken: () => "expired-token",
      onUnauthorized,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
    });

    await expect(client.listCases()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("surfaces server-side admin denial without substituting fixture data", async () => {
    const client = new FetchWebApiClient({
      getToken: () => "user-token",
      onUnauthorized: vi.fn(),
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("Administrator access required.", { status: 403 }),
        ),
    });
    await expect(client.getAdminUsage()).rejects.toBeInstanceOf(ApiError);
  });

  it("exchanges access keys without retaining them and revokes sessions on logout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          accessToken: "memory-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new FetchWebApiClient({
      getToken: () => null,
      onUnauthorized: vi.fn(),
      fetcher,
    });

    await client.exchangeAccessKey("temporary-key");
    const [, authRequest] = fetcher.mock.calls[0];
    expect(authRequest?.cache).toBe("no-store");
    expect(authRequest?.body).toBe(
      JSON.stringify({ accessKey: "temporary-key" }),
    );
    await client.revokeSession("memory-token");
    expect(fetcher.mock.calls[1][0]).toBe("/auth/logout");
    expect(
      new Headers(fetcher.mock.calls[1][1]?.headers).get("Authorization"),
    ).toBe("Bearer memory-token");
  });
});
