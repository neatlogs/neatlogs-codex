// src/compatibility-probe.ts
import { readFileSync as readFileSync2, mkdtempSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "http";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

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
  "Stop",
  "Interrupt"
];
function isCodexHookPayload(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return typeof record.session_id === "string" && typeof record.hook_event_name === "string" && CODEX_HOOK_EVENTS.includes(record.hook_event_name);
}

// src/trace-shipper.ts
import { createHash, randomBytes } from "crypto";
import protobuf from "protobufjs";

// src/package-info.ts
import { readFileSync } from "fs";
function readPackageVersion() {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
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
function hasWorkflowSpanInTraceRequest(bytes) {
  const decoded = ExportTraceServiceRequest.toObject(ExportTraceServiceRequest.decode(bytes));
  return decoded.resourceSpans?.some((resource) => resource.scopeSpans?.some(
    (scope) => scope.spans?.some((span) => span.attributes?.some(
      (attribute) => attribute.key === "neatlogs.span.kind" && attribute.value?.stringValue === "WORKFLOW"
    ))
  )) ?? false;
}

// src/compatibility-probe.ts
async function probeHookLog(path, cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url))) {
  const root = mkdtempSync(join(tmpdir(), "neatlogs-codex-probe-"));
  const events = [];
  const errors = [];
  const replayInputs = [];
  try {
    const lines = readFileSync2(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(0, 40)) {
      try {
        const parsed = JSON.parse(line);
        if (!isCodexHookPayload(parsed)) {
          errors.push("Codex emitted an unsupported hook payload");
          continue;
        }
        if (parsed.hook_event_name === "UserPromptSubmit" && typeof parsed.prompt !== "string") {
          errors.push("UserPromptSubmit omitted its documented string prompt");
        }
        events.push(parsed.hook_event_name);
        const payload = { ...parsed, transcript_path: void 0, agent_transcript_path: void 0 };
        replayInputs.push(JSON.stringify(payload));
      } catch {
        errors.push("A captured hook payload could not be parsed");
      }
    }
    for (const required of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      if (!events.includes(required)) errors.push(`${required} hook did not fire`);
    }
    const stateRoot = join(root, "cli");
    const childHome = join(root, "cli-home");
    mkdirSync(stateRoot, { mode: 511 });
    mkdirSync(childHome, { mode: 511 });
    if (process.env.COMPAT_UNPRIVILEGED === "true") {
      chmodSync(root, 493);
      chmodSync(stateRoot, 511);
      chmodSync(childHome, 511);
    }
    const exported = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        exported.push(Buffer.concat(chunks));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local OTLP sink did not start");
      for (const input of replayInputs) {
        const exit = await new Promise((resolve) => {
          const variables = {
            PATH: process.env.PATH ?? "",
            HOME: childHome,
            NEATLOGS_STATE_DIR: stateRoot,
            NEATLOGS_API_KEY: "local-canary-key",
            NEATLOGS_ENDPOINT: `http://127.0.0.1:${address.port}`,
            NEATLOGS_USER_ID: "compatibility-canary"
          };
          const unprivileged = process.env.COMPAT_UNPRIVILEGED === "true";
          const child = spawn(
            unprivileged ? "sudo" : process.execPath,
            unprivileged ? ["-n", "-u", "nobody", "--", "env", "-i", ...Object.entries(variables).map(([key, value]) => `${key}=${value}`), process.execPath, cliPath, "hook"] : [cliPath, "hook"],
            {
              env: unprivileged ? { PATH: process.env.PATH } : variables,
              stdio: ["pipe", "ignore", "ignore"]
            }
          );
          child.on("error", () => resolve(-1));
          child.on("close", (code) => resolve(code ?? -1));
          child.stdin.end(input);
        });
        if (exit !== 0) errors.push("Packaged Neatlogs hook handler failed");
      }
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (!exported.some(hasWorkflowSpanInTraceRequest)) {
      errors.push("Packaged hook handler did not export a workflow span to the local OTLP sink");
    }
    return { ok: errors.length === 0, events: [...new Set(events)], errors };
  } finally {
    if (process.env.COMPAT_UNPRIVILEGED === "true") {
      if (!root.startsWith(join(tmpdir(), "neatlogs-codex-probe-"))) {
        throw new Error("Refusing to clean an unexpected probe directory");
      }
      const sessions = join(root, "cli", "sessions");
      const spool = join(root, "cli", "spool");
      const cleanup = spawnSync("sudo", ["-n", "-u", "nobody", "--", "rm", "-rf", "--", sessions, spool], { stdio: "ignore" });
      if (cleanup.status !== 0) throw new Error("Could not clean the isolated handler state");
    }
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith("compatibility-probe.js") || process.argv[1]?.endsWith("trusted-probe.mjs")) {
  probeHookLog(process.argv[2], process.argv[3]).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}
`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Compatibility probe failed: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
export {
  probeHookLog
};
