/**
 * Mock telephony provider for dry-run mode and tests.
 *
 * It never places a real call. Instead it generates a plausible transcript of
 * "what the automated system said" and publishes it onto the ResultBus after a
 * short delay, mimicking Twilio's asynchronous transcription callback.
 */
export class MockTelephony {
  constructor({ resultBus, scripts = {}, delayMs = 50 } = {}) {
    this.resultBus = resultBus;
    this.scripts = scripts;
    this.delayMs = delayMs;
    this.counter = 0;
  }

  async placeCall({ to }) {
    this.counter += 1;
    const callSid = `MOCK${String(this.counter).padStart(6, '0')}`;

    setTimeout(() => {
      const scripted = this.scripts[to];
      const transcript =
        scripted ??
        `Thank you for calling. Your reference number is ${Math.floor(
          100000 + Math.random() * 900000
        )}. Goodbye.`;
      this.resultBus.publish(callSid, { source: 'transcription', transcript });
    }, this.delayMs);

    return callSid;
  }
}
