import { syntheticWorkflowFixtures, type RunDto } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { FetchWebApiClient } from "../src/api/client.js";

describe("FetchWebApiClient", () => {
  const run: RunDto = {
    id: "run-1",
    caseId: "case-1",
    planVersion: 1,
    status: "running",
    priorRunId: null,
    cancellationRequested: false,
    inputRequired: false,
    usage: syntheticWorkflowFixtures.dataAnalysis.case.usage,
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
  };

  it.each([null, run, { ...run, status: "failed" }])(
    "loads a nullable latest run through the authenticated API",
    async (latestRun) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ run: latestRun }));
      const client = new FetchWebApiClient({
        getToken: () => "session-token",
        onUnauthorized: vi.fn(),
        fetcher,
      });

      expect(await client.getLatestRun("case/1")).toEqual(latestRun);
      expect(fetcher.mock.calls[0][0]).toBe("/cases/case%2F1/runs/latest");
      expect(fetcher.mock.calls[0][1]?.cache).toBe("no-store");
    },
  );

  it.each([403, 404, 500])(
    "does not treat a latest-run lookup failure (%i) as an empty case",
    async (status) => {
      const client = new FetchWebApiClient({
        getToken: () => "session-token",
        onUnauthorized: vi.fn(),
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ error: { message: "Lookup failed." } }, { status }),
          ),
      });
      await expect(client.getLatestRun("case-1")).rejects.toMatchObject({
        status,
        message: "Lookup failed.",
      });
    },
  );

  it("rejects a malformed latest-run response", async () => {
    const client = new FetchWebApiClient({
      getToken: () => "session-token",
      onUnauthorized: vi.fn(),
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
    });
    await expect(client.getLatestRun("case-1")).rejects.toMatchObject({
      status: 502,
    });
  });

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

  it("follows all case-list cursors", async () => {
    const record = syntheticWorkflowFixtures.dataAnalysis.case;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ cases: [record], nextCursor: "next/page" }),
      )
      .mockResolvedValueOnce(
        Response.json({ cases: [record], nextCursor: null }),
      );
    const client = new FetchWebApiClient({
      getToken: () => "session-token",
      onUnauthorized: vi.fn(),
      fetcher,
    });

    expect(await client.listCases()).toEqual([record, record]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/cases",
      "/cases?cursor=next%2Fpage",
    ]);
  });

  it("returns document metadata from the shared upload response envelope", async () => {
    const document = {
      id: "document-1",
      caseId: "case-1",
      name: "source.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      state: "uploaded",
      uploadedAt: "2026-01-15T00:00:00.000Z",
      processedAt: null,
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ document }));
    const client = new FetchWebApiClient({
      getToken: () => "session-token",
      onUnauthorized: vi.fn(),
      fetcher,
    });

    await expect(
      client.uploadDocument(
        "case-1",
        new File(["data"], "source.pdf", { type: "application/pdf" }),
        "mixed",
      ),
    ).resolves.toEqual(document);
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

  it("does not invalidate a newer session after an old request returns 401", async () => {
    let token = "old-session";
    let resolveResponse!: (response: Response) => void;
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const client = new FetchWebApiClient({
      getToken: () => token,
      onUnauthorized,
      fetcher,
    });

    const request = client.listCases();
    token = "new-session";
    resolveResponse(
      Response.json(
        { error: { message: "The old session expired." } },
        { status: 401 },
      ),
    );

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
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
