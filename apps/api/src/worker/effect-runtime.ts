import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { config } from "../config";
import { matchEvaluatorLayer } from "../matching/evaluate";
import { firecrawlLayer } from "../matching/firecrawl";
import { pageCacheStoreLayer } from "../matching/page-cache";
import { PrismaService } from "../prisma/prisma.service";
import type { RunServices } from "../runs/process-run";
import { workerConfig } from "./worker-config";

@Injectable()
export class EffectRuntime implements OnModuleInit, OnApplicationShutdown {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RunServices, never>;

  constructor(prisma: PrismaService) {
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(
        firecrawlLayer(workerConfig.FIRECRAWL_API_KEY),
        pageCacheStoreLayer(prisma),
        matchEvaluatorLayer({
          apiKey: workerConfig.OPENROUTER_API_KEY,
          model: config.OPENROUTER_MODEL,
        }),
      ),
    );
  }

  // Builds the layers at boot, so the Firecrawl rate limit is shared by every run.
  async onModuleInit() {
    await this.runtime.context();
  }

  runPromise<A, E>(effect: Effect.Effect<A, E, RunServices>) {
    return this.runtime.runPromise(effect);
  }

  async onApplicationShutdown() {
    await this.runtime.dispose();
  }
}
