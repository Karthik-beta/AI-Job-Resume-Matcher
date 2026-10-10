import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module";

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
Logger.log("Run worker started", "Bootstrap");
