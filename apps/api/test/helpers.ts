import request from "supertest";
import { createApp } from "../src/app";

export async function startApp() {
  const app = await createApp({ logger: false });
  await app.init();
  return app;
}

export async function signUp(server: Parameters<typeof request.agent>[0]) {
  const agent = request.agent(server);
  const suffix = crypto.randomUUID();
  await agent
    .post("/api/auth/sign-up/email")
    .send({ name: "Test User", email: `test-${suffix}@example.com`, password: "password-1234" })
    .expect(200);
  return agent;
}
