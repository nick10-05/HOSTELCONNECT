import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Email, Mailer } from "../src/lib/mailer";
import { signSession } from "../src/lib/token";
import { SESSION_COOKIE } from "../src/middleware/auth";
import { insertOwner, insertStay, insertStructure, testPool } from "./helpers/db";

// Deleting a building or room over HTTP: GET .../deletion, POST .../delete-code, DELETE.
// Real database and real services; the mailer is a fake that keeps what it was given.
const SECRET = "test-secret-that-is-at-least-32-characters";
const db = testPool();
afterAll(() => db.end());

function fakeMailer(fail = false): Mailer & { sent: Email[] } {
  const sent: Email[] = [];
  return {
    sent,
    async send(email) {
      if (fail) throw new Error("Brevo is down");
      sent.push(email);
    },
  };
}

const codeIn = (email: Email) => /\b(\d{6})\b/.exec(email.text)![1];

async function ownerAndBuilding() {
  const owner = await insertOwner(db);
  const email = (await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [owner])).rows[0].email;
  const place = await insertStructure(db);
  return { cookie: `${SESSION_COOKIE}=${signSession({ userId: owner, role: "owner" }, SECRET)}`, email, ...place };
}

describe("deleting a building with an email code", () => {
  it("previews what would go, and says whether email is set up", async () => {
    const p = await ownerAndBuilding();
    const withMail = createApp({ db, jwtSecret: SECRET, mailer: fakeMailer() });
    const res = await request(withMail).get(`/api/buildings/${p.building}/deletion`).set("Cookie", p.cookie);
    expect(res.status).toBe(200);
    expect(res.body.deletion).toMatchObject({ name: p.buildingName, floors: 1, rooms: 1, beds: 2, emailReady: true });
    const noMail = createApp({ db, jwtSecret: SECRET });
    const off = await request(noMail).get(`/api/buildings/${p.building}/deletion`).set("Cookie", p.cookie);
    expect(off.body.deletion.emailReady).toBe(false);
  });

  it("answers 503 for a code when email is not set up", async () => {
    const p = await ownerAndBuilding();
    const app = createApp({ db, jwtSecret: SECRET });
    const res = await request(app)
      .post(`/api/buildings/${p.building}/delete-code`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("email_not_set_up");
  });

  it("sends the code to the owner's email, never to the browser, then deletes with it", async () => {
    const p = await ownerAndBuilding();
    await insertStay(db, { building: p.building, room: p.room, bed: p.bed1, endedOn: "2026-02-01" });
    const mailer = fakeMailer();
    const app = createApp({ db, jwtSecret: SECRET, mailer });

    const asked = await request(app)
      .post(`/api/buildings/${p.building}/delete-code`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName });
    expect(asked.status).toBe(201);
    expect(asked.body.code).toEqual({
      codeId: expect.any(String),
      expiresAt: expect.stringMatching(/Z$/),
      resendAfterSeconds: 60,
      sentTo: `${p.email.slice(0, 2)}•••${p.email.slice(p.email.indexOf("@"))}`,
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(p.email);
    const code = codeIn(mailer.sent[0]);
    expect(JSON.stringify(asked.body)).not.toContain(code);

    const wrong = await request(app)
      .delete(`/api/buildings/${p.building}`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName, codeId: asked.body.code.codeId, code: code === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toEqual({ code: "wrong_code", message: "That code is not right. 4 tries left." });
    // The wrong try was kept although the request failed.
    const tries = await db.query("SELECT attempts FROM deletion_codes WHERE id = $1", [asked.body.code.codeId]);
    expect(tries.rows[0].attempts).toBe(1);

    const done = await request(app)
      .delete(`/api/buildings/${p.building}`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName, codeId: asked.body.code.codeId, code });
    expect(done.status).toBe(200);
    expect(done.body.deleted).toMatchObject({ kind: "building", name: p.buildingName, pastStays: 1 });

    const again = await request(app)
      .delete(`/api/buildings/${p.building}`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName, codeId: asked.body.code.codeId, code });
    expect(again.status).toBe(410);
  });

  it("answers 502 when the email cannot be sent, and the code is never usable", async () => {
    const p = await ownerAndBuilding();
    const app = createApp({ db, jwtSecret: SECRET, mailer: fakeMailer(true) });
    const res = await request(app)
      .post(`/api/buildings/${p.building}/delete-code`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("email_failed");
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM deletion_codes WHERE target_id = $1 AND target_kind = 'building' AND send_failed_at IS NOT NULL",
      [p.building],
    );
    expect(rows[0].n).toBe(1);
    // No cooldown after a failed send.
    const retry = await request(createApp({ db, jwtSecret: SECRET, mailer: fakeMailer() }))
      .post(`/api/buildings/${p.building}/delete-code`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName });
    expect(retry.status).toBe(201);
  });

  it("checks the input: the name, the code's form and the id", async () => {
    const p = await ownerAndBuilding();
    const app = createApp({ db, jwtSecret: SECRET, mailer: fakeMailer() });
    const wrongName = await request(app)
      .post(`/api/buildings/${p.building}/delete-code`)
      .set("Cookie", p.cookie)
      .send({ confirmName: "Not it" });
    expect(wrongName.body.error.code).toBe("confirm_name_mismatch");
    const badCode = await request(app)
      .delete(`/api/buildings/${p.building}`)
      .set("Cookie", p.cookie)
      .send({ confirmName: p.buildingName, codeId: "not-a-uuid", code: "12ab" });
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.code).toBe("invalid_input");
    const badId = await request(app).delete("/api/rooms/abc").set("Cookie", p.cookie).send({});
    expect(badId.status).toBe(404);
  });

  it("deletes a room with its own code", async () => {
    const p = await ownerAndBuilding();
    const mailer = fakeMailer();
    const app = createApp({ db, jwtSecret: SECRET, mailer });
    const asked = await request(app).post(`/api/rooms/${p.room}/delete-code`).set("Cookie", p.cookie).send({ confirmName: "101" });
    expect(asked.status).toBe(201);
    const done = await request(app)
      .delete(`/api/rooms/${p.room}`)
      .set("Cookie", p.cookie)
      .send({ confirmName: "101", codeId: asked.body.code.codeId, code: codeIn(mailer.sent[0]) });
    expect(done.status).toBe(200);
    expect(done.body.deleted).toMatchObject({ kind: "room", beds: 2 });
  });
});
