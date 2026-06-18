// Load a .env file if dotenv is installed. It's optional so that dry-run mode
// and the test suite work without installing any dependencies.
try {
  await import('dotenv/config');
} catch {
  // dotenv not installed — fall back to the ambient process environment.
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    dryRun: bool(env.DRY_RUN, false),

    // Google Sheets
    googleCredentialsPath: env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json',
    sheetId: env.SHEET_ID || '',
    sheetName: env.SHEET_NAME || 'Sheet1',
    columns: {
      phone: env.PHONE_COLUMN || 'Phone',
      status: env.STATUS_COLUMN || 'Status',
      result: env.RESULT_COLUMN || 'Result',
    },

    // Twilio
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      fromNumber: env.TWILIO_FROM_NUMBER || '',
    },

    // Webhooks / server
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    port: int(env.PORT, 3000),

    // Tuning
    recordMaxLength: int(env.RECORD_MAX_LENGTH, 60),
    callTimeoutMs: int(env.CALL_TIMEOUT_MS, 180000),
    delayBetweenCallsMs: int(env.DELAY_BETWEEN_CALLS_MS, 2000),
    transcriptionGraceMs: int(env.TRANSCRIPTION_GRACE_MS, 20000),

    // Dry-run
    mockSheetPath: env.MOCK_SHEET_PATH || './data/sample-sheet.json',
  };
}

/**
 * Throws a helpful error if required configuration is missing for a live run.
 */
export function assertLiveConfig(config) {
  const missing = [];
  if (!config.sheetId) missing.push('SHEET_ID');
  if (!config.twilio.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.twilio.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.twilio.fromNumber) missing.push('TWILIO_FROM_NUMBER');
  if (!config.publicBaseUrl) missing.push('PUBLIC_BASE_URL');

  if (missing.length) {
    throw new Error(
      `Missing required configuration for a live run: ${missing.join(', ')}.\n` +
        'Fill these in your .env file, or run in dry-run mode with DRY_RUN=true.'
    );
  }
}
