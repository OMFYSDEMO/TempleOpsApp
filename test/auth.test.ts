import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql, USERS } from "./helpers";
import { SELF } from "cloudflare:test";

/** In-app email + password login. The dev header is still honoured in the test environment, so the owner can bootstrap. */
async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`http://avos.test${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: res.status, json, cookie };
}

describe("login", () => {
  beforeAll(seed);
  let cookie = "";

  it("nobody can sign in before a password exists; the owner sets a temporary one", async () => {
    expect((await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "whatever123" })).status).toBe(401);
    expect((await api("sindhu", "POST", "/api/admin/users/usr_sindhu/set-password", { password: "Temp-pass-1234" })).status).toBe(403); // not the owner
    expect((await api("shaji", "POST", "/api/admin/users/usr_sindhu/set-password", { password: "short" })).status).toBe(400);
    await ok("shaji", "POST", "/api/admin/users/usr_sindhu/set-password", { password: "Temp-pass-1234" });
  });

  it("wrong password is refused; five failures lock the account", async () => {
    for (let i = 0; i < 4; i++) expect((await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "nope-nope-nope" })).status).toBe(401);
    expect((await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "nope-nope-nope" })).status).toBe(423);
    expect((await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "Temp-pass-1234" })).status).toBe(423); // locked even with the right password
    await sql("UPDATE credentials SET locked_until = NULL WHERE user_id = 'usr_sindhu'");
  });

  it("correct password signs in with a session cookie, must change the temporary password", async () => {
    const r = await raw("POST", "/api/auth/login", { email: USERS.sindhu.toUpperCase(), password: "Temp-pass-1234" });
    expect(r.status).toBe(200);
    expect(r.json.must_change_password).toBe(true);
    expect(r.cookie).toMatch(/^avos_session=/);
    cookie = r.cookie;
    const me = await raw("GET", "/api/me", undefined, { cookie });
    expect(me.status).toBe(200);
    expect(me.json.actor.role).toBe("property");
    expect(me.json.actor.via).toBe("session");
    expect(me.json.must_change_password).toBe(true);
    // the session, not the dev header, decides who you are
    const spoof = await raw("GET", "/api/me", undefined, { cookie, "x-dev-user": USERS.shaji });
    expect(spoof.json.actor.role).toBe("property");
  });

  it("role walls apply to session logins too", async () => {
    expect((await raw("GET", "/api/reports/pnl", undefined, { cookie })).status).toBe(403);
    expect((await raw("GET", "/api/bookings/frontdesk/today", undefined, { cookie })).status).toBe(200);
  });

  it("change password clears the flag and signs out other devices", async () => {
    const other = await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "Temp-pass-1234" });
    expect((await raw("POST", "/api/auth/change-password", { current_password: "wrong-wrong-1", new_password: "My-new-pass-999" }, { cookie })).status).toBe(401);
    const ch = await raw("POST", "/api/auth/change-password", { current_password: "Temp-pass-1234", new_password: "My-new-pass-999" }, { cookie });
    expect(ch.status).toBe(200);
    cookie = ch.cookie; // rotated
    expect((await raw("GET", "/api/me", undefined, { cookie })).json.must_change_password).toBe(false);
    expect((await raw("GET", "/api/me", undefined, { cookie: other.cookie })).status).toBe(401); // other device revoked
    expect((await raw("POST", "/api/auth/login", { email: USERS.sindhu, password: "Temp-pass-1234" })).status).toBe(401);
  });

  it("logout revokes the session", async () => {
    await raw("POST", "/api/auth/logout", {}, { cookie });
    expect((await raw("GET", "/api/me", undefined, { cookie })).status).toBe(401);
  });

  it("owner hands out a one-time set-password link; it works once", async () => {
    const link = await ok("shaji", "POST", "/api/admin/users/usr_prachi/password-link");
    expect(link.link).toMatch(/#reset\?token=/);
    const token = link.link.split("token=")[1];
    expect((await raw("POST", "/api/auth/reset", { token, password: "tiny" })).status).toBe(400);
    const r = await raw("POST", "/api/auth/reset", { token, password: "Prachi-pass-2026" });
    expect(r.status).toBe(200);
    expect((await raw("GET", "/api/me", undefined, { cookie: r.cookie })).json.actor.role).toBe("sales");
    expect((await raw("POST", "/api/auth/reset", { token, password: "Another-pass-1" })).status).toBe(400); // used
    expect((await raw("POST", "/api/auth/login", { email: USERS.prachi, password: "Prachi-pass-2026" })).status).toBe(200);
  });

  it("forgot password never reveals whether the email exists, and explains when email is not configured", async () => {
    const a = await raw("POST", "/api/auth/forgot", { email: USERS.prachi });
    const b = await raw("POST", "/api/auth/forgot", { email: "nobody@example.com" });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.json.message).toBe(b.json.message);
    expect(await sql("SELECT kind FROM password_tokens WHERE user_id = 'usr_prachi' AND kind = 'reset'")).toHaveLength(1);
  });

  it("deactivated users cannot sign in and their sessions die", async () => {
    const r = await raw("POST", "/api/auth/login", { email: USERS.prachi, password: "Prachi-pass-2026" });
    await ok("shaji", "PATCH", "/api/admin/users/usr_prachi", { active: false });
    expect((await raw("GET", "/api/me", undefined, { cookie: r.cookie })).status).toBe(401);
    expect((await raw("POST", "/api/auth/login", { email: USERS.prachi, password: "Prachi-pass-2026" })).status).toBe(401);
    await ok("shaji", "PATCH", "/api/admin/users/usr_prachi", { active: true });
  });

  it("session endpoint reports state without a login", async () => {
    const s = await raw("GET", "/api/auth/session");
    expect(s.json.signed_in).toBe(false);
  });
});
