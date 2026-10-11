import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { signUp, startApp } from "./helpers";

type Agent = Awaited<ReturnType<typeof signUp>>;

const ids = (page: { items: { id: string }[] }) => page.items.map(({ id }) => id);

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
    expect(ids(all.body)).toEqual([applied.id, newer.id, older.id]);
    expect(all.body.nextCursor).toBeNull();

    const pending = await alice.get("/api/matches?status=PENDING").expect(200);
    expect(ids(pending.body)).toEqual([newer.id, older.id]);

    await alice.get("/api/matches?status=REJECTED").expect(400);
    expect((await bob.get("/api/matches").expect(200)).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("pages through matches with a cursor", async () => {
    const matchedAt = new Date("2025-06-01");
    // Same timestamp for all, so the order across pages relies on the id tie-break.
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        addMatch(`https://jobs.example.com/page/${i}`, matchedAt, "APPLIED"),
      ),
    );
    const expected = created
      .map(({ id }) => id)
      .sort()
      .reverse();

    const first = await alice.get("/api/matches?status=APPLIED").expect(200);
    expect(first.body.items).toHaveLength(20);
    const second = await alice
      .get(`/api/matches?status=APPLIED&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.nextCursor).toBeNull();
    expect([...ids(first.body), ...ids(second.body)].filter((id) => expected.includes(id))).toEqual(
      expected,
    );
  });

  it("sets a match's status", async () => {
    const match = await addMatch("https://jobs.example.com/4", new Date());
    const response = await alice
      .patch(`/api/matches/${match.id}`)
      .send({ status: "APPLIED" })
      .expect(200);
    expect(response.body).toMatchObject({ id: match.id, status: "APPLIED" });
    await alice.patch(`/api/matches/${match.id}`).send({ status: "DONE" }).expect(400);

    await alice.patch(`/api/matches/${match.id}`).send({ status: "PENDING" }).expect(200);
    const pending = await alice.get("/api/matches?status=PENDING").expect(200);
    expect(ids(pending.body)).toContain(match.id);
  });

  it("rejects unknown matches and requests without a session", async () => {
    await alice.patch("/api/matches/missing").send({ status: "APPLIED" }).expect(404);
    await request(app.getHttpServer())
      .patch("/api/matches/missing")
      .send({ status: "APPLIED" })
      .expect(401);
  });

  it("does not let another user update a match", async () => {
    const match = await addMatch("https://jobs.example.com/5", new Date());
    await bob.patch(`/api/matches/${match.id}`).send({ status: "APPLIED" }).expect(404);
    const unchanged = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(unchanged.status).toBe("PENDING");
  });
});
