import { useState } from "react";
import { post } from "../api";
import { Btn, Field, toast } from "../ui";

const Logo = () => <div className="logo"><img src="/icon.svg" width="44" height="44" alt="" /><div><b>AVOS</b><small>Autonomous Villa Operating System</small></div></div>;

export function Login({ onSignedIn, devUsers, onDevUser }: { onSignedIn: () => void; devUsers?: string[]; onDevUser?: (email: string) => void }) {
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault(); setErr(null); setMsg(null); setBusy(true);
    try {
      if (mode === "login") { await post("/auth/login", { email, password }); onSignedIn(); }
      else { const r = await post("/auth/forgot", { email }); setMsg(r.message); }
    } catch (ex: any) { setErr(ex?.message ?? String(ex)); } finally { setBusy(false); }
  };
  return <div className="authwrap"><form className="authcard" onSubmit={submit}>
    <Logo />
    <h1>{mode === "login" ? "Sign in" : "Forgot password"}</h1>
    <Field label="Email"><input type="email" autoComplete="username" required value={email} onChange={(e: any) => setEmail(e.currentTarget.value)} autoFocus /></Field>
    {mode === "login" && <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e: any) => setPassword(e.currentTarget.value)} /></Field>}
    {err && <div className="autherr">{err}</div>}
    {msg && <div className="authmsg">{msg}</div>}
    <button className="btn primary wide" type="submit" disabled={busy}>{busy ? "…" : mode === "login" ? "Sign in" : "Send reset link"}</button>
    <div className="authlinks">{mode === "login" ? <a href="#" onClick={(e) => { e.preventDefault(); setMode("forgot"); setErr(null); }}>Forgot password?</a> : <a href="#" onClick={(e) => { e.preventDefault(); setMode("login"); setMsg(null); }}>Back to sign in</a>}</div>
    {devUsers && devUsers.length > 0 && <div className="devbox"><small>Development only</small><select onChange={(e: any) => onDevUser?.(e.currentTarget.value)}><option value="">— sign in as a seeded user —</option>{devUsers.map((u) => <option value={u}>{u}</option>)}</select></div>}
  </form></div>;
}

/** Set a new password from an invite or reset link (#reset?token=…). */
export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault(); setErr(null);
    if (p1 !== p2) { setErr("the two passwords differ"); return; }
    setBusy(true);
    try { await post("/auth/reset", { token, password: p1 }); toast("Password set · signed in"); onDone(); } catch (ex: any) { setErr(ex?.message ?? String(ex)); } finally { setBusy(false); }
  };
  return <div className="authwrap"><form className="authcard" onSubmit={submit}><Logo /><h1>Set your password</h1>
    <Field label="New password" hint="at least 10 characters"><input type="password" autoComplete="new-password" required minLength={10} value={p1} onChange={(e: any) => setP1(e.currentTarget.value)} autoFocus /></Field>
    <Field label="Repeat it"><input type="password" autoComplete="new-password" required value={p2} onChange={(e: any) => setP2(e.currentTarget.value)} /></Field>
    {err && <div className="autherr">{err}</div>}
    <button className="btn primary wide" type="submit" disabled={busy}>{busy ? "…" : "Save and sign in"}</button>
    <div className="authlinks"><a href="#" onClick={(e) => { e.preventDefault(); location.hash = ""; onDone(); }}>Back to sign in</a></div>
  </form></div>;
}

/** Change password; `forced` when the owner gave a temporary one. */
export function ChangePassword({ forced, hasPassword, onDone }: { forced: boolean; hasPassword: boolean; onDone: () => void }) {
  const [cur, setCur] = useState(""); const [p1, setP1] = useState(""); const [p2, setP2] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault(); setErr(null);
    if (p1 !== p2) { setErr("the two passwords differ"); return; }
    setBusy(true);
    try { await post("/auth/change-password", { current_password: cur, new_password: p1 }); toast("Password changed"); onDone(); } catch (ex: any) { setErr(ex?.message ?? String(ex)); } finally { setBusy(false); }
  };
  return <div className="authwrap"><form className="authcard" onSubmit={submit}><Logo /><h1>{forced ? "Choose your own password" : "Change password"}</h1>
    {forced && <p className="muted">You signed in with a temporary password. Pick your own before continuing.</p>}
    {hasPassword && <Field label="Current password"><input type="password" autoComplete="current-password" required value={cur} onChange={(e: any) => setCur(e.currentTarget.value)} autoFocus /></Field>}
    <Field label="New password" hint="at least 10 characters"><input type="password" autoComplete="new-password" required minLength={10} value={p1} onChange={(e: any) => setP1(e.currentTarget.value)} /></Field>
    <Field label="Repeat it"><input type="password" autoComplete="new-password" required value={p2} onChange={(e: any) => setP2(e.currentTarget.value)} /></Field>
    {err && <div className="autherr">{err}</div>}
    <div className="actions">{!forced && <Btn onClick={onDone}>Cancel</Btn>}<button className="btn primary" type="submit" disabled={busy} style={forced ? { width: "100%" } : undefined}>{busy ? "…" : "Save"}</button></div>
  </form></div>;
}
