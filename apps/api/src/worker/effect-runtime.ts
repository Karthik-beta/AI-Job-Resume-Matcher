import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { config } from "../config";
import { pageCacheStoreLayer } from "../matching/page-cache";
import { PrismaService } from "../prisma/prisma.service";
import { fakeProvidersLayer } from "../providers/fake";
import { liveProvidersLayer } from "../providers/live";
import type { RunServices } from "../runs/process-run";

@Injectable()
export class EffectRuntime implements OnModuleInit, OnApplicationShutdown {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RunServices, never>;

  constructor(prisma: PrismaService) {
    this.runtime = ManagedRuntime.make(
      Layer.merge(
        pageCacheStoreLayer(prisma),
        config.PROVIDERS === "fake"
          ? fakeProvidersLayer
          : liveProvidersLayer(config.OPENROUTER_MODEL),
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
