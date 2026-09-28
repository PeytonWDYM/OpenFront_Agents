import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { message } from "./protocol";

type RequestId = string | number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

/** One JSON-RPC connection owns each request until its response or process exit. */
export class CodexTransport {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<RequestId, Pending>();
  private nextId = 0;
  private stopped = false;
  private exit: Promise<void>;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    codexHome: string,
    onMessage: (
      method: string,
      params: Record<string, unknown>,
      id?: RequestId,
    ) => Promise<void>,
    onFailure: (error: Error) => void,
  ) {
    const environment = { ...process.env };
    // Do not inherit the desktop host's tool pipes, thread identity, or permissions.
    for (const name of Object.keys(environment)) {
      if (name.startsWith("CODEX_")) delete environment[name];
    }
    environment.CODEX_HOME = codexHome;
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    this.process = spawn(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exit = new Promise((resolve) =>
      this.process.once("close", () => resolve()),
    );
    const fail = (error: Error) => {
      this.stopped = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      onFailure(error);
      this.process.kill();
    };
    this.process.once("error", fail);
    this.process.once("close", (code) =>
      fail(new Error(`Codex app-server exited (${code}).`)),
    );
    // Drain stderr. It can contain account details, so do not copy it into game logs.
    this.process.stderr.resume();
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      void (async () => {
        const envelope = message.parse(JSON.parse(line));
        if (envelope.method) {
          await onMessage(envelope.method, envelope.params ?? {}, envelope.id);
          return;
        }
        if (envelope.id === undefined)
          throw new Error("Codex response lacks an ID.");
        const pending = this.pending.get(envelope.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(envelope.id);
        if (envelope.error) pending.reject(new Error(envelope.error.message));
        else pending.resolve(envelope.result);
      })().catch(fail);
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopped)
      return Promise.reject(new Error("Codex app-server is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  notify(method: string) {
    this.send({ method });
  }

  respond(id: RequestId, result: Record<string, unknown>) {
    this.send({ id, result });
  }

  reject(id: RequestId, reason: string) {
    this.send({ id, error: { code: -32601, message: reason } });
  }

  private send(value: Record<string, unknown>) {
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async close() {
    this.process.stdin.end();
    const timeout = setTimeout(() => this.process.kill(), 2_000);
    await this.exit;
    clearTimeout(timeout);
  }
}
