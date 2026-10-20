# AVOS pilot test script — all five roles, one stay, Lead → CA

Run this once, in order, on the live site <https://app.shajianandan.com>. Each block says who signs in, what to do, and what you should see. The whole run takes about 25 minutes. Use a phone for Sindhu's part; the + button is built for it.

Login: enter your email on the Access page, paste the one-time PIN from the mail. If Access says you are not allowed, your email is missing from the application's policy (Zero Trust → Access controls → Applications → `app.shajianandan.com` → policy). If AVOS says *no active user for …*, the email differs from the one in Settings & users; the owner fixes it there.

Before starting, the owner should check **Settings & users** once: five users, four rooms, tariff card, Booking.com terms.

---

## 1. Prachi · sales (bookings@meadowsvarkala.com)

Expected menu: Leads, Inbox — bookings, Reservations, Availability. **No** Dashboard, Approvals, Month close.

1. **Leads → + Lead**: source WhatsApp, name *Test Guest One*, phone `9999900001`, check-in **tomorrow**, check-out **the day after**, 1 room, 2 adults → Save.
2. On the card: **Mark contacted**, tick **Deluxe**, **Quote → WhatsApp**. Expect the quote at the tariff rate, the chip *on tariff*, and WhatsApp opening with the message prefilled (close it).
3. **Hold 48 h** → the card shows the expiry. Open **Availability**: Deluxe shows *hold* on tomorrow's night.
4. Back in Leads: **Won → booking**. Toast says the booking was created. Open **Reservations**: the booking is **approved** (on tariff approves itself).
5. Still in Reservations, **New manual booking**: *Test Guest Two*, phone `9999900002`, same dates, room **Premium**, nightly rate **₹5,000** (below tariff) → Save. Expect *Awaiting approval: rate_below* and status **provisional**.
6. **Inbox — bookings → Paste an email**: From `noreply@staah.com`, Subject `STAAH · New reservation · Booking.com`, Body:
   ```
   Channel: Booking.com
   Ref: 9000000001
   Guest: Test OTA Guest
   Room: Superior ×1
   Check-in: <tomorrow as DD/MM/YYYY>
   Check-out: <day after as DD/MM/YYYY>
   Room Total: ₹5,500.00 (ex-GST)
   Commission: 23%
   Channel Collect
   ```
   Ingest → the card shows the parsed fields → tick **Superior** → **Approve**. Reservations now lists a Booking.com stay, approved.
7. Try the wall: open <https://app.shajianandan.com/api/reports/pnl> in the same browser. Expect a JSON error with *may not use pnl_reports* (HTTP 403).

## 2. Trupti · revenue (trupti@truvic.co.in)

Expected menu: Approvals, OTA payouts, Smart Reconcile, Revenue overview, plus the sales and property screens. **No** Dashboard, Bank expenses, Settings.

1. **Approvals**: exactly one item, *Test Guest Two* with reason *rate_below*. **Approve** with a note.
2. Prachi's wall from the other side: **Revenue overview** opens; `/api/reports/pnl` gives 403.

## 3. Sindhu · property manager (meadowsvarkala@gmail.com) — on a phone

Expected: Front desk, Payments, Guest invoices, Tasks, Expenses & petty cash; bottom tab bar; gold **+** button.

1. **Payments**: Test Guest One appears under *Collect at property*. Tap **Collect**, change the amount on the keypad to **₹2,000** (an advance), method **UPI**, reference `TESTUTR1` → *Collected*. Balance shown should drop by ₹2,000.
2. Tomorrow's stay is not today's, so to test the desk now: owner temporarily sets today's date in a booking? No — instead test the **+** button:
   - **+ → Expense**: skip the photo, keypad **₹460**, category *Housekeeping* → Save. Toast: *Saved · audited · petty cash updated*.
   - **+ → Task**: location *Garden*, kind *Note*, line *sprinkler head broken* → Save note.
   - **+ → Task**: *Premium*, *Maintenance*, line *leaking tap* → Save task.
3. **Tasks**: the leaking tap is *open*. Expand *Done + attach bill*: amount **₹1,200**, vendor *Varkala Plumbing*, GSTIN `32AAACX1234A1Z5` → **Done + post ₹1200**. The task closes and the expense appears under **Expenses & petty cash** with *GSTIN ✓*. Petty cash in hand should read ₹5,000 − 460 − 1,200 = **₹3,340**.
4. Turn the phone's data off, add one more **+ → Expense** of ₹100: toast says *Saved offline · pending sync*; a *1 pending sync* badge shows. Turn data on, wait up to 30 s or tap **Sync now**: the badge clears, the expense is in the list.

## 4. Front desk, check-out, invoice (tomorrow, Sindhu)

Do this on the check-in date so the arrivals list is real.

1. **Front desk → Arrivals**: Test Guest One → **Check in**. Test OTA Guest → **Check in**. Test Guest Two → **No-show** (this also opens a refund approval if any money was taken; none was).
2. Next day, **Departures**: Test Guest One → **Check out**. The green card shows the balance (gross − ₹2,000) and *Collect*. Tap **Collect**, method **Cash** → paid. Tap **Issue invoice**: a tab opens with invoice **MV/26-27/001** showing *GST not applicable — unregistered supplier* and balance ₹0. The **Tasks** screen now has a housekeeping task for Deluxe.
3. **Departures**: Test OTA Guest → **Check out**. Card says *OTA collect — nothing to take*; a housekeeping task for Superior appears.

## 5. Trupti · payouts and reconcile (after step 4)

1. **OTA payouts**: Booking.com → the OTA stay is listed, tick it → **Compute**. Expect gross ₹5,500, commission ₹1,265, fee ₹109.45, expected **₹4,125.55**. Payout reference `TESTPAYOUT1`, date today → **Draft settlement** → **Mark settled**. The settlement shows *settled* and the detail lists two expenses it created.
2. **Smart Reconcile**: paste these three lines (tab-separated; today's date as DD/MM/YYYY):
   ```
   <today>	NEFT BOOKING.COM TESTPAYOUT1		4125.55
   <today>	UPI CR TESTUTR1 TEST GUEST		2000.00
   <today>	UNKNOWN CREDIT		999.00
   ```
   → **Match**. Expect: payout *Tier 1 · UTR*, UPI *Tier 1 · UTR*, UNKNOWN *unmatched*; auto rate 67 %. **Accept all proposed**. For UNKNOWN: **Explain / carry** with reason *test*.
3. **Revenue overview**: revenue shows the two checked-out stays; direct share 50 %; pre-close exceptions are listed. Press **Carry exceptions & clear** with note *pilot test*. Month status becomes *precleared*.

## 6. Shaji · owner (shajianandan@gmail.com)

1. **Dashboard**: revenue, expenses (₹1,760 petty + the settlement costs), operating result, cash position (bank, cash in hand ₹ balance from the cash collection, petty cash ₹3,340).
2. **Bank expenses**: record *KSEB electricity* ₹4,765, reference `NEFTTEST1` → it lists under *bank-paid*. **Top up petty cash** ₹3,000 → petty cash rises to ₹6,340 on Sindhu's screen; the dashboard's expense total does **not** change (a transfer is not an expense).
3. **Settings & users**: deactivate and reactivate one user; the change appears in **Change log**.

## 7. Shubham · CA (shubham.kandalkar@gmail.com)

Expected menu: Month close, GST filing sheet, Change log, plus invoices/reconcile/revenue in read mode. **No** Settings, Approvals.

1. **Month close**: status *precleared* → **Lock**. Expect *Locked · pack v1* and the statement pack files (summary, bookings, payments, expenses, invoices, bank, settlements) downloadable.
2. **GST filing sheet**: shows the banner *No GSTIN on the property* and zero output tax; TCS/TDS empty. **Mark Filed**.
3. The lock binds everyone: Sindhu tries **+ → Expense** dated today → error *period … is filed; unlock it first*. Shaji sees the same on Bank expenses.
4. **Unlock** with reason *pilot test* → warning that GST was filed. Trupti re-clears, CA locks again → *pack v2 · revised*.

---

## After the run

Tell Claude "pilot test done". The database is then checked for the expected trail (users, bookings, payments, settlement, bank lines, period lock versions, audit rows), and the test records are removed so the books start clean for real guests. Keep the users, rooms, tariff card and channels.
