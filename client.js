import { io } from "socket.io-client";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;

if (!PORT) {
  throw new Error("PORT is not defined in the .env file");
}

const SERVER_URL = `http://localhost:${PORT}`;

const socket = io(SERVER_URL, {
  transports: ["websocket"],
});

socket.on("connect", () => {
  socket.on("error", (error) => {
    console.error("Error:", error.message);
  });
});

socket.on("user-joined", (data) => {
  console.log(data.message);
});

socket.on("user-left", (data) => {
  console.log(data.message);
});

socket.on("disconnect", () => {
  console.log("Disconnected from server");
});

socket.on("connect_error", (err) => {
  console.error("Connection error:", err.message);
});
