import { loadConfig, assertLiveConfig } from './config.js';
import { logger } from './logger.js';
import { ResultBus } from './resultBus.js';
import { runCampaign } from './orchestrator.js';
import { MockTelephony } from './telephony/mock.js';
import { MockSheets } from './sheets/mock.js';

async function main() {
  const config = loadConfig();
  const resultBus = new ResultBus({ transcriptionGraceMs: config.transcriptionGraceMs });

  if (config.dryRun) {
    logger.info('Starting in DRY-RUN mode (mock telephony + local JSON sheet).');
    const sheets = new MockSheets({ path: config.mockSheetPath });
    const telephony = new MockTelephony({ resultBus });
    const summary = await runCampaign({ sheets, telephony, resultBus, config, logger });
    logger.info('Dry run complete.', summary);
    return;
  }

  // ── Live run ───────────────────────────────────────────────────────────────
  assertLiveConfig(config);

  // Defer heavy imports so dry-run/tests don't need these dependencies installed.
  const { GoogleSheets } = await import('./sheets/google.js');
  const { TwilioTelephony } = await import('./telephony/twilio.js');
  const { createServer } = await import('./server.js');

  const sheets = new GoogleSheets({
    credentialsPath: config.googleCredentialsPath,
    sheetId: config.sheetId,
    sheetName: config.sheetName,
    columns: config.columns,
  });
  await sheets.init();

  const telephony = new TwilioTelephony({
    accountSid: config.twilio.accountSid,
    authToken: config.twilio.authToken,
    fromNumber: config.twilio.fromNumber,
    publicBaseUrl: config.publicBaseUrl,
  });

  const app = createServer({
    resultBus,
    publicBaseUrl: config.publicBaseUrl,
    recordMaxLength: config.recordMaxLength,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, () => {
      logger.info(`Webhook server listening on port ${config.port}.`);
      logger.info(`Twilio must be able to reach it at ${config.publicBaseUrl}`);
      resolve(s);
    });
  });

  try {
    const summary = await runCampaign({ sheets, telephony, resultBus, config, logger });
    logger.info('Campaign complete.', summary);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exitCode = 1;
});
