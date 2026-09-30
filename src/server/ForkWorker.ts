import cluster from "cluster";
import winston from "winston";
import { MasterLobbyService } from "./MasterLobbyService";

// Keep the logical index in the exit handler. ChildProcess does not expose its environment.
export function forkWorker(
  workerId: number,
  instanceId: string,
  lobbyService: Pick<MasterLobbyService, "registerWorker" | "removeWorker">,
  log: winston.Logger,
): void {
  const worker = cluster.fork({ WORKER_ID: workerId, INSTANCE_ID: instanceId });
  lobbyService.registerWorker(workerId, worker);
  log.info(`Started worker ${workerId} (PID: ${worker.process.pid})`);
  worker.once("exit", (code, signal) => {
    lobbyService.removeWorker(workerId);
    log.warn(
      `Worker ${workerId} (PID: ${worker.process.pid}) died with code: ${code} and signal: ${signal}`,
    );
    log.info(`Restarting worker ${workerId}...`);
    forkWorker(workerId, instanceId, lobbyService, log);
  });
}
