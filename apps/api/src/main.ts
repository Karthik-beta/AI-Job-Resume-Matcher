import { Logger } from "@nestjs/common";
import { createApp } from "./app";
import { config } from "./config";

const app = await createApp();
app.enableShutdownHooks();
await app.listen(config.API_PORT);
Logger.log(`API listening on http://localhost:${config.API_PORT}/api`, "Bootstrap");
