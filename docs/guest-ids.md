# Guest IDs, Form C and the Drive archive

## The flow

1. **Check-in (property desk).** On Front desk, every arrival and in-house row has an **ID proof** button
   (lime until something is on file, then "ID ✓ n"). It opens the Guest IDs screen for that stay.
2. **Capture.** Mark the guest **Indian national** or **Foreign national**, pick the document type and tap
   **Take photo**. On a phone this opens the camera; on a computer it opens a file picker (photos or PDF).
   - Indian guests: Aadhaar, passport, driving licence or voter ID. Photograph both sides if the address is on the back.
   - Foreign guests: passport photo page, visa page, arrival stamp. A note field covers "second guest", "back side" and so on.
   Each capture names the person on the document, so a stay with several guests holds one set per person.
   A blurred or wrong capture can be removed by the desk while the file is still held in AVOS.
3. **Form C (sales).** Marking a stay foreign opens a **Form C to file** item on the sales desk's My work with a
   24-hour tolerance from arrival (the FRRO rule) and a notification. Sales opens the stay, sees the passport,
   visa and arrival stamp, files Form C on the FRRO portal, and records the acknowledgement number with
   **Mark Form C filed**. The stay then shows "Form C filed (ack …)".
4. **Archive (automatic).** 48 hours after the stay ends (check-out, cancellation or no-show), the cron moves
   the stay's documents to the owner's Google Drive under **AVOS – Guest IDs / `<check-in date> <guest> · <ref> · <booking id>`**
   and deletes the copies in AVOS. The record keeps the Drive links, so the Guest IDs screen still finds the
   stay by name, phone or reference and opens the files on Drive.

## Who sees what

| Role | Capture / remove | View documents | Mark nationality | File Form C |
|---|---|---|---|---|
| property | yes | yes | yes | no |
| sales | no | yes | no | yes |
| revenue | no | yes | no | yes |
| owner | yes | yes | yes | yes |
| accountant | no | no | no | no |

Every capture, removal, nationality change, Form C filing and archive run is written to the change log
(without the image). Files are served only through the signed-in API with `cache-control: no-store`.

## Work-queue items

| Item | Desk | Tolerance | Clears when |
|---|---|---|---|
| no ID proof on file (checked-in stay) | property | 2 h from check-in | a document is captured |
| Form C to file (foreign stay) | sales | 24 h from arrival | the acknowledgement is recorded |
| finished stays with documents waiting to archive | owner | 72 h past the 48-hour mark | Drive is connected and the cron moves them |

## Connecting Google Drive (owner, once)

AVOS uses the owner's own Google account with the `drive.file` scope: it can only see the folder and files it
creates. Nothing else in the Drive is visible to it.

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project (or reuse one), enable the
   **Google Drive API**, and under **APIs & Services → OAuth consent screen** set up an External app with the
   owner's email as a test user (or Internal if the account is on Google Workspace).
2. **Credentials → Create credentials → OAuth client ID → Web application.** Add the authorised redirect URI
   shown on AVOS Settings & users → Google Drive (it is `https://app.shajianandan.com/api/admin/integrations/google-drive/callback`).
3. Copy the client ID and client secret into the repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   (GitHub → Settings → Secrets and variables → Actions) and redeploy (any push, or re-run the Deploy workflow).
4. In AVOS, signed in as owner from app.shajianandan.com, open **Settings & users → Google Drive** and press
   **Connect Google Drive**. Approve the consent screen. AVOS creates the folder "AVOS – Guest IDs" and shows
   the account and folder link. **Archive now** runs the 48-hour sweep immediately.

Until Drive is connected, documents stay in AVOS and the owner's My work shows how many finished stays are waiting.
