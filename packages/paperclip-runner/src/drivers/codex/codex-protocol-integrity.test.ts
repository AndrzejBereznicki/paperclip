import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import { createCodexTaskEnvelope } from "../../contracts/codex.js";
import type { ControlPlanePort } from "../../contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../../contracts/native-execution.js";
import { NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  type DurableRecoveryIdentity,
} from "../../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "../../live/runnerd-codex-transport.js";
import { executeNativeSession } from "../../native-session-runtime.js";
import { CodexAppServerDriver } from "./codex-app-server-driver.js";
import { CodexSessionState } from "./codex-session-state.js";
import {
  FakeCodexTransport,
  TestQueue,
  WORKSPACE,
  describe,
  expect,
  it,
  makeDriver,
  result,
  vi,
  type PrpEvent,
} from "./codex-app-server-driver.test-support.js";

// Synthetic runner process boundary; authentication and the encrypted wire are
// real. Keep this client local to this test rather than exporting test protocol
// machinery from the production controller.
async function authenticatedRunner(
  core: DurablePrpControlPlane,
  identity: DurableRecoveryIdentity,
) {
  const framed = (domain: string, parts: Buffer[]) => {
    const values = [Buffer.from(domain), Buffer.from([0])];
    for (const part of parts) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(part.length));
      values.push(length, part);
    }
    return Buffer.concat(values);
  };
  const digest = (domain: string, parts: Buffer[]) =>
    createHash("sha256").update(framed(domain, parts)).digest();
  const credential = Buffer.from(core.issueBootstrapTicket());
  const authKey = digest("paperclip-runner-auth-key-v1", [credential]);
  const mac = (domain: string, parts: Buffer[]) =>
    createHmac("sha256", authKey).update(framed(domain, parts)).digest();
  const credentialId = `sha256:${digest("paperclip-runner-credential-id-v1", [credential]).toString("hex")}`;
  const socket = new WebSocket(core.connectUrl);
  const frames = new TestQueue<Record<string, unknown>>();
  const reader = frames[Symbol.asyncIterator]();
  socket.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data))),
  );
  socket.addEventListener("close", () => frames.close());
  socket.addEventListener("error", () =>
    frames.fail(new Error("Synthetic runner socket failed")),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      protocol: "paperclip.runner",
      version: 1,
      kind: "auth_hello",
      payload: {
        credentialId,
        clientNonce: "composed-integrity-client",
        protocolMin: 1,
        protocolMax: 1,
        ...identity,
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
      },
    }),
  );
  const challenge = (await reader.next()).value!.payload as Record<
    string,
    unknown
  >;
  const { serverProof, ...challengeFields } = challenge;
  const canonical = Buffer.from(
    durableRecoveryInternals.canonicalJson(challengeFields),
  );
  expect(serverProof).toBe(
    mac("paperclip-runner-server-proof-v1", [canonical]).toString("hex"),
  );
  const clientProof = mac("paperclip-runner-client-proof-v1", [
    canonical,
    Buffer.from(String(serverProof)),
  ]).toString("hex");
  socket.send(
    JSON.stringify({
      protocol: "paperclip.runner",
      version: 1,
      kind: "auth_response",
      payload: {
        credentialId,
        clientNonce: challenge.clientNonce,
        serverNonce: challenge.serverNonce,
        clientProof,
      },
    }),
  );
  const binding = digest("paperclip-runner-session-binding-v1", [
    canonical,
    Buffer.from(String(serverProof)),
    Buffer.from(clientProof),
  ]);
  const sessionId = `sha256:${binding.toString("hex")}`;
  const nonce = (prefix: string, counter: number) => {
    const value = Buffer.alloc(12);
    value.write(prefix, 0, "ascii");
    value.writeBigUInt64BE(BigInt(counter), 4);
    return value;
  };
  const aad = (direction: string, counter: number) =>
    Buffer.from(
      `paperclip.runner.secure-frame.v1\0${sessionId}\0${direction}\0${counter}`,
    );
  const welcome = (await reader.next()).value!;
  expect(welcome.counter).toBe(0);
  const sealed = Buffer.from(String(welcome.ciphertext), "hex");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    mac("paperclip-runner-core-to-client-key-v1", [binding]),
    nonce("P3S1", 0),
  );
  decipher.setAAD(aad("core_to_client", 0));
  decipher.setAuthTag(sealed.subarray(-16));
  const opened = JSON.parse(
    Buffer.concat([
      decipher.update(sealed.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
  expect(opened.kind).toBe("welcome");
  let counter = 0;
  return {
    socket,
    send(value: Record<string, unknown>) {
      const cipher = createCipheriv(
        "aes-256-gcm",
        mac("paperclip-runner-client-to-core-key-v1", [binding]),
        nonce("P3C1", counter),
      );
      cipher.setAAD(aad("client_to_core", counter));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      socket.send(
        JSON.stringify({
          schema: "paperclip.runner.secure-frame.v1",
          counter: counter++,
          ciphertext: ciphertext.toString("hex"),
        }),
      );
    },
  };
}

describe("Codex protocol integrity propagation", () => {
  it("rejects an authenticated controller fault through the real driver, backend, and admitted runtime without accepting a result", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "paperclip-composed-integrity-"),
    );
    const identity: DurableRecoveryIdentity = {
      runnerInstanceId: "composed-runner",
      environmentLeaseId: "composed-lease",
      runId: "composed-run",
      normalizedSessionId: "composed-session",
      turnId: "composed-turn",
      itemId: "composed-item",
    };
    const contract = {
      revision: "1",
      objective: "Validate the authenticated failure boundary",
      criteria: [
        {
          id: "objective",
          requirement: "Do not accept corrupt provider input",
        },
      ],
    };
    const input: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: {
        companyId: "composed-company",
        issueId: "composed-issue",
        agentId: "composed-agent",
        runId: identity.runId,
        executionWorkspaceId: "composed-workspace",
      },
      task: {
        identifier: "TEST-1",
        title: contract.objective,
        description: null,
        prompt: contract.objective,
        workMode: "standard",
      },
      workspace: {
        cwd: directory,
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: identity.normalizedSessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
      },
      provider: { kind: "codex", model: null },
      completionContract: {
        id: "composed-contract",
        sha256: "composed-contract-sha",
        schemaVersion: "paperclip.completion-contract.v1",
        contract,
      },
      interactionResponses: [],
      credentialBindings: [],
    };
    const events: PrpEvent[] = [];
    const controlPlane: ControlPlanePort = {
      openRun: vi.fn(async () => undefined),
      checkpointSession: vi.fn(async () => undefined),
      appendEvent: vi.fn(async (event) => {
        events.push(event as PrpEvent);
        return {
          cursor: events.length,
          highestContiguousSourceSeq: events.length,
          disposition: "committed" as const,
        };
      }),
      replayEvents: vi.fn(async () => ({
        events: [],
        highestContiguousSourceSeq: 0,
      })),
      completeRun: vi.fn(async () => undefined),
    };
    let authority: DurablePrpControlPlane | undefined;
    let finishProcess!: (result: {
      code: number;
      signal: null;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      code: number;
      signal: null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      finishProcess = resolve;
    });
    const kill = vi.fn(() => {
      finishProcess({ code: 0, signal: null, stdout: "", stderr: "" });
      return true;
    });
    const launch = vi.fn(() => ({
      child: { exitCode: null, kill },
      completion,
    }));
    const bundle = createCapabilityRunnerdCodexTransport({
      stateDirectory: directory,
      prpIdentity: identity,
      runnerBinary: process.execPath,
      codexCommand: process.execPath,
      codexArgs: [],
      sourceCodexHome: null,
      environment: {},
      runnerReconnectGraceMs: 900_000,
      closeGraceMs: 50,
      runnerProcessLauncher: launch,
      controlPlaneRegistration: async (core) => {
        authority = core;
        await core.start();
        return { connectUrl: core.connectUrl, release: () => core.stop() };
      },
    });
    const driver = new CodexAppServerDriver({
      taskEnvelope: createCodexTaskEnvelope({ objective: contract.objective }),
      environment: { PAPERCLIP_WORKSPACE_CWD: directory },
      approvalPolicy: "never",
      transportFactory: () => bundle.transport,
    });
    const backend = new HarnessDriverBackend(driver);
    const admitted = vi.fn();
    const execution = executeNativeSession({
      input,
      backend,
      controlPlane,
      runnerInstanceId: identity.runnerInstanceId,
      controlPlaneInstanceId: "composed-core",
      timeoutMs: 900_000,
      requireSessionCloseBeforeReturn: true,
      onSession: admitted,
    }).catch((error: unknown) => error);
    let client: Awaited<ReturnType<typeof authenticatedRunner>> | undefined;
    try {
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      const core = authority!;
      client = await authenticatedRunner(core, identity);
      const commandResult = async (
        type: string,
        result: Record<string, unknown> = {},
      ) => {
        await vi.waitFor(() =>
          expect(
            core.store.state.commands.some((command) => command.type === type),
          ).toBe(true),
        );
        const command = core.store.state.commands.find(
          (candidate) => candidate.type === type,
        )!;
        client!.send({
          protocol: "paperclip.runner",
          version: 1,
          kind: "command_result",
          payload: {
            commandId: command.commandId,
            commandType: command.type,
            controllerSeq: command.controllerSeq,
            status: "completed",
            result,
          },
        });
        await vi.waitFor(() => expect(command.status).toBe("completed"));
      };
      const event = (
        sourceSeq: number,
        eventType: PrpEvent["eventType"],
        payload: Record<string, unknown>,
      ) => ({
        protocol: "paperclip.runner",
        version: 1,
        kind: "event",
        ...identity,
        payload: {
          schema: "paperclip.prp.event.v1",
          schemaVersion: 1,
          sourceEventId: `composed-event-${sourceSeq}`,
          sourceSeq,
          sourceInstanceId: identity.runnerInstanceId,
          sourceKind: "runner",
          runId: identity.runId,
          normalizedSessionId: identity.normalizedSessionId,
          turnId: identity.turnId,
          itemId: identity.itemId,
          eventType,
          priority: 0,
          emittedAt: "2026-09-08T00:00:00.000Z",
          payload,
        },
      });
      await commandResult("run.prepare");
      await commandResult("session.open");
      client.send(
        event(1, "session.started", {
          threadId: "composed-provider-thread",
          sessionId: "composed-provider-session",
          runtimeIdentity: { processId: process.pid },
        }),
      );
      await commandResult("session.goal.get", { goal: null });
      await commandResult("turn.start", {
        providerTurnId: "composed-provider-turn",
      });
      client.send(
        event(2, "turn.started", {
          providerTurnId: "composed-provider-turn",
          status: "inProgress",
        }),
      );
      await vi.waitFor(() =>
        expect(events.some((entry) => entry.eventType === "turn.started")).toBe(
          true,
        ),
      );
      expect(controlPlane.openRun).toHaveBeenCalledTimes(1);
      expect(admitted).toHaveBeenCalledWith(expect.anything());
      // Capture the actual transport fault, not a newly constructed lookalike.
      // A pending read also proves that request and notification consumers see
      // the very same object before the runtime closes its transport.
      const transportFailure = bundle.transport
        .request("thread/read", { threadId: "composed-provider-thread" })
        .catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(
          core.store.state.commands.some(
            (command) => command.type === "session.snapshot",
          ),
        ).toBe(true),
      );
      const faultAt = Date.now();
      client.send(
        event(3, "semantic_tool.input", {
          semantic_tool: {
            schema: "paperclip.prp.semantic_tool.v1",
            schemaVersion: 1,
            phase: "input",
            callId: "composed-call",
            operationId: "get_task_context",
            correlation: {
              runId: identity.runId,
              normalizedSessionId: identity.normalizedSessionId,
              turnId: identity.turnId,
              itemId: identity.itemId,
            },
            idempotencyKey: null,
            content: {
              digest: `sha256:${"0".repeat(64)}`,
              redactionDisposition: "digest_only",
              references: [],
            },
            input: { summary: "DO-NOT-LEAK-composed-test" },
          },
        }),
      );
      const primary = await transportFailure;
      expect(primary).toBeInstanceOf(NativeSessionProtocolIntegrityError);
      expect(primary).toMatchObject({
        code: "native_event_replay_conflict",
        reason: "semantic_input_digest_mismatch",
        recovery: "operator_required",
      });
      expect(await execution).toBe(primary);
      expect(Date.now() - faultAt).toBeLessThan(5_000);
      expect(core.store.state.ackedSourceSeq).toBe(2);
      expect(
        core.store.state.committedEvents.map((entry) => entry.eventType),
      ).toEqual(["session.started", "turn.started"]);
      expect(controlPlane.completeRun).not.toHaveBeenCalled();
      expect(
        events.some((entry) => entry.eventType === "run.result.proposed"),
      ).toBe(false);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalled();
      expect(bundle.evidence().diagnostics.join("\n")).not.toContain(
        "DO-NOT-LEAK",
      );
    } finally {
      client?.socket.close();
      kill();
      await bundle.detachControllerForRestart();
      await authority?.stop();
      await execution;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it.each(["pre-start", "pending-input", "buffered-terminal"] as const)(
    "preserves the exact integrity fault through the composed backend at %s",
    async (stage) => {
      const transport = new FakeCodexTransport();
      const driver = makeDriver([transport]);
      const harness = await driver.openSession({
        runId: "run-integrity",
        normalizedSessionId: "session-integrity",
        workingDirectory: WORKSPACE,
      });
      if (!(harness instanceof CodexSessionState))
        throw new Error("Expected Codex state");
      const backend = new HarnessDriverBackend({
        descriptor: () => driver.descriptor(),
        openSession: async () => harness,
      });
      const session = await backend.openSession({
        identity: {
          runId: "run-integrity",
          sessionId: "session-integrity",
          companyId: "company",
          issueId: "issue",
          agentId: "agent",
        },
        workingDirectory: WORKSPACE,
      });
      const fault = new NativeSessionProtocolIntegrityError(
        "semantic_input_digest_mismatch",
      );
      const events: PrpEvent[] = [];
      let pending: Promise<Record<string, unknown>> | undefined;
      let consumed: Promise<unknown> | undefined;
      const consume = async () => {
        try {
          for await (const event of session.events()) events.push(event);
          return null;
        } catch (error) {
          return error;
        }
      };
      try {
        if (stage !== "pre-start") {
          const { turnId } = await session.startTurn({
            message: { role: "user", text: "Work safely." },
          });
          if (stage === "pending-input") {
            consumed = consume();
            pending = transport.invoke({
              id: "input-integrity",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-1",
                turnId,
                itemId: "input-integrity-item",
                questions: [
                  {
                    id: "color",
                    header: "Color",
                    question: "Which color?",
                    options: [{ label: "Amber" }, { label: "Cobalt" }],
                  },
                ],
              },
            });
            await vi.waitFor(() =>
              expect(
                events.some(
                  (event) => event.eventType === "runtime_request.created",
                ),
              ).toBe(true),
            );
          } else {
            transport.queue.push({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: turnId,
                  status: "completed",
                  items: [
                    {
                      id: "final",
                      type: "agentMessage",
                      text: JSON.stringify(result),
                    },
                  ],
                },
              },
            });
            await vi.waitFor(() => expect(harness.terminal).toBe(true));
            expect(harness.result).not.toBeNull();
          }
        }
        transport.queue.fail(fault);
        await vi.waitFor(() => expect(harness.protocolFailed).toBe(true));
        consumed ??= consume();
        expect(await consumed).toBe(fault);
        expect(
          events.filter((event) =>
            [
              "turn.completed",
              "turn.failed",
              "turn.interrupted",
              "run.result.proposed",
              "runtime_request.expired",
            ].includes(event.eventType),
          ),
        ).toEqual([]);
        if (pending) expect(await pending).toEqual({ answers: {} });
        await expect(session.result()).rejects.toBe(fault);
        await expect(session.snapshot()).rejects.toBe(fault);
        await expect(
          session.startTurn({
            message: { role: "user", text: "Do not retry." },
          }),
        ).rejects.toBe(fault);
        await expect(
          session.attachRun!({
            identity: { ...session.identity(), runId: "replacement-run" },
          }),
        ).rejects.toBe(fault);
        expect(
          transport.calls.filter((call) => call.method === "turn/start"),
        ).toHaveLength(stage === "pre-start" ? 0 : 1);
      } finally {
        await session.close({ reason: "test cleanup" });
        await consumed;
        await pending;
      }
    },
  );

  it("preserves a protocol failure received before turn start as a typed terminal", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "prestart", normalizedSessionId: "prestart-session", workingDirectory: WORKSPACE });
    transport.queue.push({ method: "turn/completed", params: { threadId: "unrelated", turn: { id: "wrong", status: "completed" } } });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    await expect(session.startTurn({ message: { role: "user", text: "Work" } })).rejects.toMatchObject({ code: "native_provider_terminal_failed", providerCode: "thread_binding_mismatch", recoverable: false });
    await session.close({ reason: "test complete" });
  });

  it("does not promote a message-and-field lookalike transport error", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-generic",
      normalizedSessionId: "session-generic",
      workingDirectory: WORKSPACE,
    });
    const fault = Object.assign(new Error("native_event_replay_conflict"), {
      code: "native_event_replay_conflict",
      reason: "semantic_input_digest_mismatch",
    });
    const events: PrpEvent[] = [];
    const consumed = (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    try {
      await session.startTurn({ message: { role: "user", text: "Work." } });
      transport.queue.fail(fault);
      await consumed;
      expect(
        events.find((event) => event.eventType === "session.failed")?.payload
          .code,
      ).toBe("notification_transport_failed");
      expect(events.some((event) => event.eventType === "turn.failed")).toBe(
        true,
      );
      await expect(session.snapshot()).resolves.toBeDefined();
    } finally {
      await session.close({ reason: "test cleanup" });
      await consumed;
    }
  });
});
