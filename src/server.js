import express from 'express';
import twilio from 'twilio';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Express app that serves Twilio's call instructions (TwiML) and receives its
 * callbacks. All outcomes are forwarded to the shared ResultBus, keyed by CallSid.
 *
 *   POST /voice         -> TwiML telling Twilio to record + transcribe the call
 *   POST /transcription -> the transcribed text of what the automated system said
 *   POST /status        -> call lifecycle events (busy, no-answer, completed, ...)
 */
export function createServer({ resultBus, publicBaseUrl, recordMaxLength }) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/voice', (_req, res) => {
    const vr = new VoiceResponse();
    // Record the far end (the automated system) and ask Twilio to transcribe it.
    vr.record({
      maxLength: recordMaxLength,
      timeout: 5,
      playBeep: false,
      transcribe: true,
      transcribeCallback: `${publicBaseUrl}/transcription`,
    });
    res.type('text/xml').send(vr.toString());
  });

  app.post('/transcription', (req, res) => {
    const { CallSid, TranscriptionText, RecordingUrl } = req.body;
    if (CallSid) {
      resultBus.publish(CallSid, {
        source: 'transcription',
        transcript: TranscriptionText || '',
        recordingUrl: RecordingUrl,
      });
    }
    res.sendStatus(204);
  });

  app.post('/status', (req, res) => {
    const { CallSid, CallStatus, RecordingUrl } = req.body;
    if (CallSid) {
      if (['no-answer', 'busy', 'failed', 'canceled'].includes(CallStatus)) {
        resultBus.publish(CallSid, { source: 'failure', status: CallStatus });
      } else if (CallStatus === 'completed') {
        // Hold briefly for the async transcription before settling.
        resultBus.markCompleted(CallSid, RecordingUrl);
      }
    }
    res.sendStatus(204);
  });

  return app;
}
