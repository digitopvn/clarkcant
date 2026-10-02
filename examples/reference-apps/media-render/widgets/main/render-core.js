/*
 * The media render widget's rules, apart from the page: what state it keeps, what a job snapshot means on screen, and
 * how a rendered WAV becomes a waveform. Pure, so a unit test reads the same answers the frame shows.
 */

/** The types the picker offers. The service renders 16-bit PCM WAV and refuses anything else with its reason. */
export const ACCEPTED_TYPES = ["audio/wav"];

export const RENDER_LIMITS = Object.freeze({
  /** One bridge read, as `artifacts@1` allows. */
  chunkBytes: 262_144,
  gainDbMin: -24,
  gainDbMax: 12,
  trimMaxMs: 7_200_000,
});

const OPEN_STATUSES = new Set(["queued", "running", "waiting"]);

/**
 * The gain field's attributes. A text keyboard, not a numeric one: the decimal keypad on iOS has no minus key and a
 * number field shows no stepper on touch, so a cut in gain (−24 to 0 dB, most of the range) could not be typed by touch.
 * The value is checked by `readParameters` instead.
 */
export const GAIN_INPUT = Object.freeze({
  type: "text",
  inputmode: "text",
  autocomplete: "off",
  spellcheck: "false",
  pattern: "[\\-\\u2212]?[0-9]+([.,][0-9]+)?",
});

/** What each job status reads as, when it has nothing more specific to say. */
export const STATUS_TEXT = Object.freeze({
  queued: "Đang xếp hàng…",
  running: "Đang dựng…",
  waiting: "Đang chờ…",
  completed: "Đã dựng xong.",
  failed: "Không dựng được.",
  cancelled: "Đã dừng; không có tệp kết quả nào.",
});

/** A render that completed but whose file the host could not keep: what failed, what is safe, what to do next. */
export const NO_FILE_KEPT =
  "Dịch vụ đã dựng xong nhưng host không giữ được tệp kết quả, thường vì đã hết dung lượng lưu tệp. Tệp gốc vẫn còn; hãy xoá bớt tệp đính kèm rồi dựng lại.";

/** The sentence a job's status reads as on screen. A completed job with no file says so rather than "rendered". */
export function statusText(view) {
  if (view.status === "completed" && view.output === undefined) return NO_FILE_KEPT;
  return STATUS_TEXT[view.status] ?? view.status;
}

/** A number as a person may type it on any keyboard: a typographic minus, a decimal comma, spaces around it. */
function typedNumber(value) {
  const text = String(value).trim().replace(/^−/, "-").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

/** The state the widget keeps, read defensively: anything the schema did not promise is dropped. */
export function readPersistedState(state) {
  const value = state !== null && typeof state === "object" ? state : {};
  const ref = (candidate) =>
    candidate !== null && typeof candidate === "object" && typeof candidate.artifactId === "string" ? candidate : null;
  const number = (candidate, fallback) => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback);
  return {
    source: ref(value.source),
    job: typeof value.job === "string" && /^job_/.test(value.job) ? value.job : null,
    output: ref(value.output),
    gainDb: number(value.gainDb, 0),
    trimStartMs: Math.trunc(number(value.trimStartMs, 0)),
    trimEndMs: Math.trunc(number(value.trimEndMs, 0)),
  };
}

/**
 * The render parameters from what the person typed, or the sentence saying what is wrong. Checked here so a mistyped
 * number is said next to the field; the service checks them again, because the widget is not what it trusts.
 */
export function readParameters(fields) {
  const gainDb = typedNumber(fields.gainDb);
  const trimStartMs = Number(fields.trimStartMs === "" ? 0 : fields.trimStartMs);
  const trimEndMs = Number(fields.trimEndMs === "" ? 0 : fields.trimEndMs);
  if (String(fields.gainDb).trim() === "" || !Number.isFinite(gainDb) || gainDb < RENDER_LIMITS.gainDbMin || gainDb > RENDER_LIMITS.gainDbMax) {
    return { ok: false, reason: `Âm lượng phải từ ${String(RENDER_LIMITS.gainDbMin)} đến ${String(RENDER_LIMITS.gainDbMax)} dB.` };
  }
  for (const value of [trimStartMs, trimEndMs]) {
    if (!Number.isInteger(value) || value < 0 || value > RENDER_LIMITS.trimMaxMs) {
      return { ok: false, reason: "Thời gian cắt phải là số mili giây nguyên, từ 0 trở lên." };
    }
  }
  return { ok: true, value: { gainDb, trimStartMs, trimEndMs } };
}

/**
 * What one job snapshot means on screen. Only a completed job's file is ever offered as the output: a cancelled or
 * failed render has none, and the view says so instead of showing an earlier file as this render's.
 */
export function jobView(snapshot) {
  const open = OPEN_STATUSES.has(snapshot.status);
  const total = snapshot.progress?.total;
  const current = snapshot.progress?.current ?? 0;
  const fraction = total !== undefined && total > 0 ? Math.min(1, current / total) : undefined;
  const output = snapshot.status === "completed" ? snapshot.resultRefs.find((ref) => ref.mimeType === "audio/wav") : undefined;
  return {
    open,
    status: snapshot.status,
    fraction,
    message: snapshot.progress?.message ?? "",
    output,
    error: snapshot.error,
    note: snapshot.output,
  };
}

/** Whether a job ending left no file to show, which a completed job without a WAV result also is. */
export function endedWithoutOutput(view) {
  return !view.open && view.output === undefined;
}

/** The format of a rendered file, from its first 44 bytes; the service always writes the canonical header. */
export function outputHeader(bytes) {
  if (bytes.byteLength < 44) return undefined;
  const text = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (text(0) !== "RIFF" || text(8) !== "WAVE" || text(12) !== "fmt " || text(36) !== "data") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 44);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const blockAlign = view.getUint16(32, true);
  const dataBytes = view.getUint32(40, true);
  if (view.getUint16(34, true) !== 16 || blockAlign !== channels * 2 || sampleRate === 0) return undefined;
  const frames = Math.floor(dataBytes / blockAlign);
  return { channels, sampleRate, blockAlign, dataBytes, frames, durationSeconds: frames / sampleRate };
}

/**
 * Folds the samples of a WAV, a chunk at a time, into `columns` min/max pairs of the first channel, so a preview of a
 * long file needs one pass and memory for its columns only.
 */
export function createPeaks(header, columns) {
  const min = new Float32Array(columns).fill(0);
  const max = new Float32Array(columns).fill(0);
  let frame = 0;
  let carry = new Uint8Array(0);
  return {
    min,
    max,
    /** Add the next bytes of the data section, in order. */
    add(chunk) {
      let bytes = chunk;
      if (carry.byteLength > 0) {
        bytes = new Uint8Array(carry.byteLength + chunk.byteLength);
        bytes.set(carry, 0);
        bytes.set(chunk, carry.byteLength);
      }
      const whole = bytes.byteLength - (bytes.byteLength % header.blockAlign);
      const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
      for (let offset = 0; offset < whole && frame < header.frames; offset += header.blockAlign) {
        const sample = view.getInt16(offset, true) / 32768;
        const column = Math.min(columns - 1, Math.floor((frame * columns) / header.frames));
        if (sample < min[column]) min[column] = sample;
        if (sample > max[column]) max[column] = sample;
        frame += 1;
      }
      carry = bytes.slice(whole);
    },
  };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} KiB`;
  return `${String(bytes)} B`;
}

export function formatSeconds(seconds) {
  return `${seconds.toFixed(1)} giây`;
}

/** The name a rendered copy is offered under: the source's name with "-render" before its extension. */
export function renderedName(sourceName) {
  const base = typeof sourceName === "string" && sourceName !== "" ? sourceName.replace(/\.wav$/i, "") : "clip";
  return `${base}-render.wav`;
}
