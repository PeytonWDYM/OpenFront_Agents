import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tracePath = process.argv[2];
const threads = new Map<string, { prompt: string; turns: number }>();
let nextThread = 0;
let nextTurn = 0;
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: unknown) => send({ method, params });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    id: string | number;
    method?: string;
    params: { threadId: string; baseInstructions: string; turnId: string };
  };
  appendFileSync(tracePath, `${line}\n`);
  const { id, method, params } = request;
  if (!method) return;
  if (method === "thread/start") {
    const threadId = `fixture-thread-${++nextThread}`;
    threads.set(threadId, { prompt: params.baseInstructions, turns: 0 });
    const respond = () => {
      if (
        params.baseInstructions.includes("startfailure") &&
        threadId === "fixture-thread-3"
      ) {
        send({
          id,
          error: { code: -32603, message: "Provider server overloaded" },
        });
        return;
      }
      send({
        id,
        result: {
          thread: { id: threadId },
          model: "gpt-6-luna",
          reasoningEffort: "low",
          instructionSources: [],
          approvalPolicy: "never",
          sandbox: { type: "readOnly" },
        },
      });
    };
    if (params.baseInstructions.includes("slowcontext") && nextThread > 2)
      setTimeout(respond, 200);
    else respond();
  } else if (method === "turn/start") {
    const { threadId } = params;
    const thread = threads.get(threadId)!;
    const turnId = `fixture-turn-${++nextTurn}`;
    thread.turns++;
    if (thread.prompt.includes("exit")) {
      process.exit(2);
    }
    const turn = { id: turnId, status: "inProgress", error: null };
    send({ id, result: { turn } });
    notify("turn/started", { threadId, turn });
    const tokenCount = thread.turns * 100;
    notify("thread/tokenUsage/updated", {
      threadId,
      tokenUsage: {
        total: {
          totalTokens: tokenCount,
          inputTokens: tokenCount - 20,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258400,
      },
    });
    let error: (Record<string, unknown> & { message: string }) | null = null;
    if (thread.prompt.includes("unsafe"))
      error = {
        message:
          "Invalid prompt: your prompt was flagged as potentially violating our usage policy",
        codexErrorInfo: "other",
        willRetry: false,
      };
    if (thread.prompt.includes("quota"))
      error = {
        message: "Usage limit exceeded",
        codexErrorInfo: "usageLimitExceeded",
      };
    if (thread.prompt.includes("unknown"))
      error = { message: "Invalid input fixture", codexErrorInfo: "other" };
    if (thread.prompt.includes("misalignment"))
      error = {
        message: "Response stream error",
        codexErrorInfo: "responseStreamError",
        misalignment: { type: "policy_violation" },
      };
    if (thread.prompt.includes("structuredpolicy"))
      error = {
        message: "Response unavailable",
        codexErrorInfo: { misalignment_policy_violation: {} },
      };
    if (thread.prompt.includes("codedquota"))
      error = {
        message: thread.turns === 1 ? "Account unavailable" : "",
        codexErrorInfo: "usageLimitExceeded",
      };
    if (thread.prompt.includes("codedauth"))
      error = {
        message: "Account unavailable",
        codexErrorInfo: "unauthorized",
      };
    if (thread.prompt.includes("http400"))
      error = {
        message: "Response unavailable",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } },
      };
    if (thread.prompt.includes("http401"))
      error = {
        message: "Response unavailable",
        codexErrorInfo: {
          responseStreamConnectionFailed: { httpStatusCode: 401 },
        },
      };
    if (thread.prompt.includes("http429"))
      error = {
        message: "Response unavailable",
        codexErrorInfo: {
          responseTooManyFailedAttempts: { httpStatusCode: 429 },
        },
      };
    if (
      (thread.prompt.includes("transient") && thread.turns === 1) ||
      thread.prompt.includes("repeated")
    )
      error = {
        message: "Provider server overloaded",
        codexErrorInfo: "serverOverloaded",
        willRetry: false,
      };
    if (thread.prompt.includes("context") && threadId === "fixture-thread-1")
      error = {
        message: "Context window exceeded",
        codexErrorInfo: "contextWindowExceeded",
      };
    if (thread.prompt.includes("context") && threadId !== "fixture-thread-1") {
      send({
        id: "stale-tool",
        method: "item/tool/call",
        params: {
          threadId: "fixture-thread-1",
          turnId: "fixture-turn-1",
          tool: "think",
          arguments: { note: "STALE OLD THREAD" },
        },
      });
      notify("thread/tokenUsage/updated", {
        threadId: "fixture-thread-1",
        tokenUsage: {
          total: {
            totalTokens: 9000,
            inputTokens: 8980,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258400,
        },
      });
      notify("item/completed", {
        threadId: "fixture-thread-1",
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: "STALE SUMMARY",
        },
      });
    }
    if (error) notify("error", { threadId, error, willRetry: false });
    notify("turn/completed", {
      threadId,
      turn: {
        ...turn,
        status: error ? "failed" : "completed",
        error: error ? { message: error.message } : null,
      },
    });
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", error: null },
    });
  } else {
    send({
      id,
      error: { code: -32601, message: `Unsupported fixture method ${method}` },
    });
  }
});
