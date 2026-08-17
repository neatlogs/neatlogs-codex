import { createHash, randomBytes } from "node:crypto";
import protobuf from "protobufjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";

export interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface OtlpSpan {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId?: Uint8Array;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code: number; message?: string };
}

export type ExportResult = "success" | "retryable" | "terminal";

export interface SpanExportClient {
  exportSpans(spans: OtlpSpan[], workflowName?: string): Promise<ExportResult>;
}

const OTLP_PROTO_JSON: protobuf.INamespace = {
  nested: {
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            common: {
              nested: {
                v1: {
                  nested: {
                    AnyValue: {
                      oneofs: {
                        value: {
                          oneof: [
                            "stringValue",
                            "boolValue",
                            "intValue",
                            "doubleValue",
                            "arrayValue",
                            "kvlistValue",
                            "bytesValue",
                          ],
                        },
                      },
                      fields: {
                        stringValue: { type: "string", id: 1 },
                        boolValue: { type: "bool", id: 2 },
                        intValue: { type: "int64", id: 3 },
                        doubleValue: { type: "double", id: 4 },
                        arrayValue: { type: "ArrayValue", id: 5 },
                        kvlistValue: { type: "KeyValueList", id: 6 },
                        bytesValue: { type: "bytes", id: 7 },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: { rule: "repeated", type: "AnyValue", id: 1 },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: { rule: "repeated", type: "KeyValue", id: 1 },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: { type: "string", id: 1 },
                        value: { type: "AnyValue", id: 2 },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        name: { type: "string", id: 1 },
                        version: { type: "string", id: 2 },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    ResourceSpans: {
                      fields: {
                        resource: { type: "opentelemetry.proto.resource.v1.Resource", id: 1 },
                        scopeSpans: { rule: "repeated", type: "ScopeSpans", id: 2 },
                      },
                    },
                    ScopeSpans: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        spans: { rule: "repeated", type: "Span", id: 2 },
                      },
                    },
                    Span: {
                      fields: {
                        traceId: { type: "bytes", id: 1 },
                        spanId: { type: "bytes", id: 2 },
                        traceState: { type: "string", id: 3 },
                        parentSpanId: { type: "bytes", id: 4 },
                        name: { type: "string", id: 5 },
                        kind: { type: "SpanKind", id: 6 },
                        startTimeUnixNano: { type: "fixed64", id: 7 },
                        endTimeUnixNano: { type: "fixed64", id: 8 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 9,
                        },
                        droppedAttributesCount: { type: "uint32", id: 10 },
                        events: { rule: "repeated", type: "SpanEvent", id: 11 },
                        droppedEventsCount: { type: "uint32", id: 12 },
                        links: { rule: "repeated", type: "SpanLink", id: 13 },
                        droppedLinksCount: { type: "uint32", id: 14 },
                        status: { type: "Status", id: 15 },
                      },
                    },
                    SpanEvent: {
                      fields: {
                        timeUnixNano: { type: "fixed64", id: 1 },
                        name: { type: "string", id: 2 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 3,
                        },
                      },
                    },
                    SpanLink: {
                      fields: {
                        traceId: { type: "bytes", id: 1 },
                        spanId: { type: "bytes", id: 2 },
                        traceState: { type: "string", id: 3 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 4,
                        },
                      },
                    },
                    Status: {
                      fields: {
                        message: { type: "string", id: 2 },
                        code: { type: "StatusCode", id: 3 },
                      },
                    },
                    StatusCode: {
                      values: {
                        STATUS_CODE_UNSET: 0,
                        STATUS_CODE_OK: 1,
                        STATUS_CODE_ERROR: 2,
                      },
                    },
                    SpanKind: {
                      values: {
                        SPAN_KIND_UNSPECIFIED: 0,
                        SPAN_KIND_INTERNAL: 1,
                        SPAN_KIND_SERVER: 2,
                        SPAN_KIND_CLIENT: 3,
                        SPAN_KIND_PRODUCER: 4,
                        SPAN_KIND_CONSUMER: 5,
                      },
                    },
                  },
                },
              },
            },
            collector: {
              nested: {
                trace: {
                  nested: {
                    v1: {
                      nested: {
                        ExportTraceServiceRequest: {
                          fields: {
                            resourceSpans: {
                              rule: "repeated",
                              type: "opentelemetry.proto.trace.v1.ResourceSpans",
                              id: 1,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const protoRoot = protobuf.Root.fromJSON(OTLP_PROTO_JSON);
const ExportTraceServiceRequest = protoRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export function deterministicId(input: string, length: 8 | 16): Uint8Array {
  const digest = createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, length);
}

export function generateSpanId(): Uint8Array {
  return new Uint8Array(randomBytes(8));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function msToNanoString(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

export function attrString(key: string, value: string | null | undefined): OtlpKeyValue | undefined {
  if (value === undefined || value === null) return undefined;
  return { key, value: { stringValue: value } };
}

export function attrInt(key: string, value: number | undefined): OtlpKeyValue | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

export function attrDouble(key: string, value: number | undefined): OtlpKeyValue | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { key, value: { doubleValue: value } };
}

export function attrBool(key: string, value: boolean | undefined): OtlpKeyValue | undefined {
  if (value === undefined) return undefined;
  return { key, value: { boolValue: value } };
}

function nanoStringToLong(value: string): { low: number; high: number; unsigned: boolean } {
  const bigint = BigInt(value);
  return {
    low: Number(bigint & 0xffffffffn),
    high: Number((bigint >> 32n) & 0xffffffffn),
    unsigned: true,
  };
}

export function encodeTraceRequest(spans: OtlpSpan[], workflowName?: string): Uint8Array {
  const resourceAttributes = [
    { key: "service.name", value: { stringValue: "neatlogs.codex" } },
    { key: "service.version", value: { stringValue: PACKAGE_VERSION } },
    { key: "neatlogs.sdk.name", value: { stringValue: PACKAGE_NAME } },
    { key: "neatlogs.sdk.version", value: { stringValue: PACKAGE_VERSION } },
  ];
  if (workflowName) {
    resourceAttributes.push({ key: "neatlogs.workflow_name", value: { stringValue: workflowName } });
  }

  const message = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: nanoStringToLong(span.startTimeUnixNano),
              endTimeUnixNano: nanoStringToLong(span.endTimeUnixNano),
              attributes: span.attributes.map((attribute) => ({
                key: attribute.key,
                value:
                  attribute.value.intValue !== undefined
                    ? { intValue: nanoStringToLong(attribute.value.intValue) }
                    : attribute.value,
              })),
              status: span.status,
            })),
          },
        ],
      },
    ],
  };

  const validationError = ExportTraceServiceRequest.verify(message);
  if (validationError) throw new Error(`Invalid OTLP trace payload: ${validationError}`);
  return ExportTraceServiceRequest.encode(ExportTraceServiceRequest.fromObject(message)).finish();
}

function tracesEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

export interface TraceExporterOptions {
  apiKey: string;
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TraceExporter implements SpanExportClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TraceExporterOptions) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exportSpans(spans: OtlpSpan[], workflowName?: string): Promise<ExportResult> {
    if (spans.length === 0) return "success";
    if (!this.options.apiKey) return "terminal";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(tracesEndpoint(this.options.endpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          "x-api-key": this.options.apiKey,
        },
        body: encodeTraceRequest(spans, workflowName),
        signal: controller.signal,
      });
      if (response.ok) return "success";
      if (response.status === 429 || response.status >= 500) return "retryable";
      return "terminal";
    } catch {
      return "retryable";
    } finally {
      clearTimeout(timeout);
    }
  }
}
