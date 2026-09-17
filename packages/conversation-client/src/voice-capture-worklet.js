/* global AudioWorkletProcessor, registerProcessor */
/**
 * Microphone capture, as an `AudioWorklet` processor.
 *
 * A real file rather than a blob URL, because the app's Content-Security-Policy is
 * `script-src 'self'` and a blob is not `'self'`. That policy is not worth weakening so a worklet
 * can be built from a string: the string version was tried first, failed with an AbortError, and
 * the failure is recorded in the session report rather than worked around by loosening the policy.
 *
 * This file runs in the audio thread, not in the page: it has no imports, no bundler transform, and
 * only the globals the worklet scope provides. It does one thing — collect input samples and post
 * them in chunks of a known size — so the main thread is not woken for every 128-sample quantum.
 */

/** Frames per posted chunk. 2048 at 16 kHz is about 43 ms: fine for streaming, coarse for overhead. */
const CHUNK_SAMPLES = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet, or the graph is not being pulled: keep the processor alive and wait. Returning
    // false here would end the processor and the session would capture nothing for the rest of it.
    if (!channel) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this.chunk[this.filled] = channel[index];
      this.filled += 1;
      if (this.filled === this.chunk.length) {
        this.port.postMessage({ frame: this.chunk });
        // A fresh buffer each time: the posted one is handed to the main thread, and reusing it
        // would let the next chunk overwrite audio that has been sent but not yet read.
        this.chunk = new Float32Array(CHUNK_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("cc-capture", CaptureProcessor);
