import type { AudioMimeType } from "@clarkcant/contracts";

/**
 * What an audio file is, and how long it plays, read from its bytes.
 *
 * The media content policy decides from the bytes rather than from what a server called them: a declared type is a
 * claim, and a file the browser would play as something else is refused before it is stored. The duration is read the
 * same way, from the container's own header, so a file over the policy's ceiling is refused before a person presses
 * play rather than discovered an hour in. A container whose duration cannot be read is reported as unknown, and the
 * caller refuses it: a bound that cannot be checked is not a bound.
 *
 * No decoder and no dependency: each format keeps its length in a header a few bytes long.
 */

export function sniffAudio(bytes: Uint8Array): AudioMimeType | undefined {
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 0, Math.min(bytes.byteLength, 64)).includes("webm") ? "audio/webm" : undefined;
  }
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  return mpegFrame(bytes, 0) === undefined ? undefined : "audio/mpeg";
}

/** Seconds, or undefined when the container does not say. */
export function audioDurationSeconds(bytes: Uint8Array, mime: AudioMimeType): number | undefined {
  const seconds =
    mime === "audio/wav" ? wavDuration(bytes) : mime === "audio/ogg" ? oggDuration(bytes) : mime === "audio/webm" ? webmDuration(bytes) : mp3Duration(bytes);
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let index = at; index < at + length && index < bytes.byteLength; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A PCM WAV: the data chunk's size over the format's byte rate. */
function wavDuration(bytes: Uint8Array): number | undefined {
  const data = view(bytes);
  let byteRate = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(bytes, at, 4);
    const size = data.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= bytes.byteLength) byteRate = data.getUint32(at + 16, true);
    if (id === "data") {
      if (byteRate === 0) return undefined;
      // A streamed WAV may write the largest size it can rather than the real one; what arrived is what plays.
      const available = bytes.byteLength - (at + 8);
      return Math.min(size, available) / byteRate;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** An Ogg stream: the last page's granule position over the codec's rate (Opus always counts at 48 kHz). */
function oggDuration(bytes: Uint8Array): number | undefined {
  const data = view(bytes);
  let rate = 0;
  let preSkip = 0;
  const head = ascii(bytes, 0, Math.min(bytes.byteLength, 512));
  const opus = head.indexOf("OpusHead");
  const vorbis = head.indexOf("\u0001vorbis");
  if (opus !== -1 && opus + 12 <= bytes.byteLength) {
    rate = 48_000;
    preSkip = data.getUint16(opus + 10, true);
  } else if (vorbis !== -1 && vorbis + 16 <= bytes.byteLength) {
    rate = data.getUint32(vorbis + 12, true);
  }
  if (rate === 0) return undefined;
  for (let at = bytes.byteLength - 14; at >= 0; at -= 1) {
    if (bytes[at] !== 0x4f || ascii(bytes, at, 4) !== "OggS") continue;
    const granule = data.getBigUint64(at + 6, true);
    // All ones means "no packet ends on this page"; an earlier page says where the stream got to.
    if (granule === 0xffffffffffffffffn) continue;
    return Math.max(0, Number(granule) - preSkip) / rate;
  }
  return undefined;
}

/** An EBML variable-length integer: its value and how many bytes it took, or undefined past the end. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || at + length > bytes.byteLength) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const CLUSTER = 0x1f43b675;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

/** A WebM file: the segment info's Duration, in its timecode scale. Recorded streams that never wrote one are unknown. */
function webmDuration(bytes: Uint8Array): number | undefined {
  const data = view(bytes);
  let at = 0;
  let end = bytes.byteLength;
  while (at < end) {
    const id = vint(bytes, at, true);
    if (id === undefined) return undefined;
    const size = vint(bytes, at + id.length, false);
    if (size === undefined) return undefined;
    const body = at + id.length + size.length;
    if (id.value === SEGMENT) {
      // Step into the segment; its size may be unknown when it was written as a stream.
      at = body;
      end = size.unknown ? bytes.byteLength : Math.min(bytes.byteLength, body + size.value);
      continue;
    }
    if (id.value === CLUSTER) return undefined;
    if (id.value === INFO) {
      let scale = 1_000_000;
      let duration: number | undefined;
      const infoEnd = Math.min(bytes.byteLength, body + size.value);
      let child = body;
      while (child < infoEnd) {
        const childId = vint(bytes, child, true);
        if (childId === undefined) return undefined;
        const childSize = vint(bytes, child + childId.length, false);
        if (childSize === undefined) return undefined;
        const value = child + childId.length + childSize.length;
        if (value + childSize.value > bytes.byteLength) return undefined;
        if (childId.value === TIMECODE_SCALE) {
          let read = 0;
          for (let index = 0; index < childSize.value; index += 1) read = read * 256 + (bytes[value + index] ?? 0);
          if (read > 0) scale = read;
        }
        if (childId.value === DURATION) {
          if (childSize.value === 4) duration = data.getFloat32(value);
          else if (childSize.value === 8) duration = data.getFloat64(value);
        }
        child = value + childSize.value;
      }
      return duration === undefined ? undefined : (duration * scale) / 1e9;
    }
    if (id.value !== EBML_HEADER && size.unknown) return undefined;
    at = body + size.value;
  }
  return undefined;
}

interface MpegFrame {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  mono: boolean;
  samplesPerFrame: number;
}

const BITRATES: Readonly<Record<string, readonly number[]>> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** An MPEG audio frame header at `at`, or undefined when the four bytes there are not one. */
function mpegFrame(bytes: Uint8Array, at: number): MpegFrame | undefined {
  const b1 = bytes[at];
  const b2 = bytes[at + 1];
  const b3 = bytes[at + 2];
  const b4 = bytes[at + 3];
  if (b1 !== 0xff || b2 === undefined || b3 === undefined || b4 === undefined || (b2 & 0xe0) !== 0xe0) return undefined;
  const versionBits = (b2 >> 3) & 0x03;
  const layerBits = (b2 >> 1) & 0x03;
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const rateIndex = (b3 >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const bitrateKbps = BITRATES[`${version === 1 ? 1 : 2}-${String(layer)}`]?.[bitrateIndex] ?? 0;
  const baseRate = [44_100, 48_000, 32_000][rateIndex] ?? 0;
  const sampleRate = version === 1 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  return { version, layer, bitrateKbps, sampleRate, mono: ((b4 >> 6) & 0x03) === 3, samplesPerFrame };
}

/** Where the audio starts: after an ID3v2 tag when there is one. */
function id3Length(bytes: Uint8Array): number {
  if (ascii(bytes, 0, 3) !== "ID3" || bytes.byteLength < 10) return 0;
  const size = (((bytes[6] ?? 0) & 0x7f) << 21) | (((bytes[7] ?? 0) & 0x7f) << 14) | (((bytes[8] ?? 0) & 0x7f) << 7) | ((bytes[9] ?? 0) & 0x7f);
  const footer = ((bytes[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** An MP3: the frame count a Xing, Info or VBRI header records, or a constant bitrate's length over its rate. */
function mp3Duration(bytes: Uint8Array): number | undefined {
  const start = id3Length(bytes);
  // A tag may be followed by a little padding before the first frame.
  let at = start;
  const limit = Math.min(bytes.byteLength - 4, start + 4_096);
  while (at <= limit && mpegFrame(bytes, at) === undefined) at += 1;
  const frame = mpegFrame(bytes, at);
  if (frame === undefined || frame.sampleRate === 0) return undefined;
  const data = view(bytes);
  const sideInfo = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = at + 4 + sideInfo;
  const tag = ascii(bytes, xing, 4);
  if ((tag === "Xing" || tag === "Info") && xing + 12 <= bytes.byteLength && (data.getUint32(xing + 4) & 0x1) !== 0) {
    return (data.getUint32(xing + 8) * frame.samplesPerFrame) / frame.sampleRate;
  }
  const vbri = at + 4 + 32;
  if (ascii(bytes, vbri, 4) === "VBRI" && vbri + 18 <= bytes.byteLength) {
    return (data.getUint32(vbri + 14) * frame.samplesPerFrame) / frame.sampleRate;
  }
  if (frame.bitrateKbps === 0) return undefined;
  return ((bytes.byteLength - at) * 8) / (frame.bitrateKbps * 1000);
}
