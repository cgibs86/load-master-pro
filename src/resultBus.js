/**
 * Coordinates the asynchronous result of a single phone call.
 *
 * A call can finish in a few ways:
 *   - Twilio posts a transcription of what the automated system said.
 *   - The call ends without a transcription (busy / no-answer / failed).
 *   - The call "completes" but the transcription arrives a little later,
 *     so we hold a short grace window before settling.
 *
 * Both the real Twilio webhook server and the mock telephony provider publish
 * onto this bus, keyed by the Twilio Call SID, so the orchestrator can simply
 * `await resultBus.waitFor(callSid)` regardless of provider.
 */
export class ResultBus {
  constructor({ transcriptionGraceMs = 20000 } = {}) {
    this.transcriptionGraceMs = transcriptionGraceMs;
    this.pending = new Map();
  }

  waitFor(callSid, timeoutMs) {
    return new Promise((resolve) => {
      const entry = {
        resolve,
        settled: false,
        transcript: null,
        recordingUrl: null,
        graceTimer: null,
        timeoutTimer: null,
      };
      entry.timeoutTimer = setTimeout(() => {
        this._settle(callSid, {
          status: 'timeout',
          transcript: entry.transcript || '',
          recordingUrl: entry.recordingUrl,
        });
      }, timeoutMs);
      this.pending.set(callSid, entry);
    });
  }

  /**
   * Publish a terminal-ish event for a call.
   *   { source: 'transcription', transcript } -> settle as completed
   *   { source: 'failure', status }           -> settle immediately with status
   */
  publish(callSid, result) {
    const entry = this.pending.get(callSid);
    if (!entry || entry.settled) return;

    if (result.source === 'transcription') {
      entry.transcript = result.transcript || '';
      this._settle(callSid, {
        status: 'completed',
        transcript: entry.transcript,
        recordingUrl: result.recordingUrl || entry.recordingUrl,
      });
      return;
    }

    this._settle(callSid, {
      status: result.status || 'failed',
      transcript: result.transcript || '',
      recordingUrl: result.recordingUrl || entry.recordingUrl,
    });
  }

  /**
   * The call reached the "completed" status. Wait a grace period for the
   * transcription callback before settling with whatever we have.
   */
  markCompleted(callSid, recordingUrl) {
    const entry = this.pending.get(callSid);
    if (!entry || entry.settled || entry.graceTimer) return;
    entry.recordingUrl = recordingUrl || entry.recordingUrl;
    entry.graceTimer = setTimeout(() => {
      this._settle(callSid, {
        status: 'completed',
        transcript: entry.transcript || '',
        recordingUrl: entry.recordingUrl,
      });
    }, this.transcriptionGraceMs);
  }

  _settle(callSid, result) {
    const entry = this.pending.get(callSid);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timeoutTimer);
    clearTimeout(entry.graceTimer);
    this.pending.delete(callSid);
    entry.resolve(result);
  }
}
