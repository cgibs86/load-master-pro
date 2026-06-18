/**
 * Auto Dialer for Google Sheets
 * ---------------------------------------------------------------------------
 * Works down a sheet of phone numbers one at a time: calls each number through
 * Twilio, records and transcribes what the automated system on the other end
 * says, writes that transcript back into the sheet, then moves to the next row.
 *
 * The whole thing lives inside the spreadsheet. After you add this script and
 * deploy it once as a Web App, every copy of the sheet gets an "☎️ Auto Dialer"
 * menu. See README.md in this folder for the 5-minute setup.
 *
 * Design note: Apps Script can't hold a long-running loop open while it waits
 * for a phone call to finish. Instead the flow is event-driven and sequential:
 *
 *   Start dialing ─▶ dialNext_() places ONE call
 *                          │
 *        Twilio records + transcribes the far end
 *                          │
 *   doPost(?action=transcription) writes the result back ─▶ dialNext_() again
 *
 * Each finished call kicks off the next one, so numbers are dialed strictly one
 * at a time until the list is done or you press "Stop dialing".
 */

var PROP = PropertiesService.getScriptProperties();

// Row statuses that mean "don't (re)dial this row".
var TERMINAL_STATUSES = [
  'completed', 'done', 'called', 'failed', 'busy',
  'no-answer', 'canceled', 'calling', 'timeout', 'error'
];

/* ───────────────────────────── Menu / UI ──────────────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('☎️ Auto Dialer')
    .addItem('Start dialing', 'startDialing')
    .addItem('Stop dialing', 'stopDialing')
    .addSeparator()
    .addItem('Settings…', 'showSettings')
    .addItem('Reset statuses', 'resetStatuses')
    .addToUi();
}

function showSettings() {
  var html = HtmlService.createHtmlOutputFromFile('Settings')
    .setWidth(440)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Auto Dialer Settings');
}

/** Called from Settings.html via google.script.run. */
function getSettings() {
  var p = PROP.getProperties();
  return {
    sid: p.TWILIO_SID || '',
    // Never send the real token back to the browser.
    tokenSet: !!p.TWILIO_TOKEN,
    from: p.TWILIO_FROM || '',
    phoneHeader: p.PHONE_HEADER || 'Phone',
    statusHeader: p.STATUS_HEADER || 'Status',
    resultHeader: p.RESULT_HEADER || 'Result',
    recordMax: Number(p.RECORD_MAX || 60),
    webAppUrl: getWebAppUrl_()
  };
}

/** Called from Settings.html via google.script.run. */
function saveSettings(cfg) {
  var updates = {
    TWILIO_SID: (cfg.sid || '').trim(),
    TWILIO_FROM: (cfg.from || '').trim(),
    PHONE_HEADER: (cfg.phoneHeader || 'Phone').trim(),
    STATUS_HEADER: (cfg.statusHeader || 'Status').trim(),
    RESULT_HEADER: (cfg.resultHeader || 'Result').trim(),
    RECORD_MAX: String(cfg.recordMax || 60)
  };
  // Only overwrite the token if the user actually typed a new one.
  if (cfg.token && cfg.token.trim()) {
    updates.TWILIO_TOKEN = cfg.token.trim();
  }
  PROP.setProperties(updates, false);
  return getSettings();
}

/* ──────────────────────────── Dial control ────────────────────────────── */

function startDialing() {
  var ui = SpreadsheetApp.getUi();
  var p = PROP.getProperties();

  if (!p.TWILIO_SID || !p.TWILIO_TOKEN || !p.TWILIO_FROM) {
    ui.alert('Missing Twilio settings', 'Open ☎️ Auto Dialer ▸ Settings and add your Twilio Account SID, Auth Token, and From number first.', ui.ButtonSet.OK);
    return;
  }
  if (!getWebAppUrl_()) {
    ui.alert('Deploy as a Web App first', 'Twilio needs a public URL to call back. In the Apps Script editor choose Deploy ▸ New deployment ▸ Web app (Execute as: Me, Who has access: Anyone), then reopen the sheet and try again.', ui.ButtonSet.OK);
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();

  // Validate the columns now so the user gets an error in the UI, not silently.
  try {
    resolveColumns_(sheet);
  } catch (err) {
    ui.alert('Sheet not ready', err.message, ui.ButtonSet.OK);
    return;
  }

  PROP.setProperty('ACTIVE_TARGET', JSON.stringify({ ssId: ss.getId(), sheetName: sheet.getName() }));
  PROP.setProperty('DIALING', 'true');

  var placed = dialNext_();
  if (placed) {
    ui.alert('Auto Dialer started', 'Calling the first number now. Results will appear in the sheet as each call finishes. Use ☎️ Auto Dialer ▸ Stop dialing to halt.', ui.ButtonSet.OK);
  } else {
    PROP.setProperty('DIALING', 'false');
    ui.alert('Nothing to dial', 'No rows with a phone number and an empty status were found.', ui.ButtonSet.OK);
  }
}

function stopDialing() {
  PROP.setProperty('DIALING', 'false');
  SpreadsheetApp.getUi().alert('Auto Dialer stopped. The call in progress (if any) will finish, but no new calls will start.');
}

/**
 * Place a call for the next pending row. Returns true if a call was placed.
 * Called both from the menu (to start) and from the webhook (to continue).
 */
function dialNext_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (PROP.getProperty('DIALING') !== 'true') return false;

    var target = JSON.parse(PROP.getProperty('ACTIVE_TARGET') || '{}');
    if (!target.ssId) return false;

    var sheet = SpreadsheetApp.openById(target.ssId).getSheetByName(target.sheetName);
    if (!sheet) { PROP.setProperty('DIALING', 'false'); return false; }

    var cols = resolveColumns_(sheet);
    var row = findNextPendingRow_(sheet, cols);
    if (!row) {
      PROP.setProperty('DIALING', 'false'); // reached the end of the list
      return false;
    }

    var phone = normalizePhone_(sheet.getRange(row, cols.phone).getValue());
    sheet.getRange(row, cols.status).setValue('calling');
    sheet.getRange(row, cols.result).setValue('');
    SpreadsheetApp.flush();

    try {
      var sid = placeCall_(phone);
      PROP.setProperty('call_' + sid, JSON.stringify({
        ssId: target.ssId, sheetName: target.sheetName, row: row
      }));
      return true;
    } catch (err) {
      // Record the failure on this row and move on so one bad number can't stall
      // the whole run.
      sheet.getRange(row, cols.status).setValue('error');
      sheet.getRange(row, cols.result).setValue(String(err.message || err));
      SpreadsheetApp.flush();
      return dialNext_();
    }
  } finally {
    lock.releaseLock();
  }
}

function resetStatuses() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Reset Auto Dialer', 'Clear the Status and Result columns for every data row in the active sheet?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  var sheet = SpreadsheetApp.getActiveSheet();
  var cols = resolveColumns_(sheet);
  var last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, cols.status, last - 1, 1).clearContent();
    sheet.getRange(2, cols.result, last - 1, 1).clearContent();
  }

  // Drop any leftover call→row mappings and stop dialing.
  var props = PROP.getProperties();
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('call_') === 0) PROP.deleteProperty(k);
  });
  PROP.setProperty('DIALING', 'false');
  SpreadsheetApp.flush();
}

/* ─────────────────────────── Sheet helpers ────────────────────────────── */

function resolveColumns_(sheet) {
  var p = PROP.getProperties();
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error('The sheet appears to be empty.');

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });

  function idx(name) {
    var i = headers.indexOf(String(name).trim().toLowerCase());
    if (i === -1) {
      throw new Error('Could not find a "' + name + '" column in row 1. ' +
        'Expected header columns: ' + (p.PHONE_HEADER || 'Phone') + ', ' +
        (p.STATUS_HEADER || 'Status') + ', ' + (p.RESULT_HEADER || 'Result') + '.');
    }
    return i + 1; // 1-based for getRange
  }

  return {
    phone: idx(p.PHONE_HEADER || 'Phone'),
    status: idx(p.STATUS_HEADER || 'Status'),
    result: idx(p.RESULT_HEADER || 'Result')
  };
}

function findNextPendingRow_(sheet, cols) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var count = last - 1;
  var statuses = sheet.getRange(2, cols.status, count, 1).getValues();
  var phones = sheet.getRange(2, cols.phone, count, 1).getValues();

  for (var i = 0; i < count; i++) {
    var phone = String(phones[i][0]).trim();
    var status = String(statuses[i][0]).trim().toLowerCase();
    if (phone && TERMINAL_STATUSES.indexOf(status) === -1) {
      return i + 2; // 1-based row number
    }
  }
  return 0;
}

function normalizePhone_(value) {
  var s = String(value).trim();
  // Google Sheets sometimes stores numbers as floats (e.g. 15551234567).
  s = s.replace(/\s+/g, '');
  return s;
}

function getWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/* ───────────────────────────── Twilio ─────────────────────────────────── */

function placeCall_(toNumber) {
  var p = PROP.getProperties();
  var webApp = getWebAppUrl_();
  var endpoint = 'https://api.twilio.com/2010-04-01/Accounts/' + p.TWILIO_SID + '/Calls.json';

  var payload = {
    To: toNumber,
    From: p.TWILIO_FROM,
    Url: webApp + '?action=voice',
    Method: 'GET',
    StatusCallback: webApp + '?action=status',
    StatusCallbackMethod: 'POST',
    Timeout: '30',
    Record: 'true'
  };

  var res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    payload: payload,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(p.TWILIO_SID + ':' + p.TWILIO_TOKEN)
    },
    muteHttpExceptions: true
  });

  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }

  if (res.getResponseCode() >= 300) {
    throw new Error('Twilio error: ' + (body.message || res.getContentText()));
  }
  return body.sid;
}

/* ─────────────────── Web App: Twilio webhooks ─────────────────────────── */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'voice') return voiceTwiml_();
  return ContentService.createTextOutput('Auto Dialer web app is running.');
}

function doPost(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'voice') return voiceTwiml_();
  if (action === 'transcription') return handleTranscription_(e);
  if (action === 'status') return handleStatus_(e);
  return ContentService.createTextOutput('ok');
}

/** TwiML telling Twilio to record + transcribe the far end (the automated system). */
function voiceTwiml_() {
  var p = PROP.getProperties();
  var webApp = getWebAppUrl_();
  var maxLen = p.RECORD_MAX || '60';
  var xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Record maxLength="' + maxLen + '" timeout="5" playBeep="false" ' +
      'transcribe="true" transcribeCallback="' + webApp + '?action=transcription"/>' +
    '</Response>';
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.XML);
}

function handleTranscription_(e) {
  var params = e.parameter || {};
  var text = params.TranscriptionText || '';
  var resultText = text.trim() ? text.trim() : '(no speech detected)';
  writeResultForCall_(params.CallSid, 'completed', resultText);
  dialNext_(); // continue to the next number
  return ContentService.createTextOutput('');
}

function handleStatus_(e) {
  var params = e.parameter || {};
  var status = String(params.CallStatus || '').toLowerCase();
  // 'completed' is handled by the transcription callback (it carries the text).
  if (['no-answer', 'busy', 'failed', 'canceled'].indexOf(status) !== -1) {
    writeResultForCall_(params.CallSid, status, '(' + status + ')');
    dialNext_();
  }
  return ContentService.createTextOutput('');
}

/**
 * Write a call's outcome back to the row it came from. Guarded so the status and
 * transcription callbacks can't both write (only the row still marked "calling"
 * is updated), and the mapping is cleared afterwards.
 */
function writeResultForCall_(sid, status, result) {
  if (!sid) return;
  var key = 'call_' + sid;
  var raw = PROP.getProperty(key);
  if (!raw) return;

  var map = JSON.parse(raw);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Re-read inside the lock in case the other callback already handled it.
    if (!PROP.getProperty(key)) return;

    var sheet = SpreadsheetApp.openById(map.ssId).getSheetByName(map.sheetName);
    if (sheet) {
      var cols = resolveColumns_(sheet);
      var cur = String(sheet.getRange(map.row, cols.status).getValue()).trim().toLowerCase();
      if (cur === 'calling' || cur === '') {
        sheet.getRange(map.row, cols.status).setValue(status);
        sheet.getRange(map.row, cols.result).setValue(result);
        SpreadsheetApp.flush();
      }
    }
    PROP.deleteProperty(key);
  } finally {
    lock.releaseLock();
  }
}
