import "reflect-metadata";
import type { NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

export async function createApp(options: NestApplicationOptions = {}) {
  const app = await NestFactory.create(AppModule, { ...options, bodyParser: false });
  app.setGlobalPrefix("api");
  return app;
}
