import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ZbContext } from "../../../zbin";
import { ClientMessage, ServerMessage } from "../../core/Schemas";
import {
  createGameWireContext,
  decodeServerMessage,
  encodeClientMessage,
} from "../../core/ZbinWire";

/** One normal game connection. The dev server validates this seat's local token. */
export class PlayerSocket {
  private socket: WebSocket;
  private context: ZbContext | undefined;
  clientId = "";
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    readonly id: string,
    readonly name: string,
    workerId: number,
  ) {
    this.socket = new WebSocket(`ws://localhost:${3001 + workerId}/`);
  }

  async join(
    gameId: string,
    receive: (message: ServerMessage) => void,
    fail: (error: Error) => void,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        const error = new Error(`Join timed out for ${this.id}`);
        reject(error);
        fail(error);
        this.close();
      }, 15_000);
      this.socket.on("error", (error) => {
        clearInterval(this.heartbeat);
        clearTimeout(deadline);
        reject(error);
        fail(error);
        this.socket.close();
      });
      this.socket.on("close", (code, reason) => {
        clearInterval(this.heartbeat);
        clearTimeout(deadline);
        const error = new Error(
          `Agent ${this.id} disconnected (${code}): ${reason}`,
        );
        reject(error);
        fail(error);
      });
      this.socket.on("message", (data: Buffer) => {
        try {
          const message = decodeServerMessage(data, this.context);
          if (message.type === "start") {
            this.context = createGameWireContext(message.gameStartInfo.players);
          }
          if (message.type === "lobby_info" || message.type === "start") {
            this.clientId = message.myClientID!;
            clearTimeout(deadline);
            resolve();
          }
          if (message.type === "error") throw new Error(message.error);
          receive(message);
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          clearTimeout(deadline);
          reject(failure);
          fail(failure);
          this.close();
        }
      });
      this.socket.on("open", () => {
        this.send({
          type: "join",
          gameID: gameId,
          token: randomUUID(),
          username: this.name,
          clanTag: null,
          turnstileToken: null,
          gitCommit: "DEV",
          platform: "web",
        });
        this.heartbeat = setInterval(
          () =>
            this.send({ type: "ping", sentAt: Math.floor(performance.now()) }),
          5_000,
        );
      });
    });
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error(`Agent ${this.id} is disconnected`);
    this.socket.send(encodeClientMessage(message, this.context));
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}
