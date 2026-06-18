# Auto Dialer — Google Sheets add-on (Apps Script)

Activate the auto dialer **inside any Google Sheet**. You get an
**☎️ Auto Dialer** menu that works down a column of phone numbers one at a time:
it calls each number through Twilio, records and transcribes what the automated
system says, writes that transcript back into the sheet, and moves to the next
number.

```
☎️ Auto Dialer ▸ Start dialing
        │
        ▼
  call #1 ─▶ Twilio records + transcribes ─▶ result written to row ─▶ call #2 ─▶ …
```

## What's in this folder

| File | Purpose |
| --- | --- |
| `Code.gs` | All the logic: menu, dial loop, Twilio calls, webhook handlers |
| `Settings.html` | The Settings dialog (Twilio credentials + column names) |
| `appsscript.json` | Manifest: OAuth scopes + Web App config |

## Sheet format

The active sheet needs a header row (row 1) with these columns (names are
configurable in Settings, matching is case-insensitive):

| Phone | Status | Result |
| --- | --- | --- |
| +15551230001 | | |
| +15551230002 | | |

- **Phone** — the number to call, in E.164 format (e.g. `+15551234567`).
- **Status** — the dialer fills this in (`calling`, `completed`, `no-answer`, …).
- **Result** — the dialer writes the transcript of what the system said here.

Rows whose Status is already a finished value are skipped, so you can stop and
restart safely.

## Setup (about 5 minutes)

### 1. Add the script to your sheet

**Option A — paste it in:**
1. Open your Google Sheet ▸ **Extensions ▸ Apps Script**.
2. Replace the default `Code.gs` with the contents of `Code.gs` here.
3. Add a file ▸ **HTML**, name it `Settings`, and paste in `Settings.html`.
4. (Recommended) Click the gear ▸ **Show appsscript.json**, and paste in
   `appsscript.json`.
5. Save.

**Option B — with [clasp](https://github.com/google/clasp):**
```sh
npm install -g @google/clasp
clasp login
# In a copy of this folder, with a .clasp.json pointing at your script ID:
clasp push
```
See `.clasp.json.example`.

### 2. Deploy as a Web App (so Twilio can call back)

1. In the Apps Script editor: **Deploy ▸ New deployment**.
2. Type: **Web app**.
3. **Execute as:** Me. **Who has access:** **Anyone**.
4. Deploy, authorize the requested permissions, and copy the **Web App URL**.

> The script reads this URL automatically at runtime — you don't need to paste it
> anywhere. You just have to deploy once. (Redeploy if you ever change the code.)

### 3. Add your Twilio details

1. Reload the sheet so the **☎️ Auto Dialer** menu appears.
2. **☎️ Auto Dialer ▸ Settings…**
3. Enter your **Account SID**, **Auth Token**, and **From number** (a
   voice-capable Twilio number you own). Adjust column names if yours differ.
4. Save. The dialog confirms the Web App URL that Twilio will use for callbacks.

### 4. Dial

- **☎️ Auto Dialer ▸ Start dialing** — begins at the first pending row.
- **Stop dialing** — finishes the current call, starts no new ones.
- **Reset statuses** — clears the Status/Result columns to start over.

## How it works (under the hood)

Apps Script can't keep a loop open while a phone call runs, so the flow is
event-driven and strictly sequential:

1. `startDialing()` records which sheet is active and calls `dialNext_()`.
2. `dialNext_()` finds the next pending row, marks it `calling`, and places a
   Twilio call. It stores a `CallSid → row` mapping in Script Properties.
3. Twilio fetches TwiML from the Web App (`?action=voice`) telling it to record
   and transcribe the far end.
4. When the transcription is ready, Twilio POSTs it to the Web App
   (`?action=transcription`). The handler writes the result back to the mapped
   row and calls `dialNext_()` again — kicking off the next call.
5. Calls that aren't answered come back through `?action=status` (busy /
   no-answer / failed) and also advance the queue.

`LockService` serializes the writes so the status and transcription callbacks
can't collide.

## Notes & limitations

- **Transcription quality:** Twilio's built-in transcription is English-only and
  best for recordings under ~2 minutes. For other languages or long calls, swap
  the `<Record transcribe>` step in `voiceTwiml_()` for a dedicated
  speech-to-text service.
- **One sheet at a time:** a single deployment dials one active sheet at a time
  (tracked in Script Properties). Running two campaigns simultaneously from the
  same script isn't supported.
- **Legal / consent:** recording calls is regulated and consent rules vary by
  jurisdiction. You are responsible for complying with all applicable laws
  (one-/two-party consent, telemarketing/robocall rules) and for only calling
  numbers you're authorized to contact.
- **Cost:** each call and transcription consumes Twilio credit. Test with a small
  list first.
