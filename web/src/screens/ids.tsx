import { useEffect, useRef, useState } from "react";
import { api, get, post, del } from "../api";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, fmtDate, fmtDateTime, useLoad, run, toast } from "../ui";
import type { Me, Ref } from "../app";

/**
 * Guest IDs. The front desk photographs each guest's proof of identity at check-in; foreign nationals also
 * need Form C on the FRRO portal within 24 hours, which sales files and records here. Files are held
 * privately while the guest is in house and move to the owner's Google Drive 48 hours after the stay.
 */

const DOC_LABEL: Record<string, string> = { aadhaar: "Aadhaar", passport: "Passport", driving_licence: "Driving licence", voter_id: "Voter ID", visa: "Visa", arrival_stamp: "Arrival stamp", other: "Other" };
const INDIAN_DOCS = ["aadhaar", "passport", "driving_licence", "voter_id"];
const FOREIGN_DOCS = ["passport", "visa", "arrival_stamp", "other"];
const FORM_C_SET = ["passport", "visa", "arrival_stamp"];

export function idsHref(bookingId: string) { return `#ids?b=${bookingId}`; }
function bookingFromHash(): string | null { const m = location.hash.match(/[?&]b=([\w-]+)/); return m ? m[1] : null; }

/** Capture and review the documents of one stay. Used from the Guest IDs screen and from the front desk. */
export function IdPanel({ me, bookingId, onClose, onChange }: { me: Me; bookingId: string; onClose?: () => void; onChange?: () => void }) {
  const q = useLoad(() => get(`/ids/bookings/${bookingId}`), [bookingId]);
  const bq = useLoad(() => get(`/bookings/${bookingId}`), [bookingId]);
  const canCapture = me.capabilities.includes("ids_capture");
  const canFormC = me.capabilities.includes("form_c");
  const [person, setPerson] = useState("");
  const [docType, setDocType] = useState("aadhaar");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const d = q.data; const b = bq.data;
  useEffect(() => { if (b && !person) setPerson(b.guest.name); }, [b]);
  useEffect(() => { if (d) setDocType(d.guest_nationality === "foreign" ? "passport" : "aadhaar"); }, [d?.guest_nationality]);
  if (!d || !b) return <Loading error={q.error ?? bq.error} />;
  const foreign = d.guest_nationality === "foreign";
  const docs: any[] = d.documents;
  const refresh = async () => { await q.reload(); onChange?.(); };
  const setNat = (nationality: string) => {
    if (nationality === d.guest_nationality) return;
    // Marking a guest foreign asks sales to file Form C with the FRRO within 24 h: confirm it is meant.
    if (nationality === "foreign" && !confirm(`Mark ${b?.guest?.name ?? "this guest"} as a foreign national?\n\nSales will be asked to file Form C with the FRRO within 24 hours of arrival.`)) return;
    run(async () => { await post(`/ids/bookings/${bookingId}/nationality`, { nationality }); await refresh(); });
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const qs = new URLSearchParams({ doc_type: docType, nationality: d.guest_nationality, person_name: person || b.guest.name }); if (note.trim()) qs.set("note", note.trim());
      await api("POST", `/ids/bookings/${bookingId}/documents?${qs}`, undefined, { raw: file, contentType: file.type || "image/jpeg" });
      setNote(""); toast(`${DOC_LABEL[docType]} saved for ${person || b.guest.name}`); await refresh();
    } catch (e: any) { toast(e.message ?? "upload failed", "bad"); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const have = new Set(docs.filter((x) => x.nationality === "foreign").map((x) => x.doc_type));
  const formCPackComplete = FORM_C_SET.every((t) => have.has(t));
  const archived = !!d.ids_archived_at;
  return <Card title={<>{b.guest.name} <Status s={b.booking.status} /></>} sub={<>{fmtDate(b.booking.check_in)} → {fmtDate(b.booking.check_out)} · {b.rooms.map((r: any) => r.room_name).join(", ")} · {b.channel.name}{b.booking.external_ref ? ` · ref ${b.booking.external_ref}` : ""} · {b.booking.adults} adult{b.booking.adults > 1 ? "s" : ""}{b.booking.children ? `, ${b.booking.children} child${b.booking.children > 1 ? "ren" : ""}` : ""}</>}
    actions={onClose && <Btn small onClick={onClose}>Close</Btn>}>
    <div className="idhead">
      <div><div className="sub">Guest is</div><Chips value={d.guest_nationality} options={[{ value: "indian", label: "Indian national" }, { value: "foreign", label: "Foreign national" }]} onChange={canCapture && !archived ? setNat : () => {}} /></div>
      {foreign && <div className="formc"><div className="sub">Form C (FRRO) · within {24} h of arrival</div>
        {d.form_c_status === "filed" ? <div><Status s="filed" /> <span className="sub">ack {d.form_c_reference} · {fmtDateTime(d.form_c_filed_at)}</span></div>
          : <div><Status s="due" /> <span className="sub">{formCPackComplete ? "passport, visa and arrival stamp are on file: file it on the portal and record the acknowledgement" : `still need: ${FORM_C_SET.filter((t) => !have.has(t)).map((t) => DOC_LABEL[t]).join(", ")}`}</span>
            {canFormC && <div className="actions" style={{ marginTop: "8px" }}><input className="search" placeholder="FRRO acknowledgement / reference" value={ref} onChange={(e: any) => setRef(e.currentTarget.value)} /><Btn kind="primary" small disabled={ref.trim().length < 3} onClick={() => run(async () => { await post(`/ids/bookings/${bookingId}/form-c`, { reference: ref.trim() }); setRef(""); await refresh(); }, "Form C recorded as filed")}>Mark Form C filed</Btn></div>}
          </div>}
      </div>}
    </div>

    {archived ? <div className="note">Documents for this stay were moved to Google Drive on {fmtDateTime(d.ids_archived_at)}. Open them from the links below.</div>
      : canCapture && <div className="capture">
        <div className="sectionhead"><b>Add a document</b><span className="sub">{foreign ? "passport photo page, visa page, arrival stamp" : "any one government ID; both sides if the address is on the back"}</span></div>
        <Chips value={docType} options={(foreign ? FOREIGN_DOCS : INDIAN_DOCS).map((t) => ({ value: t, label: DOC_LABEL[t] }))} onChange={setDocType} />
        <div className="form-grid four" style={{ marginTop: "8px" }}>
          <Field label="Person on the document"><input value={person} onChange={(e: any) => setPerson(e.currentTarget.value)} /></Field>
          <Field label="Note (optional)"><input value={note} placeholder="back side, second guest, expired…" onChange={(e: any) => setNote(e.currentTarget.value)} /></Field>
        </div>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" style={{ display: "none" }} onChange={(e: any) => { const f = e.currentTarget.files?.[0]; if (f) upload(f); }} />
        <div className="actions"><Btn kind="primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading…" : `📷 Take photo · ${DOC_LABEL[docType]}`}</Btn><span className="sub">opens the camera on a phone; a file picker on a computer</span></div>
      </div>}

    <div className="sectionhead" style={{ marginTop: "14px" }}><b>On file</b><span className="sub">{docs.length === 0 ? "nothing yet" : `${docs.length} document${docs.length > 1 ? "s" : ""}`}</span></div>
    {docs.length === 0 ? <Empty>No ID proof captured for this stay.</Empty> : <div className="docgrid">{docs.map((x) => <div key={x.id} className="doc">
      {x.on_file_here ? <a href={`/api/ids/documents/${x.id}/file`} target="_blank" rel="noopener">{x.content_type.includes("pdf") ? <div className="pdf">PDF</div> : <img src={`/api/ids/documents/${x.id}/file`} alt="" loading="lazy" />}</a>
        : <a href={x.drive_link ?? "#"} target="_blank" rel="noopener"><div className="pdf">on Drive</div></a>}
      <div className="meta"><b>{DOC_LABEL[x.doc_type]}</b><span className="sub">{x.person_name}{x.note ? ` · ${x.note}` : ""}</span><span className="sub">{fmtDateTime(x.captured_at)}</span></div>
      {canCapture && x.on_file_here && <Btn small kind="danger" onClick={() => { if (confirm("Remove this capture?")) run(async () => { await del(`/ids/documents/${x.id}`); await refresh(); }, "Removed"); }}>Remove</Btn>}
    </div>)}</div>}
  </Card>;
}

export function GuestIds({ me }: { me: Me; refs: Ref }) {
  const [open, setOpen] = useState<string | null>(bookingFromHash());
  const [search, setSearch] = useState("");
  const q = useLoad(() => get(`/ids/overview${search.trim().length >= 2 ? `?q=${encodeURIComponent(search.trim())}` : ""}`), [search]);
  useEffect(() => { const f = () => setOpen(bookingFromHash()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const show = (id: string | null) => { setOpen(id); history.replaceState(null, "", id ? idsHref(id) : "#ids"); };
  const d = q.data;
  const StayRow = ({ b, cta }: { b: any; cta: string }) => <div className="row" key={b.id}>
    <div><div><b>{b.guest_name}</b> · {b.room_names}</div><div className="sub">{fmtDate(b.check_in)} → {fmtDate(b.check_out)} · {b.guest_nationality === "foreign" ? "foreign national" : "Indian"} · {b.doc_count ? `${b.doc_count} document${b.doc_count > 1 ? "s" : ""}` : "no ID yet"}{b.form_c_status === "due" ? " · Form C due" : b.form_c_status === "filed" ? ` · Form C filed (${b.form_c_reference})` : ""}{b.ids_archived_at ? " · archived to Drive" : ""}</div></div>
    <div className="actions">{b.doc_count === 0 && b.status === "checked_in" && <Status s="pending" />}<Btn small onClick={() => show(b.id)}>{cta}</Btn></div>
  </div>;
  return <>
    <h2>Guest IDs <small>photograph ID at check-in · Form C for foreign nationals within 24 h · files move to Google Drive 48 h after the stay</small></h2>
    {open && <IdPanel me={me} bookingId={open} onClose={() => show(null)} onChange={() => q.reload()} />}
    {!d ? <Loading error={q.error} /> : <>
      <div className="grid two">
        <Card title="In house and arriving today" sub="every stay needs at least one ID on file before the key is handed over">
          {d.in_house.length === 0 ? <Empty>Nobody in house.</Empty> : d.in_house.map((b: any) => <StayRow key={b.id} b={b} cta={b.doc_count ? "Open" : "Capture ID"} />)}
        </Card>
        <Card title="Form C to file" sub="foreign nationals · FRRO portal · record the acknowledgement number here">
          {d.form_c_due.length === 0 ? <Empty>No Form C open.</Empty> : d.form_c_due.map((b: any) => <StayRow key={b.id} b={b} cta="Open" />)}
        </Card>
      </div>
      <Card title="Archive" sub={d.drive.connected ? `Google Drive connected as ${d.drive.account_email ?? "owner"} · documents move ${d.archive_after_hours} h after the stay ends` : d.drive.configured ? "Google Drive is not connected yet: the owner connects it under Settings & users" : "Google Drive is not set up yet: documents stay here until the owner connects it"}
        actions={d.drive.folder_link && <a className="btn small" href={d.drive.folder_link} target="_blank" rel="noopener">Open Drive folder</a>}>
        {d.drive.last_error && <div className="note bad">Last archive attempt failed: {d.drive.last_error}</div>}
        {d.archive_waiting.length === 0 ? <Empty>Nothing waiting to archive.</Empty> : d.archive_waiting.map((b: any) => <StayRow key={b.id} b={b} cta="Open" />)}
      </Card>
      <Card title="Find a guest's documents" actions={<input className="search" placeholder="Guest name, phone or reference" value={search} onChange={(e: any) => setSearch(e.currentTarget.value)} />}>
        {search.trim().length < 2 ? <Empty>Type at least two letters.</Empty> : d.found.length === 0 ? <Empty>No stay with documents matches.</Empty> : d.found.map((b: any) => <StayRow key={b.id} b={b} cta="Open" />)}
      </Card>
    </>}
  </>;
}

/** Owner's Settings panel: connect, disconnect, run the archive now. */
export function DriveSettings() {
  const q = useLoad(() => get("/admin/integrations/google-drive"), []);
  const d = q.data;
  const msg = new URLSearchParams(location.hash.split("?")[1] ?? "").get("drive");
  useEffect(() => { if (msg) { toast(msg === "connected" ? "Google Drive connected" : `Drive: ${msg}`, msg === "connected" ? "ok" : "bad"); history.replaceState(null, "", "#admin"); } }, []);
  if (!d) return <Loading error={q.error} />;
  return <Card title="Google Drive · guest-ID archive" sub="ID photos move from AVOS to a folder in your Google Drive 48 hours after each stay ends, then are deleted here">
    {!d.configured ? <div className="note">Not set up yet. Create a Google Cloud OAuth client (web application) with this redirect URI, then add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as repository secrets and redeploy:<br /><code>{d.redirect_uri}</code></div>
      : d.connected ? <>
        <Row label="Connected as" value={d.account_email ?? "—"} sub={`since ${fmtDateTime(d.connected_at)}`} />
        <Row label="Folder" value={d.folder_link ? <a href={d.folder_link} target="_blank" rel="noopener">AVOS – Guest IDs</a> : "created on first archive"} />
        <Row label="Last archive run" value={d.last_used_at ? fmtDateTime(d.last_used_at) : "not yet"} sub={d.last_error ? `last error: ${d.last_error}` : undefined} />
        <div className="actions end"><Btn onClick={() => run(async () => { const r = await post("/admin/integrations/google-drive/archive-now"); toast(`Archived ${r.archived} stay${r.archived === 1 ? "" : "s"}`); await q.reload(); })}>Archive now</Btn><Btn kind="danger" onClick={() => { if (confirm("Disconnect Google Drive? Documents will wait here until it is connected again.")) run(async () => { await del("/admin/integrations/google-drive"); await q.reload(); }, "Disconnected"); }}>Disconnect</Btn></div>
      </> : <>
        <div className="sub" style={{ marginBottom: "10px" }}>Connect the Google account whose Drive should hold the archive. AVOS asks only for access to the folder it creates.</div>
        <div className="actions"><Btn kind="primary" onClick={() => run(async () => { const r = await post("/admin/integrations/google-drive/connect"); location.href = r.url; })}>Connect Google Drive</Btn></div>
      </>}
  </Card>;
}
