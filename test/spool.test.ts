import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanSpool } from "../src/spool";
import {
  deterministicId,
  msToNanoString,
  type OtlpSpan,
  type SpanExportClient,
} from "../src/trace-shipper";

function span(): OtlpSpan {
  return {
    traceId: deterministicId("trace", 16),
    spanId: deterministicId("span", 8),
    name: "test",
    kind: 1,
    startTimeUnixNano: msToNanoString(1),
    endTimeUnixNano: msToNanoString(2),
    attributes: [],
  };
}

describe("SpanSpool", () => {
  let root: string;
  let spool: SpanSpool;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neatlogs-codex-spool-"));
    spool = new SpanSpool(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("retains retryable batches and drains them later", async () => {
    spool.enqueue([span()], "workflow");
    const retrying: SpanExportClient = {
      exportSpans: vi.fn().mockResolvedValue("retryable"),
    };
    expect((await spool.drain(retrying)).retained).toBe(1);

    const succeeding: SpanExportClient = {
      exportSpans: vi.fn().mockResolvedValue("success"),
    };
    const result = await spool.drain(succeeding);
    expect(result.sent).toBe(1);
    expect(result.retained).toBe(0);
    expect(succeeding.exportSpans).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "test" })],
      "workflow",
    );
  });

  it("drops terminal batches", async () => {
    spool.enqueue([span()]);
    const exporter: SpanExportClient = {
      exportSpans: vi.fn().mockResolvedValue("terminal"),
    };
    const result = await spool.drain(exporter);
    expect(result.dropped).toBe(1);
    expect(result.retained).toBe(0);
  });
});
