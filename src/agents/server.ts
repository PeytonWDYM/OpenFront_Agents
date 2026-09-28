import express from "express";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { Arena } from "./Arena";

const arena = new Arena();
const app = express();
const StartRequestSchema = z.union([
  z.object({}).strict(),
  z.object({ clientId: z.string(), spectator: z.boolean() }).strict(),
]);
let mutations: Promise<unknown> = Promise.resolve();

function localHost(value: string) {
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

// Keep subscription-authenticated controls off remote origins and DNS-rebound hosts.
app.use((req, res, next) => {
  if (
    !localHost(`http://${req.headers.host}`) ||
    (req.headers.origin && !localHost(req.headers.origin))
  ) {
    res
      .status(403)
      .json({ error: "The agent arena only accepts localhost requests." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(
  "/api/agents/frames",
  express.static(resolve(".agent-arena/frames"), { index: false }),
);

app.get("/api/agents", (_req, res) => res.json(arena.snapshot()));
app.get("/api/agents/players/:id", (req, res) =>
  res.json(arena.inspect(req.params.id, req.query.full === "1")),
);
app.get("/api/agents/players/:id/observation", (req, res) =>
  res.json({ observation: arena.observe(req.params.id) }),
);

function mutation(
  path: string,
  action: (req: express.Request) => unknown | Promise<unknown>,
) {
  app.post(path, async (req, res, next) => {
    const work = mutations.then(() => action(req));
    mutations = work.catch(() => {});
    try {
      res.json(await work);
    } catch (error) {
      next(error);
    }
  });
}

mutation("/api/agents/create", (req) => arena.create(req.body));
mutation("/api/agents/start", (req) => {
  const join = StartRequestSchema.parse(req.body);
  return arena.start(
    "clientId" in join
      ? {
          clientId: join.clientId,
          spectator: join.spectator,
        }
      : undefined,
  );
});
mutation("/api/agents/pause", () => arena.pause());
mutation("/api/agents/resume", () => arena.resume());
mutation("/api/agents/stop", () => arena.stop());
mutation("/api/agents/players/:id/compact", (req) =>
  arena.compact(String(req.params.id)),
);

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res
      .status(error instanceof ZodError ? 400 : 409)
      .json({ error: error instanceof Error ? error.message : String(error) });
  },
);

const server = app.listen(9010, "127.0.0.1", () =>
  console.log("Local agent arena: http://127.0.0.1:9010/api/agents"),
);
async function shutdown() {
  server.close();
  await arena.stop();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
