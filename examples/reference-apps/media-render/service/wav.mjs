/*
 * The render's own transform: gain and trim on 16-bit PCM WAV, in plain JavaScript.
 *
 * Pure functions over bytes, so the same code runs in the service container, in a unit test and nowhere else needs to
 * agree with it. The service streams the input a chunk at a time and calls `applyGain` on each, so memory holds the
 * output and one chunk, never the input twice.
 */

/** Bytes read from the start of a file to find its format and where its samples start. */
export const WAV_HEADER_BYTES = 4096;

const GAIN_DB_MIN = -24;
const GAIN_DB_MAX = 12;

function text(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Read a WAV file's format and the place of its samples from its first bytes.
 *
 * Only what this tool renders is accepted: uncompressed PCM, 16 bits, one or two channels. Anything else is refused
 * with the sentence a person reads, rather than rendered into noise.
 */
export function parseWavHeader(head, totalBytes) {
  if (head.byteLength < 12 || text(head, 0, 4) !== "RIFF" || text(head, 8, 4) !== "WAVE") {
    return { ok: false, reason: "the file is not a WAV file" };
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 12;
  let format;
  while (offset + 8 <= head.byteLength) {
    const id = text(head, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > head.byteLength) break;
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (format === undefined) return { ok: false, reason: "the WAV file has its samples before its format" };
      if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
        return { ok: false, reason: "only uncompressed 16-bit PCM WAV can be rendered" };
      }
      if (format.channels < 1 || format.channels > 2 || format.blockAlign !== format.channels * 2) {
        return { ok: false, reason: "only mono or stereo WAV can be rendered" };
      }
      if (format.sampleRate < 8000 || format.sampleRate > 192000) {
        return { ok: false, reason: "the WAV file's sample rate is outside 8–192 kHz" };
      }
      const available = Math.max(0, totalBytes - body);
      const dataBytes = Math.min(size, available) - (Math.min(size, available) % format.blockAlign);
      const frames = dataBytes / format.blockAlign;
      return {
        ok: true,
        format: { channels: format.channels, sampleRate: format.sampleRate, blockAlign: format.blockAlign },
        dataOffset: body,
        dataBytes,
        frames,
        durationSeconds: frames / format.sampleRate,
      };
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  return { ok: false, reason: `the WAV file's samples do not start within its first ${String(WAV_HEADER_BYTES)} bytes` };
}

/** Whether render parameters are ones this tool takes, as a sentence when they are not. */
export function checkRenderParameters(parameters) {
  const { gainDb, trimStartMs = 0, trimEndMs = 0 } = parameters;
  if (typeof gainDb !== "number" || !Number.isFinite(gainDb) || gainDb < GAIN_DB_MIN || gainDb > GAIN_DB_MAX) {
    return `gain must be between ${String(GAIN_DB_MIN)} and ${String(GAIN_DB_MAX)} dB`;
  }
  for (const [name, value] of [["trimStartMs", trimStartMs], ["trimEndMs", trimEndMs]]) {
    if (!Number.isInteger(value) || value < 0) return `${name} must be a whole number of milliseconds, at least 0`;
  }
  return undefined;
}

/**
 * Which bytes of the input become the output, and the factor each sample is multiplied by.
 *
 * Trim is whole frames, so a stereo pair is never split. A trim that leaves no sound is refused rather than rendered
 * into an empty file.
 */
export function renderPlan(header, parameters) {
  const problem = checkRenderParameters(parameters);
  if (problem !== undefined) return { ok: false, reason: problem };
  const { gainDb, trimStartMs = 0, trimEndMs = 0 } = parameters;
  const { sampleRate, blockAlign } = header.format;
  const skipStart = Math.min(header.frames, Math.round((trimStartMs * sampleRate) / 1000));
  const skipEnd = Math.min(header.frames, Math.round((trimEndMs * sampleRate) / 1000));
  const frames = header.frames - skipStart - skipEnd;
  if (frames <= 0) return { ok: false, reason: "the trim leaves no sound to render" };
  const start = header.dataOffset + skipStart * blockAlign;
  return {
    ok: true,
    start,
    end: start + frames * blockAlign,
    frames,
    gain: 10 ** (gainDb / 20),
    durationSeconds: frames / sampleRate,
  };
}

/** Multiply every 16-bit sample by `gain`, rounding and clipping to the format's range, into a new array. */
export function applyGain(pcm, gain) {
  const out = new Uint8Array(pcm.byteLength - (pcm.byteLength % 2));
  const input = new DataView(pcm.buffer, pcm.byteOffset, out.byteLength);
  const output = new DataView(out.buffer);
  for (let offset = 0; offset < out.byteLength; offset += 2) {
    const scaled = Math.round(input.getInt16(offset, true) * gain);
    output.setInt16(offset, scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled, true);
  }
  return out;
}

/** The 44-byte header of a PCM WAV file holding `dataBytes` of samples. */
export function wavHeader(format, dataBytes) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) header[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * format.blockAlign, true);
  view.setUint16(32, format.blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * A deterministic clip: a sine tone with a slow swell, so a waveform preview has a shape and a gain change shows.
 *
 * Used by the tests and the browser journey as the file a person picks; nothing in the render depends on it.
 */
export function fixtureClip({ seconds, sampleRate = 22050, channels = 1, frequency = 440, amplitude = 0.4 }) {
  const frames = Math.round(seconds * sampleRate);
  const blockAlign = channels * 2;
  const bytes = new Uint8Array(44 + frames * blockAlign);
  bytes.set(wavHeader({ channels, sampleRate, blockAlign }, frames * blockAlign), 0);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * time) / Math.max(seconds, 1));
    const value = Math.round(amplitude * swell * 32767 * Math.sin(2 * Math.PI * frequency * time));
    for (let channel = 0; channel < channels; channel += 1) view.setInt16(44 + frame * blockAlign + channel * 2, value, true);
  }
  return bytes;
}
