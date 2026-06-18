const DONE_STATUSES = new Set(['completed', 'done', 'called', 'failed', 'busy', 'no-answer']);

function isAlreadyProcessed(status) {
  if (!status) return false;
  return DONE_STATUSES.has(String(status).trim().toLowerCase());
}

function truncate(text, max = 120) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk the sheet one row at a time: place a call, wait for the result, write it
 * back, then move on to the next number.
 *
 * @param {object} deps
 * @param {object} deps.sheets       - read/write sheet adapter (Google or mock)
 * @param {object} deps.telephony    - placeCall({to}) -> callSid
 * @param {object} deps.resultBus    - waitFor(callSid, timeoutMs) -> result
 * @param {object} deps.config
 * @param {object} deps.logger
 * @param {function} [deps.onProgress] - optional callback after each row
 */
export async function runCampaign({ sheets, telephony, resultBus, config, logger, onProgress }) {
  const rows = await sheets.listRows();
  const pending = rows.filter((row) => row.phone && !isAlreadyProcessed(row.status));

  logger.info(
    `Loaded ${rows.length} row(s); ${pending.length} number(s) to call ` +
      `(${rows.length - pending.length} skipped as empty or already processed).`
  );

  const summary = { total: pending.length, completed: 0, failed: 0 };

  for (let i = 0; i < pending.length; i += 1) {
    const row = pending[i];
    logger.info(`(${i + 1}/${pending.length}) Calling ${row.phone} [row ${row.rowNumber}]`);

    await sheets.updateRow(row.rowNumber, { status: 'calling', result: '' });

    let result;
    try {
      const callSid = await telephony.placeCall({ to: row.phone });
      result = await resultBus.waitFor(callSid, config.callTimeoutMs);
    } catch (err) {
      logger.error(`Call to ${row.phone} errored: ${err.message}`);
      result = { status: 'error', transcript: err.message };
    }

    if (result.status === 'completed') summary.completed += 1;
    else summary.failed += 1;

    const resultText = result.transcript?.trim() ? result.transcript.trim() : `(${result.status})`;
    await sheets.updateRow(row.rowNumber, { status: result.status, result: resultText });

    logger.info(`  -> ${result.status}: ${truncate(resultText)}`);
    if (onProgress) onProgress({ row, result, index: i });

    if (i < pending.length - 1 && config.delayBetweenCallsMs) {
      await sleep(config.delayBetweenCallsMs);
    }
  }

  logger.info(
    `Campaign finished: ${summary.completed} completed, ${summary.failed} failed, ` +
      `out of ${summary.total} call(s).`
  );
  return summary;
}
