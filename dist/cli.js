#!/usr/bin/env node

// src/config.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir, userInfo } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
function getConfigPath(home = homedir()) {
  return join(home, ".config", "neatlogs", "config.json");
}
function readConfigFile(path) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function defaultUserId() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
function loadConfig(env = process.env, path = getConfigPath()) {
  const file = readConfigFile(path);
  return {
    apiKey: env.NEATLOGS_API_KEY ?? file.api_key ?? "",
    endpoint: env.NEATLOGS_ENDPOINT ?? file.endpoint ?? "https://ingest.neatlogs.com",
    userId: env.NEATLOGS_USER_ID ?? file.user_id ?? defaultUserId(),
    debug: env.NEATLOGS_DEBUG === "true" || env.NEATLOGS_DEBUG === void 0 && file.debug === true
  };
}
function updateConfig(patch, path = getConfigPath()) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 448 });
  const next = { ...readConfigFile(path), ...patch };
  const tempPath = join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync(tempPath, path);
}

// src/codex-events.ts
var CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop"
];
function isCodexHookPayload(value) {
  if (!value || typeof value !== "object") return false;
  const record2 = value;
  return typeof record2.session_id === "string" && typeof record2.hook_event_name === "string" && CODEX_HOOK_EVENTS.includes(record2.hook_event_name);
}

// src/diagnostics.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
function appendDebugLog(runtimeRoot, message) {
  try {
    mkdirSync2(runtimeRoot, { recursive: true, mode: 448 });
    appendFileSync(
      join2(runtimeRoot, "debug.log"),
      `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`,
      { encoding: "utf8", mode: 384 }
    );
  } catch {
  }
}

// src/compatibility-events.ts
function isExplicitApprovalDenial(message) {
  const normalized = message.replace(/\s+/g, " ").trim();
  const denial = "(?:denied|declined|rejected)";
  const actor = "(?:user|approval(?: request)?|authorization request)";
  return new RegExp(`\\b${actor}\\b.{0,48}\\b${denial}\\b`, "i").test(normalized) || new RegExp(`\\b${denial}\\b.{0,48}\\b${actor}\\b`, "i").test(normalized);
}
function deriveCodexCompatibilityEvents(payload, context = {}) {
  switch (payload.hook_event_name) {
    case "PostToolUse": {
      if (!context.toolError) return [];
      const events = [
        {
          name: "PostToolUseFailure",
          source: "PostToolUse",
          fidelity: "equivalent"
        }
      ];
      if (isExplicitApprovalDenial(context.toolError)) {
        events.push({
          name: "PermissionDenied",
          source: "PostToolUse",
          fidelity: "inferred"
        });
      }
      return events;
    }
    case "SubagentStart":
      return [{ name: "TaskCreated", source: "SubagentStart", fidelity: "equivalent" }];
    case "SubagentStop":
      return [{ name: "TaskCompleted", source: "SubagentStop", fidelity: "equivalent" }];
    default:
      return [];
  }
}

// src/transcript.ts
import {
  closeSync,
  existsSync as existsSync2,
  fstatSync,
  openSync,
  readSync
} from "fs";
var INITIAL_TAIL_BYTES = 1 * 1024 * 1024;
var MAX_TAIL_BYTES = 64 * 1024 * 1024;
var EMPTY_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
};
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function booleanValue(value) {
  return typeof value === "boolean" ? value : void 0;
}
function hasError(value) {
  return value !== void 0 && value !== null && value !== false && value !== "";
}
function safeTurnError(value) {
  if (typeof value === "string") return value.slice(0, 8192);
  const details = record(value);
  if (!details) return "Codex turn failed";
  const safe = {};
  for (const key of ["message", "type", "code", "param", "status"]) {
    const detail = details[key];
    if (typeof detail === "string") safe[key] = detail.slice(0, 8192);
    else if (typeof detail === "number" || typeof detail === "boolean") safe[key] = detail;
  }
  return Object.keys(safe).length > 0 ? safe : "Codex turn failed";
}
function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e10 ? value * 1e3 : value;
  }
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function usageFrom(value) {
  const usage = record(value);
  if (!usage) return void 0;
  const result = {
    inputTokens: numberValue(usage.input_tokens) ?? 0,
    cachedInputTokens: numberValue(usage.cached_input_tokens) ?? 0,
    cacheWriteInputTokens: numberValue(usage.cache_write_input_tokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    reasoningOutputTokens: numberValue(usage.reasoning_output_tokens) ?? 0,
    totalTokens: numberValue(usage.total_tokens) ?? 0
  };
  return Object.values(result).some((count) => count !== 0) ? result : void 0;
}
function newPhase(startMs, inputs = []) {
  return {
    inputs,
    text: [],
    reasoningSummary: [],
    toolCalls: [],
    hasReasoning: false,
    startMs
  };
}
function unique(values) {
  return [...new Set(values)];
}
function summaryText(payload) {
  if (!Array.isArray(payload.summary)) return [];
  return payload.summary.flatMap((part) => {
    const item = record(part);
    const text = stringValue(item?.text);
    return text ? [text] : [];
  });
}
function assistantText(payload) {
  if (payload.role !== "assistant" || !Array.isArray(payload.content)) return [];
  return payload.content.flatMap((part) => {
    const item = record(part);
    if (item?.type !== "output_text" && item?.type !== "text") return [];
    const text = stringValue(item.text);
    return text ? [text] : [];
  });
}
function containsTurnStart(text, turnId) {
  return text.split("\n").some((line) => {
    if (turnId && !line.includes(turnId)) return false;
    return line.includes('"type":"task_started"') || line.includes('"type":"turn_context"');
  });
}
function readTailContainingTurn(path, turnId) {
  if (!existsSync2(path)) return void 0;
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return "";
    let bytes = Math.min(size, INITIAL_TAIL_BYTES);
    let text = "";
    let start = 0;
    while (true) {
      start = size - bytes;
      const buffer = Buffer.allocUnsafe(bytes);
      const read = readSync(descriptor, buffer, 0, bytes, start);
      text = buffer.subarray(0, read).toString("utf8");
      if (containsTurnStart(text, turnId) || start === 0 || bytes >= MAX_TAIL_BYTES) break;
      bytes = Math.min(size, MAX_TAIL_BYTES, bytes * 2);
    }
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}
function readSessionMetadataLine(path) {
  if (!existsSync2(path)) return void 0;
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return void 0;
    const bytes = Math.min(size, INITIAL_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session_meta") return line;
      } catch {
      }
    }
    return void 0;
  } finally {
    closeSync(descriptor);
  }
}
function inspectCodexTranscriptSession(transcriptPath) {
  const line = readSessionMetadataLine(transcriptPath);
  if (!line) return void 0;
  try {
    const entry = JSON.parse(line);
    const payload = record(entry.payload);
    if (entry.type !== "session_meta" || !payload) return void 0;
    const source = record(payload.source);
    return {
      threadId: stringValue(payload.id),
      parentThreadId: stringValue(payload.parent_thread_id),
      threadSource: stringValue(payload.thread_source),
      isSubagent: payload.thread_source === "subagent" || Boolean(source?.subagent)
    };
  } catch {
    return void 0;
  }
}
function candidateTurnId(lines, requestedTurnId) {
  if (requestedTurnId) return requestedTurnId;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      const payload = record(entry.payload);
      if (entry.type === "turn_context" || payload?.type === "task_started") {
        const turnId = stringValue(payload?.turn_id);
        if (turnId) return turnId;
      }
    } catch {
    }
  }
  return void 0;
}
function parseCodexTranscript(transcriptPath, requestedTurnId) {
  const raw = readTailContainingTurn(transcriptPath, requestedTurnId);
  if (raw === void 0) return void 0;
  const sessionMetadata = readSessionMetadataLine(transcriptPath);
  const lines = [sessionMetadata, ...raw.split("\n")].filter(
    (line) => Boolean(line?.trim())
  );
  const turnId = candidateTurnId(lines, requestedTurnId);
  if (!turnId) return void 0;
  const result = { turnId, phases: [], toolCalls: [] };
  let currentTurnId;
  let inTargetTurn = false;
  let phase = newPhase();
  let nextPhaseInputs = [];
  const toolCalls = /* @__PURE__ */ new Map();
  const finishPhase = (usage, endMs) => {
    const hasContent = phase.text.length > 0 || phase.reasoningSummary.length > 0 || phase.toolCalls.length > 0 || phase.hasReasoning;
    if (!usage && !hasContent) return;
    result.phases.push({
      inputs: phase.inputs,
      text: phase.text.join("\n").trim(),
      reasoningSummary: phase.reasoningSummary.join("\n").trim(),
      toolCalls: unique(phase.toolCalls),
      usage: usage ?? { ...EMPTY_USAGE },
      hasReasoning: phase.hasReasoning || (usage?.reasoningOutputTokens ?? 0) > 0,
      startMs: phase.startMs,
      endMs: endMs ?? phase.lastEventMs
    });
    phase = newPhase(endMs ?? phase.lastEventMs, nextPhaseInputs);
    nextPhaseInputs = [];
  };
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record(entry.payload);
    if (!payload) continue;
    const eventMs = timestampMs(entry.timestamp);
    if (entry.type === "session_meta") {
      result.modelProvider ??= stringValue(payload.model_provider);
      result.sessionSource ??= stringValue(payload.source);
      result.cliVersion ??= stringValue(payload.cli_version);
      result.originator ??= stringValue(payload.originator);
      const git = record(payload.git);
      result.gitBranch ??= stringValue(git?.branch);
      result.gitCommit ??= stringValue(git?.commit_hash);
      continue;
    }
    if (payload.type === "task_started") {
      currentTurnId = stringValue(payload.turn_id);
      inTargetTurn = currentTurnId === turnId;
      phase = newPhase(timestampMs(payload.started_at) ?? eventMs);
      nextPhaseInputs = [];
      if (inTargetTurn) {
        result.modelContextWindow = numberValue(payload.model_context_window) ?? result.modelContextWindow;
        result.collaborationMode = stringValue(payload.collaboration_mode_kind) ?? result.collaborationMode;
      }
      continue;
    }
    if (entry.type === "turn_context") {
      currentTurnId = stringValue(payload.turn_id) ?? currentTurnId;
      inTargetTurn = currentTurnId === turnId;
      if (inTargetTurn) {
        result.model = stringValue(payload.model) ?? result.model;
        result.effort = stringValue(payload.effort) ?? result.effort;
        result.approvalPolicy = stringValue(payload.approval_policy) ?? result.approvalPolicy;
        const collaborationMode = record(payload.collaboration_mode);
        result.collaborationMode = stringValue(collaborationMode?.mode) ?? result.collaborationMode;
        const sandboxPolicy = record(payload.sandbox_policy);
        const fileSystemSandboxPolicy = record(payload.file_system_sandbox_policy);
        result.sandboxMode = stringValue(sandboxPolicy?.type) ?? stringValue(fileSystemSandboxPolicy?.type) ?? result.sandboxMode;
        result.networkAccess = booleanValue(sandboxPolicy?.network_access) ?? result.networkAccess;
        phase.startMs ??= eventMs;
      }
      continue;
    }
    if (!inTargetTurn) continue;
    phase.lastEventMs = eventMs ?? phase.lastEventMs;
    if (entry.type === "response_item") {
      if (payload.type === "message") phase.text.push(...assistantText(payload));
      if (payload.type === "reasoning") {
        phase.hasReasoning = true;
        phase.reasoningSummary.push(...summaryText(payload));
      }
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = stringValue(payload.name);
        if (name) phase.toolCalls.push(name);
        const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
        if (name && callId) {
          const toolCall = {
            callId,
            name,
            input: payload.arguments ?? payload.input,
            startMs: eventMs
          };
          toolCalls.set(callId, toolCall);
          result.toolCalls.push(toolCall);
        }
      }
      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = stringValue(payload.call_id);
        const toolCall = callId ? toolCalls.get(callId) : void 0;
        if (toolCall) {
          toolCall.output = payload.output;
          toolCall.endMs = eventMs;
        }
        if (payload.output !== void 0) nextPhaseInputs.push(payload.output);
      }
      continue;
    }
    if (entry.type !== "event_msg") continue;
    if (payload.type === "token_count") {
      const info = record(payload.info);
      result.modelContextWindow = numberValue(info?.model_context_window) ?? result.modelContextWindow;
      finishPhase(usageFrom(info?.last_token_usage), eventMs);
      continue;
    }
    if (payload.type === "task_complete" && payload.turn_id === turnId) {
      finishPhase(void 0, eventMs);
      result.lastAssistantMessage = stringValue(payload.last_agent_message);
      result.durationMs = numberValue(payload.duration_ms);
      result.timeToFirstTokenMs = numberValue(payload.time_to_first_token_ms);
      result.turnStatus = hasError(payload.error) ? "error" : "ok";
      if (result.turnStatus === "error") result.turnError = safeTurnError(payload.error);
      break;
    }
  }
  finishPhase(void 0);
  return result;
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function parseCodexTranscriptWithRetry(transcriptPath, turnId) {
  const delays = [0, 50, 100, 200];
  let summary;
  for (const delay of delays) {
    if (delay) sleepSync(delay);
    summary = parseCodexTranscript(transcriptPath, turnId);
    if (summary && summary.phases.some((phase) => phase.usage.totalTokens > 0)) return summary;
  }
  return summary;
}

// src/trace-shipper.ts
import { createHash, randomBytes } from "crypto";
import protobuf from "protobufjs";

// src/package-info.ts
import { readFileSync as readFileSync2 } from "fs";
var PACKAGE_NAME = "@neatlogs/codex";
function readPackageVersion() {
  try {
    const raw = readFileSync2(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var PACKAGE_VERSION = readPackageVersion();

// src/trace-shipper.ts
var OTLP_PROTO_JSON = {
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
                            "bytesValue"
                          ]
                        }
                      },
                      fields: {
                        stringValue: { type: "string", id: 1 },
                        boolValue: { type: "bool", id: 2 },
                        intValue: { type: "int64", id: 3 },
                        doubleValue: { type: "double", id: 4 },
                        arrayValue: { type: "ArrayValue", id: 5 },
                        kvlistValue: { type: "KeyValueList", id: 6 },
                        bytesValue: { type: "bytes", id: 7 }
                      }
                    },
                    ArrayValue: {
                      fields: {
                        values: { rule: "repeated", type: "AnyValue", id: 1 }
                      }
                    },
                    KeyValueList: {
                      fields: {
                        values: { rule: "repeated", type: "KeyValue", id: 1 }
                      }
                    },
                    KeyValue: {
                      fields: {
                        key: { type: "string", id: 1 },
                        value: { type: "AnyValue", id: 2 }
                      }
                    },
                    InstrumentationScope: {
                      fields: {
                        name: { type: "string", id: 1 },
                        version: { type: "string", id: 2 }
                      }
                    }
                  }
                }
              }
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
                          id: 1
                        }
                      }
                    }
                  }
                }
              }
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    ResourceSpans: {
                      fields: {
                        resource: { type: "opentelemetry.proto.resource.v1.Resource", id: 1 },
                        scopeSpans: { rule: "repeated", type: "ScopeSpans", id: 2 }
                      }
                    },
                    ScopeSpans: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1
                        },
                        spans: { rule: "repeated", type: "Span", id: 2 }
                      }
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
                          id: 9
                        },
                        droppedAttributesCount: { type: "uint32", id: 10 },
                        events: { rule: "repeated", type: "SpanEvent", id: 11 },
                        droppedEventsCount: { type: "uint32", id: 12 },
                        links: { rule: "repeated", type: "SpanLink", id: 13 },
                        droppedLinksCount: { type: "uint32", id: 14 },
                        status: { type: "Status", id: 15 }
                      }
                    },
                    SpanEvent: {
                      fields: {
                        timeUnixNano: { type: "fixed64", id: 1 },
                        name: { type: "string", id: 2 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 3
                        }
                      }
                    },
                    SpanLink: {
                      fields: {
                        traceId: { type: "bytes", id: 1 },
                        spanId: { type: "bytes", id: 2 },
                        traceState: { type: "string", id: 3 },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 4
                        }
                      }
                    },
                    Status: {
                      fields: {
                        message: { type: "string", id: 2 },
                        code: { type: "StatusCode", id: 3 }
                      }
                    },
                    StatusCode: {
                      values: {
                        STATUS_CODE_UNSET: 0,
                        STATUS_CODE_OK: 1,
                        STATUS_CODE_ERROR: 2
                      }
                    },
                    SpanKind: {
                      values: {
                        SPAN_KIND_UNSPECIFIED: 0,
                        SPAN_KIND_INTERNAL: 1,
                        SPAN_KIND_SERVER: 2,
                        SPAN_KIND_CLIENT: 3,
                        SPAN_KIND_PRODUCER: 4,
                        SPAN_KIND_CONSUMER: 5
                      }
                    }
                  }
                }
              }
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
                              id: 1
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
var protoRoot = protobuf.Root.fromJSON(OTLP_PROTO_JSON);
var ExportTraceServiceRequest = protoRoot.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest"
);
var SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2
};
function deterministicId(input, length) {
  const digest = createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, length);
}
function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}
function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
function msToNanoString(ms) {
  return (BigInt(Math.trunc(ms)) * 1000000n).toString();
}
function attrString(key, value) {
  if (value === void 0 || value === null) return void 0;
  return { key, value: { stringValue: value } };
}
function attrInt(key, value) {
  if (value === void 0 || !Number.isFinite(value)) return void 0;
  return { key, value: { intValue: String(Math.trunc(value)) } };
}
function attrDouble(key, value) {
  if (value === void 0 || !Number.isFinite(value)) return void 0;
  return { key, value: { doubleValue: value } };
}
function attrBool(key, value) {
  if (value === void 0) return void 0;
  return { key, value: { boolValue: value } };
}
function nanoStringToLong(value) {
  const bigint = BigInt(value);
  return {
    low: Number(bigint & 0xffffffffn),
    high: Number(bigint >> 32n & 0xffffffffn),
    unsigned: true
  };
}
function encodeTraceRequest(spans, workflowName2) {
  const resourceAttributes = [
    { key: "service.name", value: { stringValue: "neatlogs.codex" } },
    { key: "service.version", value: { stringValue: PACKAGE_VERSION } },
    { key: "neatlogs.sdk.name", value: { stringValue: PACKAGE_NAME } },
    { key: "neatlogs.sdk.version", value: { stringValue: PACKAGE_VERSION } }
  ];
  if (workflowName2) {
    resourceAttributes.push({ key: "neatlogs.workflow_name", value: { stringValue: workflowName2 } });
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
                value: attribute.value.intValue !== void 0 ? { intValue: nanoStringToLong(attribute.value.intValue) } : attribute.value
              })),
              status: span.status
            }))
          }
        ]
      }
    ]
  };
  const validationError = ExportTraceServiceRequest.verify(message);
  if (validationError) throw new Error(`Invalid OTLP trace payload: ${validationError}`);
  return ExportTraceServiceRequest.encode(ExportTraceServiceRequest.fromObject(message)).finish();
}
function tracesEndpoint(endpoint) {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}
var TraceExporter = class {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 2e3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  options;
  timeoutMs;
  fetchImpl;
  async exportSpans(spans, workflowName2) {
    if (spans.length === 0) return "success";
    if (!this.options.apiKey) return "terminal";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(tracesEndpoint(this.options.endpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          "x-api-key": this.options.apiKey
        },
        body: encodeTraceRequest(spans, workflowName2),
        signal: controller.signal
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
};

// src/event-mapper.ts
var MAX_STRING_LENGTH = 32768;
var SENSITIVE_KEY = /(^|_)(api[-_]?key|authorization|cookie|password|secret|token)($|_)/i;
function truncate(value, limit = MAX_STRING_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit)}
...[truncated]`;
}
function sanitizeValue(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
  if (typeof value === "string") return truncate(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[max depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1, seen));
  }
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(child, depth + 1, seen);
  }
  return result;
}
function safeStringify(value) {
  if (value === void 0) return void 0;
  try {
    return truncate(JSON.stringify(sanitizeValue(value)));
  } catch {
    return truncate(String(value));
  }
}
function errorText(value) {
  return typeof value === "string" ? truncate(value) : safeStringify(value);
}
function turnStateKey(turnId) {
  return `turn:${turnId}`;
}
function toolStateKey(turnId, toolUseId) {
  return `tool:${turnId}:${toolUseId}`;
}
function agentStateKey(turnId, agentId) {
  return `agent:${turnId}:${agentId}`;
}
function activeTurn(state, sessionId) {
  return state.read(sessionId, "active-turn");
}
function resolveTurnId(payload, state) {
  return payload.turn_id ?? activeTurn(state, payload.session_id)?.turnId ?? "session";
}
function readSessionState(payload, state) {
  return state.read(payload.session_id, "session") ?? {};
}
function ensureTurnState(payload, state, now) {
  const turnId = resolveTurnId(payload, state);
  const key = turnStateKey(turnId);
  const existing = state.read(payload.session_id, key);
  if (existing) return existing;
  const session = readSessionState(payload, state);
  const created = {
    turnId,
    prompt: payload.prompt,
    startMs: now,
    model: payload.model ?? session.model,
    cwd: payload.cwd ?? session.cwd,
    permissionMode: payload.permission_mode ?? session.permissionMode
  };
  state.write(payload.session_id, key, created);
  state.write(payload.session_id, "active-turn", { turnId });
  return created;
}
function ensureActiveParentTurnState(payload, state, now) {
  const active = activeTurn(state, payload.session_id);
  if (active) {
    const parent = state.read(
      payload.session_id,
      turnStateKey(active.turnId)
    );
    if (parent) return parent;
  }
  return ensureTurnState(payload, state, now);
}
function traceId(payload, turnId) {
  return deterministicId(`codex:${payload.session_id}:${turnId}`, 16);
}
function rootSpanId(payload, turnId) {
  return deterministicId(`codex:${payload.session_id}:${turnId}:root`, 8);
}
function workflowName(turn) {
  const normalized = turn.prompt?.replace(/\s+/g, " ").trim();
  return normalized ? truncate(normalized, 80) : "codex";
}
function attributes(values) {
  return values.filter((value) => value !== void 0);
}
function createChildSpan(payload, turn, identity, name, startMs, endMs, spanAttributes, status, parentSpanId) {
  return {
    traceId: traceId(payload, turn.turnId),
    spanId: deterministicId(`codex:${payload.session_id}:${turn.turnId}:${identity}`, 8),
    parentSpanId: parentSpanId ?? rootSpanId(payload, turn.turnId),
    name,
    kind: 1,
    startTimeUnixNano: msToNanoString(startMs),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: attributes([
      attrString("neatlogs.session.id", payload.session_id),
      ...spanAttributes
    ]),
    status
  };
}
function workflowMetadataAttributes(payload, turn, transcript, session, turnStatus) {
  return [
    attrString("neatlogs.workflow.cwd", turn.cwd ?? payload.cwd),
    attrString(
      "neatlogs.workflow.permission_mode",
      turn.permissionMode ?? payload.permission_mode
    ),
    attrString("neatlogs.workflow.approval_policy", transcript?.approvalPolicy),
    attrString("neatlogs.workflow.effort_level", transcript?.effort),
    attrInt("neatlogs.workflow.model_context_window", transcript?.modelContextWindow),
    attrString("neatlogs.workflow.collaboration_mode", transcript?.collaborationMode),
    attrString("neatlogs.workflow.sandbox_mode", transcript?.sandboxMode),
    attrBool("neatlogs.workflow.network_access", transcript?.networkAccess),
    attrString("neatlogs.workflow.turn_status", turnStatus ?? transcript?.turnStatus),
    attrString("neatlogs.workflow.turn_error", errorText(transcript?.turnError)),
    attrInt("neatlogs.workflow.time_to_first_token_ms", transcript?.timeToFirstTokenMs),
    attrBool("neatlogs.workflow.stop_hook_active", payload.stop_hook_active),
    attrString("neatlogs.session.start_source", session.source),
    attrString("neatlogs.session.client", transcript?.sessionSource),
    attrString("neatlogs.session.cli_version", transcript?.cliVersion),
    attrString("neatlogs.session.originator", transcript?.originator),
    attrString("neatlogs.session.git.branch", transcript?.gitBranch),
    attrString("neatlogs.session.git.commit", transcript?.gitCommit),
    attrString("neatlogs.session.end_reason", payload.reason)
  ];
}
function llmRuntimeAttributes(transcript, phaseIndex) {
  return [
    // These workflow-prefixed custom fields are intentionally placed only on
    // LLM spans so the existing Neatlogs finalizer preserves them in
    // spans_simplified.span_metadata.
    attrString("neatlogs.workflow.effort_level", transcript.effort),
    attrInt("neatlogs.workflow.model_context_window", transcript.modelContextWindow),
    attrInt(
      "neatlogs.workflow.time_to_first_token_ms",
      phaseIndex === 0 ? transcript.timeToFirstTokenMs : void 0
    )
  ];
}
function toolResponseError(response) {
  if (!response || typeof response !== "object") return void 0;
  const record2 = response;
  if (record2.isError === true || record2.success === false) {
    return typeof record2.error === "string" ? record2.error : "Tool execution failed";
  }
  if (typeof record2.exit_code === "number" && record2.exit_code !== 0) {
    return `Tool exited with code ${record2.exit_code}`;
  }
  if (typeof record2.status === "string" && /^(error|failed|failure)$/i.test(record2.status)) {
    return typeof record2.error === "string" ? record2.error : `Tool status: ${record2.status}`;
  }
  if (typeof record2.error === "string" && record2.error.trim()) return record2.error;
  return void 0;
}
function rootAndCompletionSpans(payload, config, turn, endMs, transcript, session = {}) {
  const rootId = rootSpanId(payload, turn.turnId);
  const turnStatus = transcript?.turnStatus ?? (payload.hook_event_name === "SessionEnd" ? "incomplete" : "ok");
  const turnError = errorText(transcript?.turnError);
  const root = {
    traceId: traceId(payload, turn.turnId),
    spanId: rootId,
    name: workflowName(turn),
    kind: 1,
    startTimeUnixNano: msToNanoString(Math.min(turn.startMs, endMs)),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: attributes([
      attrString("neatlogs.session.id", payload.session_id),
      attrString(
        "neatlogs.llm.model_name",
        transcript?.model ?? payload.model ?? turn.model
      ),
      attrString("neatlogs.span.kind", "WORKFLOW"),
      attrString("neatlogs.workflow_name", workflowName(turn)),
      attrString("neatlogs.llm.provider", transcript?.modelProvider ?? "openai"),
      attrString("neatlogs.llm.request_type", "generateText"),
      attrString("neatlogs.llm.effort_level", transcript?.effort),
      ...workflowMetadataAttributes(payload, turn, transcript, session, turnStatus),
      attrString("neatlogs.user_id", config.userId),
      attrString("neatlogs.input.value", turn.prompt),
      attrString(
        "neatlogs.output.value",
        payload.last_assistant_message ?? transcript?.lastAssistantMessage
      ),
      attrInt(
        "neatlogs.llm.metrics.duration_ms",
        transcript?.durationMs ?? Math.max(0, endMs - turn.startMs)
      ),
      attrString("error.message", turnError)
    ]),
    status: turnStatus === "error" ? { code: SpanStatusCode.ERROR, message: turnError } : { code: SpanStatusCode.OK }
  };
  const marker = {
    traceId: traceId(payload, turn.turnId),
    spanId: deterministicId(`codex:${payload.session_id}:${turn.turnId}:complete`, 8),
    parentSpanId: rootId,
    name: "neatlogs.trace.complete",
    kind: 1,
    startTimeUnixNano: msToNanoString(endMs),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: []
  };
  return [root, marker];
}
function displayToolName(name) {
  return name === "exec" ? "Bash" : name;
}
function llmPhaseInput(phase, index, turn, firstInput) {
  if (index === 0 && (firstInput ?? turn.prompt)) return firstInput ?? turn.prompt;
  if (phase.inputs.length === 1) {
    const input = phase.inputs[0];
    return typeof input === "string" ? truncate(input) : safeStringify(input) ?? "Continuation";
  }
  if (phase.inputs.length > 1) return safeStringify(phase.inputs) ?? "Continuation";
  return "Continuation of the current turn";
}
function llmPhaseOutput(phase) {
  if (phase.text) return phase.text;
  const toolCalls = phase.toolCalls.map(displayToolName);
  if (toolCalls.length > 0) return `Tool calls requested: ${toolCalls.join(", ")}`;
  if (phase.reasoningSummary) return phase.reasoningSummary;
  if (phase.hasReasoning) {
    return "Reasoning completed; raw encrypted reasoning is not exported.";
  }
  return "Model request completed without displayable text.";
}
function transcriptLLMSpans(payload, turn, transcript, options = {}) {
  return transcript.phases.map((phase, index) => {
    const model = transcript.model ?? payload.model ?? turn.model ?? "codex";
    const startMs = phase.startMs ?? turn.startMs;
    const endMs = phase.endMs ?? startMs;
    const toolCalls = phase.toolCalls.map(displayToolName).join(", ");
    return createChildSpan(
      payload,
      turn,
      `${options.identityPrefix ?? "llm"}:${index}:${phase.endMs ?? index}`,
      model,
      startMs,
      endMs,
      [
        attrString("neatlogs.span.kind", "LLM"),
        attrString("neatlogs.llm.request_type", "generateText"),
        attrString("neatlogs.llm.model_name", model),
        attrString("neatlogs.llm.provider", transcript.modelProvider ?? "openai"),
        attrString("neatlogs.llm.effort_level", transcript.effort),
        ...llmRuntimeAttributes(transcript, index),
        attrInt("neatlogs.llm.token_count.total", phase.usage.totalTokens),
        attrInt("neatlogs.llm.token_count.prompt", phase.usage.inputTokens),
        attrInt("neatlogs.llm.token_count.completion", phase.usage.outputTokens),
        attrInt("neatlogs.llm.token_count.reasoning", phase.usage.reasoningOutputTokens),
        ...phase.usage.cachedInputTokens > 0 ? [
          attrInt("neatlogs.llm.token_count.cache_read", phase.usage.cachedInputTokens),
          attrInt("neatlogs.llm.token_count.cached", phase.usage.cachedInputTokens)
        ] : [],
        ...phase.usage.cacheWriteInputTokens > 0 ? [attrInt("neatlogs.llm.token_count.cache_write", phase.usage.cacheWriteInputTokens)] : [],
        attrString(
          "neatlogs.input.value",
          llmPhaseInput(phase, index, turn, options.firstInput)
        ),
        attrString("neatlogs.output.value", llmPhaseOutput(phase)),
        attrString("neatlogs.llm.thinking", phase.reasoningSummary || void 0),
        attrString("neatlogs.llm.has_thinking", phase.hasReasoning ? "true" : void 0),
        attrString("neatlogs.llm.tool_calls", toolCalls || void 0),
        attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, endMs - startMs)),
        ...index === 0 && transcript.timeToFirstTokenMs !== void 0 ? [
          attrDouble(
            "neatlogs.llm.metrics.time_to_first_token",
            transcript.timeToFirstTokenMs
          )
        ] : []
      ],
      transcript.turnStatus === "error" ? { code: SpanStatusCode.ERROR, message: errorText(transcript.turnError) } : { code: SpanStatusCode.OK },
      options.parentSpanId
    );
  });
}
function transcriptToolSpans(payload, turn, transcript, parentSpanId) {
  return transcript.toolCalls.map((toolCall, index) => {
    const startMs = toolCall.startMs ?? turn.startMs;
    const endMs = toolCall.endMs ?? startMs;
    const error = toolResponseError(toolCall.output);
    const name = toolCall.name === "exec" ? "Bash" : toolCall.name;
    return createChildSpan(
      payload,
      turn,
      `agent-tool:${toolCall.callId || index}`,
      name,
      startMs,
      endMs,
      [
        attrString("neatlogs.span.kind", "TOOL"),
        attrString("neatlogs.tool.name", name),
        attrString("neatlogs.tool_call.id", toolCall.callId),
        attrString("neatlogs.tool.input", safeStringify(toolCall.input)),
        attrString("neatlogs.tool.output", safeStringify(toolCall.output)),
        attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, endMs - startMs)),
        attrString("error.message", error)
      ],
      error ? { code: SpanStatusCode.ERROR, message: error } : { code: SpanStatusCode.OK },
      parentSpanId
    );
  });
}
function sessionEndSpan(payload, turn, now) {
  return createChildSpan(
    payload,
    turn,
    `session-end:${payload.reason ?? "unknown"}`,
    "session_end",
    now,
    now,
    [
      attrString("neatlogs.span.kind", "LOG"),
      attrString("neatlogs.session.end_reason", payload.reason),
      attrString("neatlogs.output.value", payload.reason ?? "Session ended")
    ]
  );
}
function assertNever(value) {
  throw new Error(`Unhandled Codex hook event: ${String(value)}`);
}
function mapHookEvent(payload, config, state, now = Date.now()) {
  const eventName = payload.hook_event_name;
  switch (eventName) {
    case "SessionStart": {
      const existing = readSessionState(payload, state);
      state.write(payload.session_id, "session", {
        source: payload.source ?? existing.source,
        model: payload.model ?? existing.model,
        cwd: payload.cwd ?? existing.cwd,
        permissionMode: payload.permission_mode ?? existing.permissionMode
      });
      return { spans: [] };
    }
    case "UserPromptSubmit": {
      const turnId = resolveTurnId(payload, state);
      const session = readSessionState(payload, state);
      const turn = {
        turnId,
        prompt: payload.prompt,
        startMs: now,
        model: payload.model ?? session.model,
        cwd: payload.cwd ?? session.cwd,
        permissionMode: payload.permission_mode ?? session.permissionMode
      };
      state.write(payload.session_id, turnStateKey(turnId), turn);
      state.write(payload.session_id, "active-turn", { turnId });
      return { spans: [], workflowName: workflowName(turn) };
    }
    case "PreToolUse": {
      const turn = ensureTurnState(payload, state, now);
      if (payload.tool_use_id) {
        state.write(
          payload.session_id,
          toolStateKey(turn.turnId, payload.tool_use_id),
          { startMs: now }
        );
      }
      return { spans: [], workflowName: workflowName(turn) };
    }
    case "PostToolUse": {
      const turn = ensureTurnState(payload, state, now);
      const timing = payload.tool_use_id ? state.read(payload.session_id, toolStateKey(turn.turnId, payload.tool_use_id)) : void 0;
      if (payload.tool_use_id) {
        state.delete(payload.session_id, toolStateKey(turn.turnId, payload.tool_use_id));
      }
      const startMs = timing?.startMs ?? now;
      const error = toolResponseError(payload.tool_response);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload, { toolError: error });
      const identity = `tool:${payload.tool_use_id ?? `${payload.tool_name ?? "unknown"}:${now}`}`;
      const span = createChildSpan(
        payload,
        turn,
        identity,
        payload.tool_name ?? "tool",
        startMs,
        now,
        [
          attrString("neatlogs.span.kind", "TOOL"),
          attrString("neatlogs.tool.name", payload.tool_name),
          attrString("neatlogs.tool_call.id", payload.tool_use_id),
          attrString("neatlogs.tool.input", safeStringify(payload.tool_input)),
          attrString("neatlogs.tool.output", safeStringify(payload.tool_response)),
          attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, now - startMs)),
          attrString("error.message", error)
        ],
        error ? { code: SpanStatusCode.ERROR, message: error } : { code: SpanStatusCode.OK }
      );
      return { spans: [span], compatibilityEvents, workflowName: workflowName(turn) };
    }
    case "PermissionRequest": {
      const turn = ensureTurnState(payload, state, now);
      const span = createChildSpan(
        payload,
        turn,
        `permission:${payload.tool_name ?? "tool"}:${now}`,
        `${payload.tool_name ?? "tool"} permission request`,
        now,
        now,
        [
          attrString("neatlogs.span.kind", "TOOL"),
          attrString("neatlogs.tool.name", payload.tool_name),
          attrString("neatlogs.tool.input", safeStringify(payload.tool_input)),
          attrString("neatlogs.tool.output", "Permission requested")
        ]
      );
      return { spans: [span], workflowName: workflowName(turn) };
    }
    case "SubagentStart": {
      const turn = ensureActiveParentTurnState(payload, state, now);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload);
      if (payload.agent_id) {
        state.write(
          payload.session_id,
          agentStateKey(turn.turnId, payload.agent_id),
          { startMs: now }
        );
      }
      const taskCreated = createChildSpan(
        payload,
        turn,
        `task-created:${payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`}`,
        "TaskCreated",
        now,
        now,
        [
          attrString("neatlogs.span.kind", "WORKFLOW"),
          attrString("neatlogs.workflow_name", payload.agent_type ?? "subagent"),
          attrString("neatlogs.task_id", payload.agent_id),
          attrString("neatlogs.input.value", payload.agent_type ?? "subagent"),
          attrString("neatlogs.output.value", "Task created"),
          attrInt("neatlogs.llm.metrics.duration_ms", 0)
        ]
      );
      return {
        spans: [taskCreated],
        compatibilityEvents,
        workflowName: workflowName(turn)
      };
    }
    case "SubagentStop": {
      const turn = ensureActiveParentTurnState(payload, state, now);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload);
      const timing = payload.agent_id ? state.read(payload.session_id, agentStateKey(turn.turnId, payload.agent_id)) : void 0;
      if (payload.agent_id) {
        state.delete(payload.session_id, agentStateKey(turn.turnId, payload.agent_id));
      }
      const startMs = timing?.startMs ?? now;
      const transcript = payload.agent_transcript_path ? parseCodexTranscriptWithRetry(payload.agent_transcript_path) : void 0;
      const agentError = errorText(transcript?.turnError);
      const agentSpanId = deterministicId(
        `codex:${payload.session_id}:${turn.turnId}:agent:${payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`}`,
        8
      );
      const span = createChildSpan(
        payload,
        turn,
        `agent:${payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`}`,
        payload.agent_type ?? "subagent",
        startMs,
        now,
        [
          attrString("neatlogs.span.kind", "AGENT"),
          attrString("neatlogs.agent.name", payload.agent_type),
          attrString("neatlogs.agent_id", payload.agent_id),
          attrString("neatlogs.llm.model_name", transcript?.model),
          attrString("neatlogs.llm.provider", transcript?.modelProvider),
          attrString("neatlogs.llm.effort_level", transcript?.effort),
          attrString("neatlogs.workflow.effort_level", transcript?.effort),
          attrInt("neatlogs.workflow.model_context_window", transcript?.modelContextWindow),
          attrBool("neatlogs.workflow.stop_hook_active", payload.stop_hook_active),
          attrString(
            "neatlogs.output.value",
            payload.last_assistant_message ?? transcript?.lastAssistantMessage
          ),
          attrString("neatlogs.task_id", payload.agent_id),
          attrInt(
            "neatlogs.llm.metrics.duration_ms",
            transcript?.durationMs ?? Math.max(0, now - startMs)
          ),
          attrString("error.message", agentError)
        ],
        transcript?.turnStatus === "error" ? { code: SpanStatusCode.ERROR, message: agentError } : { code: SpanStatusCode.OK }
      );
      const llmSpans = transcript ? transcriptLLMSpans(payload, turn, transcript, {
        identityPrefix: `agent:${payload.agent_id ?? "subagent"}:llm`,
        parentSpanId: agentSpanId,
        firstInput: payload.agent_type ?? "Subagent task"
      }) : [];
      const toolSpans = transcript ? transcriptToolSpans(payload, turn, transcript, agentSpanId) : [];
      return {
        spans: [span, ...llmSpans, ...toolSpans],
        compatibilityEvents,
        workflowName: workflowName(turn)
      };
    }
    case "PreCompact":
    case "PostCompact": {
      const turn = ensureTurnState(payload, state, now);
      const phase = eventName === "PreCompact" ? "before" : "after";
      const span = createChildSpan(
        payload,
        turn,
        `compact:${phase}:${payload.trigger ?? "unknown"}:${now}`,
        `context_compaction_${phase}`,
        now,
        now,
        [
          attrString("neatlogs.span.kind", "CHAIN"),
          attrString("neatlogs.input.value", payload.trigger),
          attrString("neatlogs.output.value", phase)
        ]
      );
      return { spans: [span], workflowName: workflowName(turn) };
    }
    case "Stop": {
      const turn = ensureTurnState(payload, state, now);
      const session = readSessionState(payload, state);
      const spans = [];
      const transcript = payload.transcript_path ? parseCodexTranscriptWithRetry(payload.transcript_path, turn.turnId) : void 0;
      if (transcript && transcript.phases.length > 0) {
        spans.push(...transcriptLLMSpans(payload, turn, transcript));
      } else if (payload.last_assistant_message) {
        spans.push(
          createChildSpan(
            payload,
            turn,
            `llm:${bytesToHex(deterministicId(payload.last_assistant_message, 8))}`,
            payload.model ?? turn.model ?? "codex",
            now,
            now,
            [
              attrString("neatlogs.span.kind", "LLM"),
              attrString("neatlogs.llm.request_type", "generateText"),
              attrString("neatlogs.llm.model_name", payload.model ?? turn.model),
              attrString("neatlogs.llm.provider", "openai"),
              attrString("neatlogs.input.value", turn.prompt),
              attrString("neatlogs.output.value", payload.last_assistant_message)
            ],
            { code: SpanStatusCode.OK }
          )
        );
      }
      spans.push(...rootAndCompletionSpans(payload, config, turn, now, transcript, session));
      state.write(payload.session_id, turnStateKey(turn.turnId), { ...turn, completed: true });
      return { spans, workflowName: workflowName(turn) };
    }
    case "SessionEnd": {
      const active = activeTurn(state, payload.session_id);
      if (!active) return { spans: [], cleanupSession: true };
      const turn = state.read(payload.session_id, turnStateKey(active.turnId));
      if (!turn) return { spans: [], cleanupSession: true };
      if (turn.completed) {
        return {
          spans: [sessionEndSpan(payload, turn, now)],
          workflowName: workflowName(turn),
          cleanupSession: true
        };
      }
      const session = readSessionState(payload, state);
      const transcript = payload.transcript_path ? parseCodexTranscript(payload.transcript_path, turn.turnId) : void 0;
      return {
        spans: [
          ...transcript ? transcriptLLMSpans(payload, turn, transcript) : [],
          ...rootAndCompletionSpans(payload, config, turn, now, transcript, session),
          sessionEndSpan(payload, turn, now)
        ],
        workflowName: workflowName(turn),
        cleanupSession: true
      };
    }
    default:
      return assertNever(eventName);
  }
}

// src/spool.ts
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  openSync as openSync2,
  readFileSync as readFileSync3,
  readdirSync,
  renameSync as renameSync2,
  rmSync,
  statSync,
  writeFileSync as writeFileSync2
} from "fs";
import { randomUUID as randomUUID2 } from "crypto";
import { join as join3 } from "path";
function serializeSpan(span) {
  return {
    ...span,
    traceId: bytesToHex(span.traceId),
    spanId: bytesToHex(span.spanId),
    parentSpanId: span.parentSpanId ? bytesToHex(span.parentSpanId) : void 0
  };
}
function deserializeSpan(span) {
  return {
    ...span,
    traceId: hexToBytes(span.traceId),
    spanId: hexToBytes(span.spanId),
    parentSpanId: span.parentSpanId ? hexToBytes(span.parentSpanId) : void 0
  };
}
var SpanSpool = class {
  constructor(root) {
    this.root = root;
    this.pendingDirectory = join3(root, "spool", "pending");
    this.lockPath = join3(root, "spool", "drain.lock");
  }
  root;
  pendingDirectory;
  lockPath;
  enqueue(spans, workflowName2) {
    if (spans.length === 0) return void 0;
    mkdirSync3(this.pendingDirectory, { recursive: true, mode: 448 });
    const filename = `${Date.now()}-${process.pid}-${randomUUID2()}.json`;
    const destination = join3(this.pendingDirectory, filename);
    const temporary = `${destination}.tmp`;
    const batch = {
      version: 1,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      workflowName: workflowName2,
      spans: spans.map(serializeSpan)
    };
    writeFileSync2(temporary, JSON.stringify(batch), { encoding: "utf8", mode: 384 });
    renameSync2(temporary, destination);
    return destination;
  }
  pendingFiles() {
    if (!existsSync3(this.pendingDirectory)) return [];
    return readdirSync(this.pendingDirectory).filter((name) => name.endsWith(".json")).sort().map((name) => join3(this.pendingDirectory, name));
  }
  acquireLock() {
    mkdirSync3(join3(this.root, "spool"), { recursive: true, mode: 448 });
    try {
      return openSync2(this.lockPath, "wx", 384);
    } catch {
      try {
        if (Date.now() - statSync(this.lockPath).mtimeMs > 3e4) {
          rmSync(this.lockPath, { force: true });
          return openSync2(this.lockPath, "wx", 384);
        }
      } catch {
        return void 0;
      }
      return void 0;
    }
  }
  releaseLock(descriptor) {
    closeSync2(descriptor);
    rmSync(this.lockPath, { force: true });
  }
  async drain(exporter, maxBatches = 8) {
    const descriptor = this.acquireLock();
    if (descriptor === void 0) {
      return { sent: 0, dropped: 0, retained: this.pendingFiles().length, skipped: true };
    }
    let sent = 0;
    let dropped = 0;
    try {
      for (const path of this.pendingFiles().slice(0, maxBatches)) {
        let batch;
        try {
          batch = JSON.parse(readFileSync3(path, "utf8"));
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
};

// src/state-store.ts
import {
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  rmSync as rmSync2,
  writeFileSync as writeFileSync3
} from "fs";
import { createHash as createHash2, randomUUID as randomUUID3 } from "crypto";
import { homedir as homedir2 } from "os";
import { join as join4 } from "path";
function safeSegment(value) {
  const readable = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unknown";
  const hash = createHash2("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}
function getRuntimeRoot(env = process.env) {
  if (env.NEATLOGS_STATE_DIR) return env.NEATLOGS_STATE_DIR;
  if (env.PLUGIN_DATA) return join4(env.PLUGIN_DATA, "runtime");
  if (env.LOCALAPPDATA) return join4(env.LOCALAPPDATA, "neatlogs-codex");
  return join4(env.XDG_STATE_HOME ?? join4(homedir2(), ".local", "state"), "neatlogs-codex");
}
var StateStore = class {
  constructor(root = getRuntimeRoot()) {
    this.root = root;
  }
  root;
  sessionDirectory(sessionId) {
    return join4(this.root, "sessions", safeSegment(sessionId));
  }
  statePath(sessionId, key) {
    return join4(this.sessionDirectory(sessionId), `${safeSegment(key)}.json`);
  }
  write(sessionId, key, value) {
    const directory = this.sessionDirectory(sessionId);
    mkdirSync4(directory, { recursive: true, mode: 448 });
    const destination = this.statePath(sessionId, key);
    const temporary = join4(directory, `.state-${process.pid}-${randomUUID3()}.tmp`);
    writeFileSync3(temporary, JSON.stringify(value), { encoding: "utf8", mode: 384 });
    renameSync3(temporary, destination);
  }
  read(sessionId, key) {
    const path = this.statePath(sessionId, key);
    try {
      if (!existsSync4(path)) return void 0;
      return JSON.parse(readFileSync4(path, "utf8"));
    } catch {
      return void 0;
    }
  }
  delete(sessionId, key) {
    rmSync2(this.statePath(sessionId, key), { force: true });
  }
  cleanupSession(sessionId) {
    rmSync2(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }
};

// src/hook-handler.ts
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
async function handleHook(rawInput, dependencies = {}) {
  const state = dependencies.state ?? new StateStore();
  const config = dependencies.config ?? loadConfig();
  try {
    const raw = rawInput ?? await readStdin();
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (!isCodexHookPayload(parsed)) {
      if (config.debug) appendDebugLog(state.root, "Ignored invalid or unsupported hook payload");
      return;
    }
    const transcriptSession = parsed.transcript_path ? inspectCodexTranscriptSession(parsed.transcript_path) : void 0;
    if (transcriptSession?.isSubagent) {
      if (config.debug) {
        appendDebugLog(
          state.root,
          `Ignored subagent-owned ${parsed.hook_event_name}; parent SubagentStop owns its spans`
        );
      }
      return;
    }
    const now = dependencies.now?.() ?? Date.now();
    const result = mapHookEvent(parsed, config, state, now);
    const spool = dependencies.spool ?? new SpanSpool(state.root);
    if (config.apiKey && result.spans.length > 0) {
      spool.enqueue(result.spans, result.workflowName);
    }
    if (config.apiKey && (result.spans.length > 0 || parsed.hook_event_name === "SessionEnd")) {
      const exporter = dependencies.exporter ?? new TraceExporter({
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        timeoutMs: parsed.hook_event_name === "SessionEnd" ? 1800 : 2e3
      });
      await spool.drain(exporter, parsed.hook_event_name === "SessionEnd" ? 16 : 8);
    }
    if (result.cleanupSession) state.cleanupSession(parsed.session_id);
  } catch (error) {
    if (config.debug) {
      appendDebugLog(
        state.root,
        `Hook handler failure: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// src/setup.ts
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync5,
  renameSync as renameSync4,
  rmSync as rmSync3,
  writeFileSync as writeFileSync4
} from "fs";
import { randomUUID as randomUUID4 } from "crypto";
import { homedir as homedir3 } from "os";
import { dirname as dirname2, join as join5 } from "path";
var OWNED_COMMAND = /(?:^|[\\/\s"'])neatlogs-codex(?:\.cmd)?(?:\s|$|["'])/i;
function targetDirectory(scope, projectDirectory, home) {
  return scope === "global" ? join5(home, ".codex") : join5(projectDirectory, ".codex");
}
function targetPaths(scope, projectDirectory = process.cwd(), home = homedir3()) {
  const directory = targetDirectory(scope, projectDirectory, home);
  return {
    hooksPath: join5(directory, "hooks.json"),
    configPath: join5(directory, "config.toml")
  };
}
function containsInlineHooks(configPath) {
  if (!existsSync5(configPath)) return false;
  try {
    const eventNames = CODEX_HOOK_EVENTS.join("|");
    const inlineEvent = new RegExp(
      `^\\s*\\[\\[?hooks\\.(?:${eventNames})(?:\\.|\\]\\]?)`,
      "m"
    );
    return inlineEvent.test(readFileSync5(configPath, "utf8"));
  } catch {
    return false;
  }
}
function readHooksFile(path) {
  if (!existsSync5(path)) return {};
  const parsed = JSON.parse(readFileSync5(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return parsed;
}
function writeHooksFile(path, file) {
  const directory = dirname2(path);
  mkdirSync5(directory, { recursive: true, mode: 448 });
  const temporary = join5(directory, `.hooks-${process.pid}-${randomUUID4()}.tmp`);
  writeFileSync4(temporary, `${JSON.stringify(file, null, 2)}
`, {
    encoding: "utf8",
    mode: 384
  });
  renameSync4(temporary, path);
}
function eventHook(event, command) {
  const commandWindows = "neatlogs-codex.cmd hook";
  const synchronous = /* @__PURE__ */ new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "SubagentStart"
  ]);
  const timeout = event === "SessionEnd" ? 3 : synchronous.has(event) ? 5 : 30;
  return {
    hooks: [
      {
        type: "command",
        command,
        commandWindows,
        timeout,
        ...event !== "SessionEnd" && !synchronous.has(event) ? { async: true } : {}
      }
    ]
  };
}
function isOwnedGroup(group) {
  return Array.isArray(group.hooks) && group.hooks.some((hook) => OWNED_COMMAND.test(hook.command));
}
function registerHooks(scope, options = {}) {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const home = options.home ?? homedir3();
  const { hooksPath, configPath } = targetPaths(scope, projectDirectory, home);
  if (!existsSync5(hooksPath) && containsInlineHooks(configPath)) {
    throw new Error(
      `Inline [hooks] configuration already exists in ${configPath}. Move it to hooks.json or install Neatlogs as a Codex plugin to avoid mixed hook representations.`
    );
  }
  const file = readHooksFile(hooksPath);
  const hooks = file.hooks && typeof file.hooks === "object" ? file.hooks : {};
  const command = options.command ?? "neatlogs-codex hook";
  for (const event of CODEX_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing.filter((group) => !isOwnedGroup(group)), eventHook(event, command)];
  }
  file.description ??= "Codex lifecycle hooks, including Neatlogs observability.";
  file.hooks = hooks;
  writeHooksFile(hooksPath, file);
  return hooksPath;
}
function unregisterHooks(scope, options = {}) {
  const { hooksPath } = targetPaths(
    scope,
    options.projectDirectory ?? process.cwd(),
    options.home ?? homedir3()
  );
  if (!existsSync5(hooksPath)) return { hooksPath, removed: 0 };
  const file = readHooksFile(hooksPath);
  if (!file.hooks || typeof file.hooks !== "object") return { hooksPath, removed: 0 };
  let removed = 0;
  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!Array.isArray(groups)) continue;
    const retained = groups.filter((group) => !isOwnedGroup(group));
    removed += groups.length - retained.length;
    if (retained.length === 0) delete file.hooks[event];
    else file.hooks[event] = retained;
  }
  writeHooksFile(hooksPath, file);
  removeHooksFileIfEmpty(hooksPath);
  return { hooksPath, removed };
}
function inspectSetup(scope, options = {}) {
  const home = options.home ?? homedir3();
  const { hooksPath, configPath } = targetPaths(
    scope,
    options.projectDirectory ?? process.cwd(),
    home
  );
  const hooksFileExists = existsSync5(hooksPath);
  const file = hooksFileExists ? readHooksFile(hooksPath) : {};
  const registeredEvents = CODEX_HOOK_EVENTS.filter(
    (event) => (file.hooks?.[event] ?? []).some((group) => isOwnedGroup(group))
  );
  return {
    scope,
    hooksPath,
    hooksFileExists,
    registeredEvents,
    apiKeyConfigured: Boolean(loadConfig(options.env ?? process.env, getConfigPath(home)).apiKey),
    inlineHooksDetected: containsInlineHooks(configPath)
  };
}
function setupFromArgs(args) {
  const scope = args.includes("--global") ? "global" : "project";
  const keyIndex = args.indexOf("--api-key");
  const apiKey = keyIndex >= 0 ? args[keyIndex + 1] : void 0;
  if (keyIndex >= 0 && !apiKey) throw new Error("--api-key requires a value");
  if (apiKey) updateConfig({ api_key: apiKey });
  return { scope, hooksPath: registerHooks(scope) };
}
function removeHooksFileIfEmpty(path) {
  const file = readHooksFile(path);
  if (file.hooks && Object.keys(file.hooks).length > 0) return;
  const remaining = Object.keys(file).filter((key) => key !== "description" && key !== "hooks");
  if (remaining.length === 0) rmSync3(path, { force: true });
}

// src/cli.ts
function write(message) {
  process.stdout.write(message.endsWith("\n") ? message : `${message}
`);
}
function scopeFromArgs(args) {
  return args.includes("--global") ? "global" : "project";
}
function help() {
  write(`neatlogs-codex v${PACKAGE_VERSION}
`);
  write("Usage:");
  write("  neatlogs-codex setup [--global|--project] [--api-key KEY]");
  write("  neatlogs-codex uninstall [--global|--project]");
  write("  neatlogs-codex status [--global|--project]");
  write("  neatlogs-codex doctor [--global|--project]");
  write("  neatlogs-codex hook");
  write("  neatlogs-codex --version");
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "hook") {
    await handleHook();
    return;
  }
  try {
    switch (command) {
      case "setup": {
        const result = setupFromArgs(args);
        write(`[neatlogs/codex] Registered hooks in ${result.hooksPath}`);
        write("[neatlogs/codex] Open /hooks in Codex to review and trust the hook definitions.");
        break;
      }
      case "uninstall": {
        const scope = scopeFromArgs(args);
        const result = unregisterHooks(scope);
        write(`[neatlogs/codex] Removed ${result.removed} hook entries from ${result.hooksPath}`);
        break;
      }
      case "status": {
        const status = inspectSetup(scopeFromArgs(args));
        write(JSON.stringify(status, null, 2));
        break;
      }
      case "doctor": {
        const status = inspectSetup(scopeFromArgs(args));
        const issues = [];
        if (!status.apiKeyConfigured) issues.push("Neatlogs API key is not configured");
        if (status.registeredEvents.length === 0) issues.push("Neatlogs hooks are not registered");
        if (status.inlineHooksDetected && status.hooksFileExists) {
          issues.push("This Codex config layer mixes inline hooks and hooks.json");
        }
        if (issues.length === 0) write("[neatlogs/codex] Configuration looks healthy.");
        else {
          issues.forEach((issue) => write(`[neatlogs/codex] ${issue}`));
          process.exitCode = 1;
        }
        break;
      }
      case "--version":
      case "-v":
        write(PACKAGE_VERSION);
        break;
      default:
        help();
    }
  } catch (error) {
    process.stderr.write(
      `[neatlogs/codex] ${error instanceof Error ? error.message : String(error)}
`
    );
    process.exitCode = 1;
  }
}
void main();
