import test from 'node:test';
import assert from 'node:assert/strict';

import { runCampaign } from '../src/orchestrator.js';
import { ResultBus } from '../src/resultBus.js';
import { MockTelephony } from '../src/telephony/mock.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function fakeSheets(rows) {
  const state = rows.map((r, i) => ({
    rowNumber: i + 2,
    phone: r.phone || '',
    status: r.status || '',
    result: r.result || '',
  }));
  return {
    state,
    async listRows() {
      return state.map((r) => ({ ...r }));
    },
    async updateRow(rowNumber, fields) {
      const row = state.find((r) => r.rowNumber === rowNumber);
      Object.assign(row, fields);
    },
  };
}

const baseConfig = { callTimeoutMs: 2000, delayBetweenCallsMs: 0 };

test('calls each pending number and writes the transcript back', async () => {
  const sheets = fakeSheets([
    { phone: '+15551110001' },
    { phone: '+15551110002' },
  ]);
  const resultBus = new ResultBus({ transcriptionGraceMs: 50 });
  const telephony = new MockTelephony({
    resultBus,
    scripts: {
      '+15551110001': 'Your account balance is forty dollars.',
      '+15551110002': 'Press one for sales.',
    },
  });

  const summary = await runCampaign({ sheets, telephony, resultBus, config: baseConfig, logger: silentLogger });

  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(sheets.state[0].status, 'completed');
  assert.equal(sheets.state[0].result, 'Your account balance is forty dollars.');
  assert.equal(sheets.state[1].result, 'Press one for sales.');
});

test('skips empty rows and rows that are already processed', async () => {
  const sheets = fakeSheets([
    { phone: '+15551110001', status: 'completed', result: 'done before' },
    { phone: '' },
    { phone: '+15551110003' },
  ]);
  const resultBus = new ResultBus({ transcriptionGraceMs: 50 });
  const telephony = new MockTelephony({ resultBus, scripts: { '+15551110003': 'Hello there.' } });

  const summary = await runCampaign({ sheets, telephony, resultBus, config: baseConfig, logger: silentLogger });

  assert.equal(summary.total, 1);
  assert.equal(sheets.state[0].result, 'done before', 'already-processed row left untouched');
  assert.equal(sheets.state[2].status, 'completed');
  assert.equal(sheets.state[2].result, 'Hello there.');
});

test('records a non-completed status when a call fails', async () => {
  const sheets = fakeSheets([{ phone: '+15551110009' }]);
  const resultBus = new ResultBus({ transcriptionGraceMs: 50 });
  const telephony = {
    async placeCall() {
      const sid = 'FAIL01';
      setTimeout(() => resultBus.publish(sid, { source: 'failure', status: 'no-answer' }), 10);
      return sid;
    },
  };

  const summary = await runCampaign({ sheets, telephony, resultBus, config: baseConfig, logger: silentLogger });

  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(sheets.state[0].status, 'no-answer');
  assert.equal(sheets.state[0].result, '(no-answer)');
});

test('settles with a timeout when no result ever arrives', async () => {
  const sheets = fakeSheets([{ phone: '+15551110010' }]);
  const resultBus = new ResultBus({ transcriptionGraceMs: 50 });
  const telephony = {
    async placeCall() {
      return 'NORESULT';
    },
  };

  const summary = await runCampaign({
    sheets,
    telephony,
    resultBus,
    config: { callTimeoutMs: 80, delayBetweenCallsMs: 0 },
    logger: silentLogger,
  });

  assert.equal(summary.failed, 1);
  assert.equal(sheets.state[0].status, 'timeout');
});
