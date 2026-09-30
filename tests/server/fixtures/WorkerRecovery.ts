import assert from "node:assert/strict";
import cluster, { Worker } from "node:cluster";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import winston from "winston";
import { z } from "zod";
import { forkWorker } from "../../../src/server/ForkWorker";
import {
  InternalGameInfo,
  MasterMessageSchema,
} from "../../../src/server/IPCBridgeSchema";
import { MapPlaylist } from "../../../src/server/MapPlaylist";
import { MasterLobbyService } from "../../../src/server/MasterLobbyService";

const instanceId = "worker-recovery-e2e";
const ReadySchema = z.object({
  type: z.literal("workerReady"),
  workerId: z.number(),
  port: z.number(),
});
const ResponseSchema = z.object({
  pid: z.number(),
  workerId: z.number(),
  instanceId: z.string(),
  broadcasts: z.number(),
  lobbies: z.array(z.string()),
});

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await delay(25);
  }
}

async function runPrimary() {
  cluster.setupPrimary({ exec: fileURLToPath(import.meta.url) });
  const log = winston.createLogger({
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  });
  const service = new MasterLobbyService(new MapPlaylist(), log, true);
  const workers = new Map<number, Worker>();
  const ports = new Map<number, number>();
  const events: {
    type: string;
    workerId: number;
    pid?: number;
    liveGames?: number;
  }[] = [];
  const registry = {
    registerWorker(workerId: number, worker: Worker) {
      workers.set(workerId, worker);
      service.registerWorker(workerId, worker);
      events.push({ type: "register", workerId, pid: worker.process.pid });
      worker.on("message", (raw: unknown) => {
        const ready = ReadySchema.safeParse(raw);
        if (ready.success) ports.set(workerId, ready.data.port);
      });
    },
    removeWorker(workerId: number) {
      workers.delete(workerId);
      ports.delete(workerId);
      service.removeWorker(workerId);
      events.push({ type: "remove", workerId, liveGames: service.liveGames() });
    },
  };
  async function readWorker(workerId: number) {
    const response = await fetch(`http://127.0.0.1:${ports.get(workerId)}`);
    return ResponseSchema.parse(await response.json());
  }
  try {
    forkWorker(0, instanceId, registry, log);
    forkWorker(1, instanceId, registry, log);
    await until(
      () => ports.size === 2 && service.liveGames() === 8,
      "initial workers ready",
    );
    const survivor = workers.get(1)!;
    const survivorPid = survivor.process.pid;
    const processWithoutEnv = workers.get(0)!.process;
    assert.equal("env" in processWithoutEnv, false);
    assert.equal(service.isHealthy(), true);
    const pids: number[] = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const dead = workers.get(0)!;
      const deadPid = dead.process.pid!;
      await until(
        async () => (await readWorker(1)).lobbies.includes(`dead-${deadPid}`),
        "worker lobby broadcast before exit",
      );
      const before = await readWorker(1);
      dead.send({ fixtureExit: 17 + cycle });
      await until(
        () => workers.get(0) !== dead,
        `replacement ${cycle + 1} forked`,
      );
      assert.equal(
        service.liveGames(),
        5,
        "dead worker game count cleared before replacement ready",
      );
      assert.equal(workers.get(1), survivor, "other worker unchanged");
      await until(
        async () => !(await readWorker(1)).lobbies.includes(`dead-${deadPid}`),
        "dead lobby removed from broadcasts",
      );
      await until(
        () => ports.has(0) && service.liveGames() === 8,
        "replacement ready",
      );
      const replacement = await readWorker(0);
      assert.equal(replacement.workerId, 0);
      assert.equal(replacement.instanceId, instanceId);
      assert.notEqual(replacement.pid, deadPid);
      pids.push(replacement.pid);
      await until(async () => {
        const state = await readWorker(1);
        return (
          state.broadcasts > before.broadcasts &&
          state.lobbies.includes(`dead-${replacement.pid}`)
        );
      }, "broadcasts resumed with replacement lobby");
      assert.equal((await readWorker(1)).pid, survivorPid);
      assert.equal(service.isHealthy(), true);
    }
    assert.equal(new Set(pids).size, 3);
    assert.equal(events.filter((event) => event.type === "remove").length, 3);
    console.log(
      JSON.stringify({ cycles: 3, survivorPid, replacementPids: pids, events }),
    );
  } finally {
    // These workers belong to this fixture. Remove recovery listeners before teardown.
    const exits = Object.values(cluster.workers!).map((worker) => {
      if (worker === undefined) return Promise.resolve();
      worker.removeAllListeners("exit");
      return new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
        worker.kill();
      });
    });
    await Promise.all(exits);
  }
}

async function runWorker() {
  const workerId = Number(process.env.WORKER_ID);
  let broadcasts = 0;
  let lobbies: string[] = [];
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        pid: process.pid,
        workerId,
        instanceId: process.env.INSTANCE_ID,
        broadcasts,
        lobbies,
      }),
    );
  });
  process.on("message", (raw: unknown) => {
    const exit = z.object({ fixtureExit: z.number() }).safeParse(raw);
    if (exit.success) process.exit(exit.data.fixtureExit);
    const message = MasterMessageSchema.parse(raw);
    if (message.type === "lobbiesBroadcast") {
      broadcasts++;
      lobbies = Object.values(message.publicGames.games)
        .flat()
        .map((lobby) => lobby.gameID);
    }
  });
  await new Promise<void>((resolve) =>
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve),
  );
  // Leave a full broadcast interval before readiness, so stale registry state is observable.
  await delay(850);
  process.send!({
    type: "workerReady",
    workerId,
    port: (server.address() as AddressInfo).port,
  });
  const lobby = {
    gameID: `dead-${process.pid}`,
    numClients: 0,
    publicGameType: "hosted",
  } satisfies InternalGameInfo;
  process.send!({
    type: "lobbyList",
    lobbies: [lobby],
    liveGames: workerId === 0 ? 3 : 5,
  });
}

(cluster.isPrimary ? runPrimary() : runWorker()).then(
  () => {
    if (cluster.isPrimary) process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
