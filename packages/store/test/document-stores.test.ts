import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { BoundedStream, DocumentStore } from "@evianta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentStoreError } from "../src/document-errors.js";
import { FileSystemDocumentStore } from "../src/document-filesystem.js";
import { InMemoryDocumentStore } from "../src/document-memory.js";
import { S3DocumentStore } from "../src/document-s3.js";

const payload = Buffer.from("bounded document bytes");
const contentHash = createHash("sha256").update(payload).digest("hex");

function boundedStream(
  bytes: Uint8Array = payload,
  options: { contentLength?: number; contentHash?: string } = {},
): BoundedStream {
  return {
    body: (async function* () {
      yield bytes.slice(0, 7);
      yield bytes.slice(7);
    })(),
    contentLength: options.contentLength ?? bytes.byteLength,
    contentHash:
      options.contentHash ?? createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sharedContract(
  name: string,
  setup: () => Promise<{ store: DocumentStore; close: () => Promise<void> }>,
): void {
  describe(name, () => {
    let store: DocumentStore;
    let close: () => Promise<void> = async () => undefined;

    afterEach(async () => {
      await close?.();
    });

    it("round-trips bounded bytes with opaque keys and content metadata", async () => {
      ({ store, close } = await setup());
      const key = await store.uploadAsync(
        "case-1",
        "text/plain",
        boundedStream(),
      );
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(key).not.toContain("case-1");

      const object = await store.readStreamAsync(key);
      expect(object).toMatchObject({
        contentType: "text/plain",
        contentLength: payload.byteLength,
        contentHash,
      });
      expect(await collect(object!.body)).toEqual(payload);
      expect(await store.readBufferAsync(key, payload.byteLength)).toEqual(
        payload,
      );
    });

    it("reports missing objects, enforces read limits and deletes idempotently", async () => {
      ({ store, close } = await setup());
      expect(
        await store.readStreamAsync("00000000-0000-0000-0000-000000000000"),
      ).toBeNull();
      const key = await store.uploadAsync(
        "case-1",
        "text/plain",
        boundedStream(),
      );
      await expect(
        store.readBufferAsync(key, payload.byteLength - 1),
      ).rejects.toMatchObject({
        code: "too-large",
      });
      await store.deleteAsync(key);
      await store.deleteAsync(key);
      expect(await store.readStreamAsync(key)).toBeNull();
    });

    it("rejects invalid keys and incomplete or oversized streams explicitly", async () => {
      ({ store, close } = await setup());
      await expect(store.readStreamAsync("../outside")).rejects.toMatchObject({
        code: "invalid-key",
      });
      await expect(
        store.uploadAsync("case-1", "text/plain", {
          ...boundedStream(),
          contentLength: payload.byteLength + 1,
        }),
      ).rejects.toMatchObject({ code: "invalid-upload" });
      await expect(
        store.uploadAsync(
          "case-1",
          "text/plain",
          boundedStream(new Uint8Array(33)),
        ),
      ).rejects.toMatchObject({ code: "too-large" });
    });
  });
}

describe("in-memory document store", () => {
  sharedContract("document store contract", async () => ({
    store: new InMemoryDocumentStore(32),
    close: async () => undefined,
  }));
});

describe("filesystem document store", () => {
  sharedContract("document store contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evianta-documents-"));
    return {
      store: new FileSystemDocumentStore({ directory, maxUploadBytes: 32 }),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  });

  it("does not leave files behind when an upload stream is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evianta-documents-"));
    const store = new FileSystemDocumentStore({
      directory,
      maxUploadBytes: 32,
    });
    const interrupted: BoundedStream = {
      contentLength: 4,
      contentHash,
      body: (async function* () {
        yield Buffer.from("part");
        throw new Error("stream interrupted");
      })(),
    };

    try {
      await expect(
        store.uploadAsync("case-1", "text/plain", interrupted),
      ).rejects.toMatchObject({ code: "upload-failed" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps uploaded document files private to the service account",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "evianta-documents-"));
      const store = new FileSystemDocumentStore({ directory });

      try {
        const key = await store.uploadAsync(
          "case-1",
          "text/plain",
          boundedStream(),
        );
        const objectDirectory = join(directory, key);
        const objectDirectoryStat = await stat(objectDirectory);
        const dataStat = await stat(join(objectDirectory, "data"));
        const metadataStat = await stat(join(objectDirectory, "metadata.json"));

        expect(objectDirectoryStat.mode & 0o777).toBe(0o700);
        expect(dataStat.mode & 0o777).toBe(0o600);
        expect(metadataStat.mode & 0o777).toBe(0o600);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("S3 document store", () => {
  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
  });
  const s3Mock = mockClient(client);
  const store = new S3DocumentStore({
    client,
    bucket: "private-documents",
    maxSignedUrlTtlSeconds: 60,
  });

  afterEach(() => {
    s3Mock.reset();
  });

  it("uses private encrypted object requests and stores bounded metadata", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const key = await store.uploadAsync(
      "case-1",
      "text/plain",
      boundedStream(),
    );
    const command = s3Mock.commandCalls(PutObjectCommand)[0].args[0];
    expect(command.input).toMatchObject({
      Bucket: "private-documents",
      Key: key,
      ContentLength: payload.byteLength,
      ContentType: "text/plain",
      Metadata: { "content-sha256": contentHash },
      ServerSideEncryption: "AES256",
    });
    expect(key).not.toContain("case-1");
  });

  it("streams S3 reads and returns null for a missing object", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([payload]),
      ContentLength: payload.byteLength,
      ContentType: "text/plain",
      Metadata: { "content-sha256": contentHash },
    });
    expect(
      await store.readBufferAsync(
        "00000000-0000-0000-0000-000000000000",
        payload.byteLength,
      ),
    ).toEqual(payload);

    s3Mock
      .on(GetObjectCommand)
      .rejects(Object.assign(new Error("not found"), { name: "NoSuchKey" }));
    expect(
      await store.readStreamAsync("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("does not treat a missing bucket as a missing object", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("bucket not found"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    await expect(
      store.readStreamAsync("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "s3-read-failed" });
  });

  it("destroys S3 bodies rejected for invalid metadata or read limits", async () => {
    const invalidMetadataBody = Readable.from([payload]);
    const destroyInvalidMetadataBody = vi.spyOn(invalidMetadataBody, "destroy");
    s3Mock.on(GetObjectCommand).resolves({
      Body: invalidMetadataBody,
      ContentLength: payload.byteLength,
      ContentType: "text/plain",
      Metadata: {},
    });

    await expect(
      store.readStreamAsync("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "corrupt-object" });
    expect(destroyInvalidMetadataBody).toHaveBeenCalledOnce();

    const invalidLimitBody = Readable.from([payload]);
    const destroyInvalidLimitBody = vi.spyOn(invalidLimitBody, "destroy");
    s3Mock.on(GetObjectCommand).resolves({
      Body: invalidLimitBody,
      ContentLength: payload.byteLength,
      ContentType: "text/plain",
      Metadata: { "content-sha256": contentHash },
    });

    await expect(
      store.readBufferAsync("00000000-0000-0000-0000-000000000000", -1),
    ).rejects.toMatchObject({ code: "invalid-limit" });
    expect(destroyInvalidLimitBody).toHaveBeenCalledOnce();
  });

  it("caps signed URL expiry and does not send an AWS request", async () => {
    const url = await store.getSignedUrlAsync(
      "00000000-0000-0000-0000-000000000000",
      120,
    );
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it("wraps storage failures and rejects invalid TTLs", async () => {
    s3Mock.on(DeleteObjectCommand).rejects(new Error("offline"));
    await expect(
      store.deleteAsync("00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(DocumentStoreError);
    await expect(
      store.getSignedUrlAsync("00000000-0000-0000-0000-000000000000", 0),
    ).rejects.toMatchObject({ code: "invalid-expiry" });
  });
});
