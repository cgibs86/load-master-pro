# sheet-dialer

Automated outbound calling driven by a Google Sheet.

Give it a spreadsheet full of phone numbers and it works down the list **one at a
time**: it calls each number, records and transcribes what the automated system
on the other end says, writes that result back into the same sheet, and moves on
to the next number.

## Two ways to run it

| | **Google Sheets add-on** (recommended) | **Node.js service** |
| --- | --- | --- |
| Where | Lives *inside* any Google Sheet | Runs on your machine / a server |
| Activate | Add the script once, get an **☎️ Auto Dialer** menu | `npm start` with a `.env` |
| Best for | "Just let me press a button in my sheet" | Headless / scheduled / scripted runs |
| Setup | [`apps-script/README.md`](apps-script/README.md) | see below |

👉 **To activate the dialer in any Google Sheet, use the add-on:
[`apps-script/`](apps-script/).** It needs no separate server — Google hosts the
webhooks for you. The Node.js service below is the same logic for headless use.

---

## Node.js service

```
Google Sheet ──read──▶ orchestrator ──place call──▶ Twilio ──▶ phone number
     ▲                      │                          │
     │                      │                  records + transcribes
     └──── write result ◀───┘◀──── transcription webhook ◀┘
```

## How it works

1. **Read** the sheet. The app looks for a header row with `Phone`, `Status`, and
   `Result` columns (names are configurable, matching is case-insensitive).
2. For each row that has a number and isn't already processed, it marks the row
   `calling`, then places an outbound call through **Twilio**.
3. Twilio fetches call instructions from this app's `/voice` endpoint, which tells
   it to **record and transcribe** the far end (the automated system).
4. When the transcription is ready, Twilio posts it to `/transcription`. The app
   **writes the transcript back** to the `Result` column and sets `Status` to
   `completed` (or `no-answer` / `busy` / `failed` / `timeout`).
5. It pauses briefly, then moves to the next number.

Calls are processed sequentially, so the run is easy to follow and rate-limit.

## Project layout

```
src/
  index.js            Entry point; wires dry-run vs. live mode
  config.js           Environment-variable configuration
  orchestrator.js     The row-by-row "call, capture, write back" loop
  resultBus.js        Coordinates each call's async result by Twilio Call SID
  server.js           Express app: Twilio TwiML + webhook callbacks
  telephony/
    twilio.js         Live calling via Twilio
    mock.js           Fake provider for dry-run + tests
  sheets/
    google.js         Read/write Google Sheets via a service account
    mock.js           Local JSON-backed sheet for dry-run + tests
test/
  orchestrator.test.js
data/
  sample-sheet.json   Sample input used by dry-run mode
```

## Quick start (dry run — no accounts needed)

The dry run exercises the entire orchestration with a mocked phone provider and a
local JSON file standing in for the sheet. No Twilio or Google credentials
required.

```sh
npm install        # only needed for a live run; dry-run/tests need no deps
npm run dry-run
```

You'll see each "call" placed and a fabricated transcript written back. Results
are saved to `data/sample-sheet.local.json` (git-ignored) so the committed
sample stays clean. Delete that file to start over.

## Running the tests

The tests cover the orchestrator using the in-memory mocks and need no
third-party dependencies:

```sh
npm test
```

## Going live

### 1. Install dependencies

```sh
npm install
```

### 2. Google Sheets access

1. In Google Cloud, create a **service account** and download its JSON key.
2. Enable the **Google Sheets API** for the project.
3. **Share your spreadsheet** with the service account's `client_email`
   (Editor access).
4. Make sure the sheet's first row has the header columns `Phone`, `Status`,
   `Result` (or whatever you set in `.env`).

### 3. Twilio

1. Get a Twilio account, a voice-capable phone number, and your Account SID +
   Auth Token.
2. Twilio needs to reach this app's webhooks over the public internet. For local
   development, expose your port with a tunnel:

   ```sh
   npx ngrok http 3000
   ```

   Use the resulting `https://…` URL as `PUBLIC_BASE_URL`.

### 4. Configure

```sh
cp .env.example .env
# then edit .env with your Sheet ID, Twilio credentials, and PUBLIC_BASE_URL
```

### 5. Run

```sh
npm start
```

The app starts its webhook server and works through the sheet.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Description |
| --- | --- |
| `DRY_RUN` | `true` to use mocks and the local JSON sheet |
| `GOOGLE_CREDENTIALS_PATH` | Path to the service-account JSON key |
| `SHEET_ID` | Spreadsheet ID from its URL |
| `SHEET_NAME` | Tab name to read/write (e.g. `Sheet1`) |
| `PHONE_COLUMN` / `STATUS_COLUMN` / `RESULT_COLUMN` | Header names to match |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_FROM_NUMBER` | Twilio number to call from (E.164) |
| `PUBLIC_BASE_URL` | Public URL Twilio posts webhooks to |
| `PORT` | Local port for the webhook server (default 3000) |
| `RECORD_MAX_LENGTH` | Max seconds to record the response (default 60) |
| `CALL_TIMEOUT_MS` | Give up on a call after this long (default 180000) |
| `DELAY_BETWEEN_CALLS_MS` | Pause between calls (default 2000) |
| `TRANSCRIPTION_GRACE_MS` | Wait for transcription after a call completes |

## Notes & limitations

- **Transcription:** Twilio's built-in transcription works best for English
  recordings under ~2 minutes. For other languages or longer calls, swap the
  transcription step in `src/server.js` for a dedicated speech-to-text service.
- **Legal / consent:** Recording phone calls is regulated and consent
  requirements vary by jurisdiction. You are responsible for complying with all
  applicable laws (e.g. one-/two-party consent), telemarketing rules, and for
  only calling numbers you are authorized to contact.
- **Sequential by design:** numbers are called one at a time. Parallel dialing
  would require coordinating multiple in-flight calls and is intentionally out of
  scope for this MVP.

## License

MIT
