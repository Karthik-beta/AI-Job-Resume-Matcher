import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { config } from "./config";

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix("api");
app.enableShutdownHooks();
await app.listen(config.API_PORT);
Logger.log(`API listening on http://localhost:${config.API_PORT}/api`, "Bootstrap");
