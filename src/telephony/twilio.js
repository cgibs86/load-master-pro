import twilio from 'twilio';

/**
 * Live telephony provider backed by Twilio.
 *
 * placeCall() kicks off an outbound call. Twilio then fetches the call's TwiML
 * from `${publicBaseUrl}/voice` (served by src/server.js), records what the
 * far end says, and posts a transcription back to `${publicBaseUrl}/transcription`.
 * Those webhooks publish the result onto the shared ResultBus.
 */
export class TwilioTelephony {
  constructor({ accountSid, authToken, fromNumber, publicBaseUrl }) {
    this.client = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
    this.publicBaseUrl = publicBaseUrl;
  }

  async placeCall({ to }) {
    const call = await this.client.calls.create({
      to,
      from: this.fromNumber,
      url: `${this.publicBaseUrl}/voice`,
      method: 'POST',
      statusCallback: `${this.publicBaseUrl}/status`,
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed', 'canceled'],
      statusCallbackMethod: 'POST',
      timeout: 30,
      record: true,
    });
    return call.sid;
  }
}
