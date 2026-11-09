import { CapabilityError } from './media';
import { pixelsOf, type MediaAccepts, type MediaKind, type MediaModel, type MediaSource } from './media-catalog';
import type { WaveSpeedModelInfo, WaveSpeedSchema } from './wavespeed-models';

/**
 * The one request shape for POST /v1/images/generations and POST /v1/videos, whatever provider serves the model.
 *
 * Images: model, prompt, n, size, image, seed, negative_prompt, response_format.
 * Videos: model, prompt, image (first frame), last_image, reference_images, audio, duration, resolution, ratio (or
 * aspect_ratio), seed, negative_prompt, camera_fixed.
 *
 * Each model declares what it takes (`accepts`, media-catalog.ts; for a WaveSpeed model outside the catalog, WaveSpeed's
 * listed schema). A field the model doesn't take is refused with a 400 naming what it does, never dropped, and so is a
 * missing input. BytePlus and OmniHuman models are mapped to their APIs by their providers; WaveSpeed models by
 * wavespeedRequestInput below, which also passes a model's own fields through by name.
 */

/** Sent by clients, never part of a generation. */
const IGNORED = new Set(['model', 'user', 'keyId']);

export type ImageRequestFields = {
  prompt: string; n: number; size?: string; image?: string | string[]; seed?: number; negative_prompt?: string; response_format?: 'url' | 'b64_json';
  /** How many input images were given. */
  inputImages: number;
};

export type VideoRequestFields = {
  prompt: string; image?: string; last_image?: string; reference_images?: string[]; audio?: string | string[];
  duration?: number; resolution?: string; ratio?: string; seed?: number; negative_prompt?: string; camera_fixed?: boolean;
};

const refuse = (code: string, message: string): never => { throw new CapabilityError(400, code, message); };

const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(', ');

/** The request fields a catalog model takes, in the order the docs give them. */
export function acceptedFields(a: MediaAccepts, kind: MediaKind): string[] {
  const has = (f: unknown) => f !== undefined && f !== false;
  return kind === 'image'
    ? ['prompt', ...(has(a.n) ? ['n'] : []), ...(has(a.size) ? ['size'] : []), ...(has(a.image) ? ['image'] : []), ...(has(a.seed) ? ['seed'] : []),
      ...(has(a.negative_prompt) ? ['negative_prompt'] : []), ...(has(a.response_format) ? ['response_format'] : [])]
    : ['prompt', ...(has(a.image) ? ['image'] : []), ...(has(a.last_image) ? ['last_image'] : []), ...(has(a.reference_images) ? ['reference_images'] : []),
      ...(has(a.audio) ? ['audio'] : []), ...(has(a.duration) ? ['duration'] : []), ...(has(a.resolutions) ? ['resolution'] : []),
      ...(has(a.ratios) ? ['ratio', 'aspect_ratio'] : []), ...(has(a.seed) ? ['seed'] : []), ...(has(a.negative_prompt) ? ['negative_prompt'] : []),
      ...(has(a.camera_fixed) ? ['camera_fixed'] : [])];
}

function refuseUnknown(m: MediaModel, body: Record<string, unknown>): void {
  const accepted = new Set(acceptedFields(m.accepts, m.kind));
  const unknown = Object.keys(body).filter((k) => body[k] !== undefined && !IGNORED.has(k) && !accepted.has(k));
  if (unknown.length) refuse('unsupported_field', `"${m.id}" does not take ${quoted(unknown)}. It takes: ${quoted([...accepted])}.`);
}

const isHttpUrl = (v: string) => {
  if (v.length > 4096) return false;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

/** One input file: a public URL, or (where the model allows it) a data: URI of the right type. */
function source(field: string, v: unknown, sources: MediaSource[], mime: 'image' | 'audio'): string {
  const inline = sources.includes('data_uri');
  const expected = inline ? `an http(s) URL or a data:${mime}/…;base64,… URI` : 'a public http(s) URL';
  if (typeof v !== 'string') return refuse(`invalid_${field}`, `"${field}" must be ${expected}.`);
  const s = v.trim();
  if (isHttpUrl(s) || (inline && new RegExp(`^data:${mime}/[a-z0-9.+-]+;base64,.+`, 's').test(s))) return s;
  return refuse(`invalid_${field}`, `"${field}" must be ${expected}.`);
}

/** A string or an array of them, at most `max`. */
function sources(field: string, v: unknown, spec: { max: number; sources: MediaSource[] }, mime: 'image' | 'audio', modelId: string): string[] {
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) refuse(`invalid_${field}`, `"${field}" is empty.`);
  if (list.length > spec.max) refuse(`invalid_${field}`, `"${modelId}" takes at most ${spec.max} in "${field}"; got ${list.length}.`);
  return list.map((x) => source(field, x, spec.sources, mime));
}

function promptOf(body: Record<string, unknown>): string | undefined {
  if (body.prompt === undefined) return undefined;
  if (typeof body.prompt !== 'string') return refuse('invalid_prompt', '"prompt" must be a string.');
  return body.prompt;
}

function seedOf(body: Record<string, unknown>): number | undefined {
  if (body.seed === undefined) return undefined;
  const n = body.seed;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < -1 || n > 2_147_483_647) return refuse('invalid_seed', '"seed" must be an integer from -1 to 2147483647.');
  return n;
}

function sizeOf(m: MediaModel, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const spec = m.accepts.size!;
  const presets = spec.presets.length ? `${spec.presets.join(', ')} or ` : '';
  const range = spec.min_pixels ? ` (${spec.min_pixels.toLocaleString('en-US')} to ${spec.max_pixels!.toLocaleString('en-US')} pixels, aspect ratio 1:16 to 16:1)` : '';
  const hint = `"size" for "${m.id}" must be ${presets}WIDTHxHEIGHT${range}.`;
  if (typeof raw !== 'string') return refuse('invalid_size', hint);
  const preset = spec.presets.find((p) => p.toLowerCase() === raw.trim().toLowerCase());
  if (preset) return preset;
  const dims = /^\s*(\d{2,5})\s*[x*×]\s*(\d{2,5})\s*$/i.exec(raw);
  if (!dims) return refuse('invalid_size', hint);
  const [w, h] = [Number(dims[1]), Number(dims[2])];
  const pixels = pixelsOf(raw)!;
  if (spec.min_pixels !== undefined && (pixels < spec.min_pixels || pixels > spec.max_pixels! || w / h > 16 || h / w > 16)) refuse('invalid_size', hint);
  return `${w}x${h}`;
}

/** Checks an images request against the model and returns its fields. Throws a 400 CapabilityError. */
export function imageRequestFields(m: MediaModel, body: Record<string, unknown>): ImageRequestFields {
  refuseUnknown(m, body);
  const a = m.accepts;
  const prompt = promptOf(body);
  if (!prompt?.trim()) refuse('invalid_prompt', 'prompt is required.');
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > (a.n?.max ?? 1)) refuse('invalid_n', `n must be 1 to ${a.n?.max ?? 1}.`);
  const size = sizeOf(m, body.size);
  const images = body.image === undefined ? [] : sources('image', body.image, a.image!, 'image', m.id);
  const seed = seedOf(body);
  if (body.negative_prompt !== undefined && typeof body.negative_prompt !== 'string') refuse('invalid_negative_prompt', '"negative_prompt" must be a string.');
  return {
    prompt: prompt!, n, inputImages: images.length,
    ...(size ? { size } : {}),
    ...(images.length ? { image: Array.isArray(body.image) ? images : images[0]! } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(typeof body.negative_prompt === 'string' ? { negative_prompt: body.negative_prompt } : {}),
    ...(body.response_format === 'url' || body.response_format === 'b64_json' ? { response_format: body.response_format } : {}),
  };
}

/** Checks a videos request against the model and returns its fields. Throws a 400 CapabilityError. */
export function videoRequestFields(m: MediaModel, body: Record<string, unknown>): VideoRequestFields {
  refuseUnknown(m, body);
  const a = m.accepts;
  const missing = a.required.filter((f) => body[f] === undefined);
  if (missing.length) refuse(`invalid_${missing[0]}`, `"${m.id}" requires ${quoted(a.required)}; missing ${quoted(missing)}.`);

  const image = body.image === undefined ? undefined : sources('image', body.image, { ...a.image!, max: 1 }, 'image', m.id)[0];
  const lastImage = body.last_image === undefined ? undefined : source('last_image', body.last_image, a.last_image!.sources, 'image');
  const references = body.reference_images === undefined ? undefined : sources('reference_images', body.reference_images, a.reference_images!, 'image', m.id);
  const audio = body.audio === undefined ? undefined : sources('audio', body.audio, a.audio!, 'audio', m.id);

  const prompt = promptOf(body);
  const hasMedia = Boolean(image || references?.length || audio?.length);
  if ((a.prompt === 'required' || (a.prompt === 'required_without_media' && !hasMedia)) && !prompt?.trim()) refuse('invalid_prompt', 'prompt is required.');

  if (m.provider === 'BytePlus') {
    if (lastImage && !image) refuse('invalid_last_image', '"last_image" needs "image" (the first frame) too.');
    if ((image || lastImage) && (references?.length || audio?.length)) refuse('invalid_media_combination', `"image" / "last_image" (frames) cannot be combined with "reference_images" or "audio" on "${m.id}".`);
    // Seedance 2.0's audio goes with reference images; 2.5 alone takes audio by itself.
    if (audio?.length && !references?.length && m.id.includes('seedance-2-0')) refuse('invalid_audio', `"audio" on "${m.id}" needs at least one of "reference_images" too.`);
  }

  if (body.ratio !== undefined && body.aspect_ratio !== undefined && body.ratio !== body.aspect_ratio) refuse('invalid_ratio', 'Send one of "ratio" and "aspect_ratio", or the same value in both.');
  const ratio = body.ratio ?? body.aspect_ratio;
  if (ratio !== undefined) {
    const allowed = (image && a.ratios_with_image) || a.ratios!;
    if (typeof ratio !== 'string' || !allowed.includes(ratio)) refuse('invalid_ratio', `"ratio" for "${m.id}"${image ? ' with a first frame' : ''} must be one of: ${allowed.join(', ')}.`);
  }

  if (body.resolution !== undefined && (typeof body.resolution !== 'string' || !a.resolutions!.includes(body.resolution))) {
    refuse('invalid_resolution', `"resolution" for "${m.id}" must be one of: ${a.resolutions!.join(', ')}.`);
  }
  let duration: number | undefined;
  if (body.duration !== undefined) {
    duration = Number(body.duration);
    if (body.duration === null || body.duration === '' || !Number.isFinite(duration)) refuse('invalid_duration', '"duration" must be a number of seconds.');
  }
  const seed = seedOf(body);
  if (body.camera_fixed !== undefined && typeof body.camera_fixed !== 'boolean') refuse('invalid_camera_fixed', '"camera_fixed" must be true or false.');
  if (body.negative_prompt !== undefined && typeof body.negative_prompt !== 'string') refuse('invalid_negative_prompt', '"negative_prompt" must be a string.');

  return {
    prompt: prompt ?? '',
    ...(image ? { image } : {}),
    ...(lastImage ? { last_image: lastImage } : {}),
    ...(references?.length ? { reference_images: references } : {}),
    ...(audio?.length ? { audio: audio.length === 1 ? audio[0]! : audio } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
    ...(typeof ratio === 'string' ? { ratio } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(typeof body.negative_prompt === 'string' ? { negative_prompt: body.negative_prompt } : {}),
    ...(typeof body.camera_fixed === 'boolean' ? { camera_fixed: body.camera_fixed } : {}),
  };
}

// ── WaveSpeed: the unified fields onto a model's own schema ───────────────────────────────────────────

/** A unified field and the names WaveSpeed models give it, in the order they are tried. */
const WAVESPEED_NAMES: Record<string, string[]> = {
  image: ['image', 'images', 'image_url', 'input_image', 'first_frame', 'first_frame_image', 'start_image', 'reference_image'],
  last_image: ['last_image', 'last_frame', 'last_frame_image', 'end_image', 'tail_image'],
  reference_images: ['reference_images', 'images', 'reference_image_urls', 'reference_image'],
  audio: ['audio', 'audio_url', 'input_audio'],
};

const NOT_FIELDS = new Set([...IGNORED, 'response_format', 'stream', 'input', 'enable_sync_mode', 'enable_base64_output']);

function isArrayField(schema: WaveSpeedSchema, name: string): boolean {
  return schema.properties[name]?.type === 'array';
}

/** What a WaveSpeed model's schema takes, as unified fields where one maps, then its own fields. */
export function wavespeedFieldNames(schema: WaveSpeedSchema): string[] {
  const props = schema.properties;
  const has = (n: string) => n in props;
  const unified = [
    ...(has('prompt') ? ['prompt'] : []),
    ...(has('num_images') ? ['n'] : []),
    ...(has('size') || (has('width') && has('height')) ? ['size'] : []),
    ...Object.keys(WAVESPEED_NAMES).filter((f) => WAVESPEED_NAMES[f]!.some(has)),
    ...(has('aspect_ratio') || has('ratio') ? ['ratio', 'aspect_ratio'] : []),
  ];
  return [...new Set([...unified, ...Object.keys(props)])];
}

/**
 * A request for a WaveSpeed model whose schema WaveSpeed lists -> its input: the unified fields under the names the model
 * gives them, its own fields by name. A field the schema doesn't have, or an input it requires and didn't get, is a 400
 * (a raw `input` object is sent as given: the way to reach a field WaveSpeed hasn't listed).
 */
export function wavespeedRequestInput(id: string, body: Record<string, unknown>, schema: WaveSpeedSchema): Record<string, unknown> {
  const props = schema.properties;
  const has = (n: string) => n in props;
  const out: Record<string, unknown> = {};
  const unsupported: string[] = [];
  const conflict = (field: string, target: string) => refuse('invalid_field', `Send "${field}" or "${target}" for "${id}", not both.`);

  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || NOT_FIELDS.has(k) || k in WAVESPEED_NAMES || k === 'n' || k === 'size' || k === 'ratio' || k === 'aspect_ratio') continue;
    if (has(k)) out[k] = v; else unsupported.push(k);
  }

  for (const [field, names] of Object.entries(WAVESPEED_NAMES)) {
    const v = body[field];
    if (v === undefined) continue;
    // A model's own field of this name, sent as it is ("image" on a model with "image").
    const target = names.find(has);
    if (!target) { unsupported.push(field); continue; }
    if (target !== field && out[target] !== undefined) conflict(field, target);
    if (isArrayField(schema, target)) out[target] = Array.isArray(v) ? v : [v];
    else if (Array.isArray(v)) {
      if (v.length !== 1) refuse(`invalid_${field}`, `"${id}" takes one "${field}" (its "${target}"); got ${v.length}.`);
      out[target] = v[0];
    } else out[target] = v;
  }

  if (body.size !== undefined) {
    const m = typeof body.size === 'string' ? /^\s*(\d+)\s*[x*×]\s*(\d+)\s*$/i.exec(body.size) : null;
    if (has('size')) out.size = m ? `${m[1]}*${m[2]}` : body.size;
    else if (m && has('width') && has('height')) { out.width = Number(m[1]); out.height = Number(m[2]); }
    else unsupported.push('size');
  }

  if (body.ratio !== undefined && body.aspect_ratio !== undefined && body.ratio !== body.aspect_ratio) refuse('invalid_ratio', 'Send one of "ratio" and "aspect_ratio", or the same value in both.');
  const ratio = body.ratio ?? body.aspect_ratio;
  if (ratio !== undefined) {
    const target = has('aspect_ratio') ? 'aspect_ratio' : has('ratio') ? 'ratio' : null;
    if (target) out[target] = ratio; else unsupported.push(body.ratio !== undefined ? 'ratio' : 'aspect_ratio');
  }

  if (body.n !== undefined) {
    if (has('num_images')) out.num_images = Number(body.n);
    else if (Number(body.n) !== 1) unsupported.push('n');
  }

  if (unsupported.length) refuse('unsupported_field', `"${id}" does not take ${quoted(unsupported)}. It takes: ${quoted(wavespeedFieldNames(schema))}.`);

  if (body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
    for (const [k, v] of Object.entries(body.input as Record<string, unknown>)) if (k !== 'enable_sync_mode' && k !== 'enable_base64_output') out[k] = v;
  }

  const missing = schema.required.filter((r) => out[r] === undefined);
  if (missing.length) {
    const unifiedOf = (r: string) => Object.keys(WAVESPEED_NAMES).find((f) => WAVESPEED_NAMES[f]!.includes(r)) ?? r;
    refuse(`invalid_${unifiedOf(missing[0]!)}`, `"${id}" requires ${quoted(schema.required)}; missing ${quoted(missing)}.`);
  }
  return out;
}

/** The capability record of a WaveSpeed model from its schema, as far as it can be read. */
export function wavespeedCapabilities(info: WaveSpeedModelInfo): { kind: string; type: string; fields?: string[]; required?: string[]; duration?: unknown; resolutions?: unknown; ratios?: unknown } {
  const schema = info.schema;
  const p = schema?.properties;
  return {
    kind: info.kind, type: info.type,
    ...(schema ? { fields: wavespeedFieldNames(schema), required: schema.required } : {}),
    ...(p?.duration?.enum ? { duration: { values: p.duration.enum } } : p?.duration?.minimum !== undefined ? { duration: { min: p.duration.minimum, max: p.duration.maximum } } : {}),
    ...(p?.resolution?.enum ? { resolutions: p.resolution.enum } : {}),
    ...(p?.aspect_ratio?.enum ? { ratios: p.aspect_ratio.enum } : p?.ratio?.enum ? { ratios: p.ratio.enum } : {}),
  };
}

/** Endpoint a media model is called on. */
export const mediaEndpoint = (kind: MediaKind) => (kind === 'image' ? '/v1/images/generations' : '/v1/videos');
