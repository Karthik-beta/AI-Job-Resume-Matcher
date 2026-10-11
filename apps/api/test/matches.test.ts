import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { signUp, startApp } from "./helpers";

type Agent = Awaited<ReturnType<typeof signUp>>;

describe("matches", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alice: Agent;
  let bob: Agent;
  let aliceId: string;

  const userIdOf = async (agent: Agent) => {
    const session = await agent.get("/api/auth/get-session").expect(200);
    return session.body.user.id as string;
  };

  const addMatch = (jobUrl: string, matchedAt: Date, status: "PENDING" | "APPLIED" = "PENDING") =>
    prisma.match.create({
      data: {
        userId: aliceId,
        jobUrl,
        title: "Engineer",
        company: "Example",
        reason: "Fit",
        matchedAt,
        status,
      },
    });

  beforeAll(async () => {
    app = await startApp();
    prisma = app.get(PrismaService);
    alice = await signUp(app.getHttpServer());
    bob = await signUp(app.getHttpServer());
    aliceId = await userIdOf(alice);
  });

  afterAll(async () => {
    await prisma.match.deleteMany({ where: { userId: aliceId } });
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).get("/api/matches").expect(401);
  });

  it("lists matches newest first and filters by status", async () => {
    const older = await addMatch("https://jobs.example.com/1", new Date("2026-01-01"));
    const newer = await addMatch("https://jobs.example.com/2", new Date("2026-02-01"));
    const applied = await addMatch("https://jobs.example.com/3", new Date("2026-03-01"), "APPLIED");

    const all = await alice.get("/api/matches").expect(200);
    expect(all.body.map(({ id }: { id: string }) => id)).toEqual([applied.id, newer.id, older.id]);

    const pending = await alice.get("/api/matches?status=PENDING").expect(200);
    expect(pending.body.map(({ id }: { id: string }) => id)).toEqual([newer.id, older.id]);

    await alice.get("/api/matches?status=REJECTED").expect(400);
    expect((await bob.get("/api/matches").expect(200)).body).toEqual([]);
  });

  it("sets a match's status", async () => {
    const match = await addMatch("https://jobs.example.com/4", new Date());
    const response = await alice
      .patch(`/api/matches/${match.id}`)
      .send({ status: "APPLIED" })
      .expect(200);
    expect(response.body).toMatchObject({ id: match.id, status: "APPLIED" });
    await alice.patch(`/api/matches/${match.id}`).send({ status: "DONE" }).expect(400);
  });

  it("does not let another user update a match", async () => {
    const match = await addMatch("https://jobs.example.com/5", new Date());
    await bob.patch(`/api/matches/${match.id}`).send({ status: "APPLIED" }).expect(404);
    const unchanged = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(unchanged.status).toBe("PENDING");
  });
});
