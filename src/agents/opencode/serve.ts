import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { executable } from "./config";

const FIRST_PORT = 4124;
const LAST_PORT = 4199;
const HEALTH_POLL_MS = 500;
const START_TIMEOUT_MS = 30_000;
const OPENCODE_REQUEST_TIMEOUT_MS = 240_000;

/** One persistent `opencode serve` child shared by every player in a match.
 *
 * A long-lived server removes the per-turn process boot: turns become one
 * HTTP message round-trip instead of a cold CLI start. The server binds
 * 127.0.0.1 with a generated password, so nothing leaves the machine.
 */
export class OpenCodeServe {
  private child?: ChildProcess;
  private base = "";
  private auth = "";
  version = "";

  static async launch(): Promise<OpenCodeServe> {
    const serve = new OpenCodeServe();
    await serve.start();
    return serve;
  }

  private async start(): Promise<void> {
    const launch = await executable();
    const username = "openfront";
    const password = randomBytes(24).toString("hex");
    const errors: string[] = [];
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
      const child = spawn(
        launch.command,
        [...launch.args, "serve", "--port", String(port)],
        {
          env: {
            ...process.env,
            OPENCODE_SERVER_USERNAME: username,
            OPENCODE_SERVER_PASSWORD: password,
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const base = `http://127.0.0.1:${port}`;
      const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      try {
        await this.waitForHealth(child, base, auth);
        this.child = child;
        this.base = base;
        this.auth = auth;
        child.stderr?.resume();
        return;
      } catch (error) {
        child.kill("SIGTERM");
        errors.push(
          `port ${port}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(`No free port for opencode serve (${errors.join("; ")})`);
  }

  private waitForHealth(
    child: ChildProcess,
    base: string,
    auth: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + START_TIMEOUT_MS;
      let done = false;
      child.once("error", (error) => {
        if (!done) {
          done = true;
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (!done) {
          done = true;
          reject(new Error(`opencode serve exited (${code}) during startup`));
        }
      });
      const poll = async () => {
        if (done) return;
        if (Date.now() >= deadline) {
          done = true;
          reject(new Error("opencode serve did not become healthy"));
          return;
        }
        try {
          const response = await fetch(`${base}/api/health`, {
            headers: { Authorization: auth },
            signal: AbortSignal.timeout(2_000),
          });
          if (response.ok) {
            const body = (await response.json()) as { version?: string };
            this.version = body.version ?? "";
            done = true;
            resolve();
            return;
          }
        } catch {
          // Not listening yet; keep polling until the deadline.
        }
        setTimeout(() => void poll(), HEALTH_POLL_MS);
      };
      void poll();
    });
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || !this.base)
      throw new Error("The OpenCode server is not running.");
    const timeout = AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenCode server ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    if (response.status === 204) return true;
    return response.json() as Promise<unknown>;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.base = "";
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(undefined);
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}
