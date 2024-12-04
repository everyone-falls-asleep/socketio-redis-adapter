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

const STREAM_KEY = "chat-messages";
const CONSUMER_GROUP = "chat-group";
const CONSUMER_NAME = `consumer-${process.pid}`; // Unique consumer name per instance

// Initialize the consumer group
async function initializeStream() {
  try {
    // Create consumer group if it doesn't exist
    await fastify.redis.xgroup(
      "CREATE",
      STREAM_KEY,
      CONSUMER_GROUP,
      "0",
      "MKSTREAM"
    );
    fastify.log.info(
      `Consumer group '${CONSUMER_GROUP}' created or already exists.`
    );
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      fastify.log.info(`Consumer group '${CONSUMER_GROUP}' already exists.`);
    } else {
      fastify.log.error("Error creating consumer group:", err);
      process.exit(1);
    }
  }
}

// Function to read messages from the stream
async function consumeStream() {
  while (true) {
    try {
      const response = await fastify.redis.xreadgroup(
        "GROUP",
        CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        10,
        "BLOCK",
        5000, // 5 seconds
        "STREAMS",
        STREAM_KEY,
        ">"
      );

      if (response) {
        const [stream, messages] = response[0];
        for (const [id, fields] of messages) {
          const message = {};
          for (let i = 0; i < fields.length; i += 2) {
            message[fields[i]] = fields[i + 1];
          }
          fastify.log.info(`Processing message ID ${id}:`, message);
          io.emit("new-message", message);

          // Acknowledge the message
          await fastify.redis.xack(STREAM_KEY, CONSUMER_GROUP, id);
        }
      }
    } catch (err) {
      fastify.log.error("Error consuming stream:", err);
      // Optional: Implement retry logic or exit
    }
  }
}

// Start consuming the stream
await initializeStream();
consumeStream(); // Note: Not awaiting to allow it to run concurrently

io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Notify others that a new client has connected
  const connectMessage = {
    id: socket.id,
    message: `New client connected: ${socket.id}`,
    timestamp: new Date().toISOString(),
  };
  fastify.redis.xadd(
    STREAM_KEY,
    "*",
    "id",
    connectMessage.id,
    "message",
    connectMessage.message,
    "timestamp",
    connectMessage.timestamp
  );

  socket.on("disconnect", async () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Notify others that a client has disconnected
    const disconnectMessage = {
      id: socket.id,
      message: `Client disconnected: ${socket.id}`,
      timestamp: new Date().toISOString(),
    };
    await fastify.redis.xadd(
      STREAM_KEY,
      "*",
      "id",
      disconnectMessage.id,
      "message",
      disconnectMessage.message,
      "timestamp",
      disconnectMessage.timestamp
    );
  });
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

    await Promise.all([pubClient.quit(), subClient.quit()]);

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
