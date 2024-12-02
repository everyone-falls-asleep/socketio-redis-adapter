import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyRedis from "@fastify/redis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

const schema = {
  type: "object",
  required: ["PORT", "CACHE_HOST", "CACHE_PORT"],
  properties: {
    PORT: {
      type: "integer",
    },
    CACHE_HOST: {
      type: "string",
    },
    CACHE_PORT: {
      type: "integer",
    },
  },
};

const fastify = Fastify({
  trustProxy: true,
  logger: true,
});

await fastify.register(fastifyEnv, {
  schema,
  dotenv: true,
});

await fastify.register(fastifyRedis, {
  host: fastify.config.CACHE_HOST,
  port: fastify.config.CACHE_PORT,
  family: 4,
});

fastify.get("/liveness", (request, reply) => {
  reply.send({ status: "ok", message: "The server is alive." });
});

const pubClient = fastify.redis.duplicate();
const subClient = fastify.redis.duplicate();

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: "*",
    credentials: true,
  },
  transports: ["websocket"],
  adapter: createAdapter(pubClient, subClient),
});

const GLOBAL_ROOM = "global-room";

io.on("connection", (socket) => {
  // Log when a new client connects
  console.log(`New client connected: ${socket.id}`);

  // Automatically join the global room
  socket.join(GLOBAL_ROOM);

  // Notify other clients in GLOBAL_ROOM about the new connection
  socket.to(GLOBAL_ROOM).emit("user-joined", {
    id: socket.id,
    message: `User ${socket.id} has joined the ${GLOBAL_ROOM}`,
  });

  socket.on("disconnect", async () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Notify other clients in GLOBAL_ROOM about the disconnection
    socket.to(GLOBAL_ROOM).emit("user-left", {
      id: socket.id,
      message: `User ${socket.id} has left the ${GLOBAL_ROOM}`,
    });
  });
});

io.of("/").adapter.on("join-room", (room, id) => {
  if (room != id) {
    console.log(`Socket ${id} has joined room ${room}`);
    // Broadcast the event to all nodes
    io.serverSideEmit("join-room", { room, id });
  }
});

io.of("/").adapter.on("leave-room", (room, id) => {
  if (room != id) {
    console.log(`Socket ${id} has left room ${room}`);
    // Broadcast the event to all nodes
    io.serverSideEmit("leave-room", { room, id });
  }
});

// Handle server-side emitted events
io.on("join-room", ({ room, id }) => {
  console.log(`Socket ${id} has joined room ${room}`);
});

io.on("leave-room", ({ room, id }) => {
  console.log(`Socket ${id} has left room ${room}`);
});

const startServer = async () => {
  try {
    const port = Number(fastify.config.PORT);
    const address = await fastify.listen({ port, host: "0.0.0.0" });

    fastify.log.info(`Server is now listening on ${address}`);

    if (process.send) {
      process.send("ready");
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

let shutdownInProgress = false; // 중복 호출 방지 플래그

async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    fastify.log.warn(
      `Shutdown already in progress. Ignoring signal: ${signal}`
    );
    return;
  }
  shutdownInProgress = true; // 중복 호출 방지

  fastify.log.info(`Received signal: ${signal}. Starting graceful shutdown...`);

  try {
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    fastify.log.info("All Socket.IO connections have been closed.");

    await fastify.close();
    fastify.log.info("Fastify server has been closed.");

    // 기타 필요한 종료 작업 (예: DB 연결 해제)
    // await database.disconnect();
    fastify.log.info("Additional cleanup tasks completed.");

    fastify.log.info("Graceful shutdown complete. Exiting process...");
    process.exit(0);
  } catch (error) {
    fastify.log.error("Error occurred during graceful shutdown:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
