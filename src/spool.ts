import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  bytesToHex,
  hexToBytes,
  type OtlpSpan,
  type SpanExportClient,
} from "./trace-shipper";

interface SerializedSpan extends Omit<OtlpSpan, "traceId" | "spanId" | "parentSpanId"> {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

interface PendingBatch {
  version: 1;
  createdAt: string;
  workflowName?: string;
  spans: SerializedSpan[];
}

export interface DrainResult {
  sent: number;
  dropped: number;
  retained: number;
  skipped: boolean;
}

function serializeSpan(span: OtlpSpan): SerializedSpan {
  return {
    ...span,
    traceId: bytesToHex(span.traceId),
    spanId: bytesToHex(span.spanId),
    parentSpanId: span.parentSpanId ? bytesToHex(span.parentSpanId) : undefined,
  };
}

function deserializeSpan(span: SerializedSpan): OtlpSpan {
  return {
    ...span,
    traceId: hexToBytes(span.traceId),
    spanId: hexToBytes(span.spanId),
    parentSpanId: span.parentSpanId ? hexToBytes(span.parentSpanId) : undefined,
  };
}

export class SpanSpool {
  private readonly pendingDirectory: string;
  private readonly lockPath: string;

  constructor(public readonly root: string) {
    this.pendingDirectory = join(root, "spool", "pending");
    this.lockPath = join(root, "spool", "drain.lock");
  }

  enqueue(spans: OtlpSpan[], workflowName?: string): string | undefined {
    if (spans.length === 0) return undefined;
    mkdirSync(this.pendingDirectory, { recursive: true, mode: 0o700 });
    const filename = `${Date.now()}-${process.pid}-${randomUUID()}.json`;
    const destination = join(this.pendingDirectory, filename);
    const temporary = `${destination}.tmp`;
    const batch: PendingBatch = {
      version: 1,
      createdAt: new Date().toISOString(),
      workflowName,
      spans: spans.map(serializeSpan),
    };
    writeFileSync(temporary, JSON.stringify(batch), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
    return destination;
  }

  pendingFiles(): string[] {
    if (!existsSync(this.pendingDirectory)) return [];
    return readdirSync(this.pendingDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(this.pendingDirectory, name));
  }

  private acquireLock(): number | undefined {
    mkdirSync(join(this.root, "spool"), { recursive: true, mode: 0o700 });
    try {
      return openSync(this.lockPath, "wx", 0o600);
    } catch {
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > 30_000) {
          rmSync(this.lockPath, { force: true });
          return openSync(this.lockPath, "wx", 0o600);
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
  }

  private releaseLock(descriptor: number): void {
    closeSync(descriptor);
    rmSync(this.lockPath, { force: true });
  }

  async drain(exporter: SpanExportClient, maxBatches = 8): Promise<DrainResult> {
    const descriptor = this.acquireLock();
    if (descriptor === undefined) {
      return { sent: 0, dropped: 0, retained: this.pendingFiles().length, skipped: true };
    }

    let sent = 0;
    let dropped = 0;
    try {
      for (const path of this.pendingFiles().slice(0, maxBatches)) {
        let batch: PendingBatch;
        try {
          batch = JSON.parse(readFileSync(path, "utf8")) as PendingBatch;
          if (batch.version !== 1 || !Array.isArray(batch.spans)) throw new Error("Invalid batch");
        } catch {
          rmSync(path, { force: true });
          dropped += 1;
          continue;
        }

        const result = await exporter.exportSpans(batch.spans.map(deserializeSpan), batch.workflowName);
        if (result === "retryable") break;
        rmSync(path, { force: true });
        if (result === "success") sent += 1;
        else dropped += 1;
      }
    } finally {
      this.releaseLock(descriptor);
    }

    return { sent, dropped, retained: this.pendingFiles().length, skipped: false };
  }
}
