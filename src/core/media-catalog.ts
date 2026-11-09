/**
 * Image and video models Valefront sells, with each provider's official price. One table for routing (which provider
 * serves a model), the price check before a request reaches a provider, and what a finished generation costs.
 *
 * Prices (read 2026-11-06):
 * - BytePlus ModelArk: https://docs.byteplus.com/en/docs/ModelArk/1544106 ("Pricing"). Images are per image; input
 *   images are free except on Seedream 5.0 Pro (the first is free, each further one $0.003). Videos are per million tokens of the finished video (text input, online inference), and
 *   BytePlus charges only for videos that were generated: a failed or moderated one costs nothing.
 * - WaveSpeed: https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-dev ($0.012 per image).
 * - BytePlus Vision AI (OmniHuman talking avatars, its own API and Access Key, src/providers/byteplus-vision.ts):
 *   https://www.byteplus.com/en/product/OmniHuman ("Pricing and billing: 0.07 USD/second" for OmniHuman 2.0). Billed
 *   by the duration of the generated video, as BytePlus documents for OmniHuman 1.5
 *   (https://docs.byteplus.com/docs/en/byteplus-vision/omnihuman1_5overview.md, "Pricing"); only a successful call
 *   is billed.
 *
 * A model missing here is not offered for media: it is refused before any provider is called, never priced by default.
 */

export type MediaKind = 'image' | 'video';
export type MediaProvider = 'BytePlus' | 'BytePlusVision' | 'WaveSpeed';

export type ImagePrice = {
  /** US dollars per generated image. */
  perImageUsd: number;
  /** A higher price for images above this many pixels (Seedream 5.0 Pro: 2.61M pixels, i.e. above 1.5K). */
  above?: { pixels: number; perImageUsd: number };
  /** US dollars per input image after the first, per generated image (Seedream 5.0 Pro); unset: input images are free. */
  extraInputImageUsd?: number;
};

export type VideoPrice = {
  /** US dollars per million tokens of the generated video at 480p/720p. */
  perMTokensUsd: number;
  /** At 1080p, when the model offers it at another price; unset: 1080p not offered (or same price, see maxResolution). */
  perMTokensUsd1080p?: number;
  maxResolution: '720p' | '1080p';
  /** Seconds a video may last (inclusive); the default is used when the request names none. */
  durations: { min: number; max: number; default: number };
};

/** A talking avatar (one image + an audio track -> a lip-synced video), billed by the second of video made. */
export type AvatarPrice = {
  /** US dollars per second of the generated video. */
  perSecondUsd: number;
  /** Seconds the audio may last (inclusive), from the provider's API limits; the video is as long as the audio. */
  audioSeconds: { min: number; max: number };
  /** The provider's own model id (BytePlus Vision's req_key). */
  reqKey: string;
};

/** Where an input file may come from: a public http(s) URL, or inline as a data: URI. */
export type MediaSource = 'url' | 'data_uri';

/**
 * The request fields a model takes on POST /v1/images/generations or /v1/videos, in the one request shape every provider
 * shares (src/core/media-request.ts). Served as is in /v1/models and /v1/pricing, so docs and UIs can be generated. A field
 * missing here is refused with a 400 naming what the model does take.
 */
export type MediaAccepts = {
  /** `required_without_media`: required unless an image, reference image or audio is given. */
  prompt: 'required' | 'optional' | 'required_without_media';
  /** Fields a request must have (besides `model`). */
  required: string[];
  n?: { max: number };
  /** Presets (2K) and/or WxH; a WxH must be within the pixel range, when there is one. */
  size?: { presets: string[]; default: string; min_pixels?: number; max_pixels?: number };
  response_format?: string[];
  /** One image, or (image endpoint) up to `max` of them. On a video it is the first frame. */
  image?: { max: number; sources: MediaSource[] };
  last_image?: { sources: MediaSource[] };
  reference_images?: { max: number; sources: MediaSource[] };
  audio?: { max: number; sources: MediaSource[] };
  /** Seconds; outside the range a request is moved to the nearest end of it. */
  duration?: { min: number; max: number; default: number };
  resolutions?: string[];
  ratios?: string[];
  /** The ratios allowed when the first frame is given, if different from `ratios`. */
  ratios_with_image?: string[];
  seed?: boolean;
  negative_prompt?: boolean;
  camera_fixed?: boolean;
};

export type MediaModel = {
  id: string;
  name: string;
  provider: MediaProvider;
  kind: MediaKind;
  accepts: MediaAccepts;
  image?: ImagePrice;
  video?: VideoPrice;
  avatar?: AvatarPrice;
};

const BYTEPLUS_PRICING = 'https://docs.byteplus.com/en/docs/ModelArk/1544106';
const WAVESPEED_PRICING = 'https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-dev';
const BYTEPLUS_VISION_PRICING = 'https://www.byteplus.com/en/product/OmniHuman';

export const MEDIA_PRICING_SOURCES: Record<MediaProvider, string> = { BytePlus: BYTEPLUS_PRICING, BytePlusVision: BYTEPLUS_VISION_PRICING, WaveSpeed: WAVESPEED_PRICING };

const URL_OR_DATA: MediaSource[] = ['url', 'data_uri'];

/** Seedream (https://docs.byteplus.com/en/docs/modelark/image-generation-api): up to `images` reference images, by size rules. */
const seedream = (images: number, presets: string[], minPixels: number, maxPixels: number): MediaAccepts => ({
  prompt: 'required', required: ['prompt'], n: { max: 4 }, response_format: ['url', 'b64_json'],
  size: { presets, default: '2K', min_pixels: minPixels, max_pixels: maxPixels },
  image: { max: images, sources: URL_OR_DATA },
});
const SEEDREAM_5 = seedream(10, ['1K', '1.5K', '2K'], 921_600, 4_624_220);
const SEEDREAM_4_5 = seedream(14, ['2K', '4K'], 3_686_400, 16_777_216);
const SEEDREAM_4_0 = seedream(14, ['1K', '2K', '4K'], 921_600, 16_777_216);

const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

/** Seedance (https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api): what each generation takes. */
const seedance = (video: VideoPrice, o: {
  lastImage?: boolean; references?: { images: number; audio: number }; legacy?: boolean; firstFrameAdaptiveOnly?: boolean;
}): MediaAccepts => ({
  prompt: 'required_without_media', required: [],
  image: { max: 1, sources: URL_OR_DATA },
  ...(o.lastImage ? { last_image: { sources: URL_OR_DATA } } : {}),
  ...(o.references ? { reference_images: { max: o.references.images, sources: URL_OR_DATA }, audio: { max: o.references.audio, sources: URL_OR_DATA } } : {}),
  duration: video.durations,
  resolutions: ['480p', '720p', ...(video.maxResolution === '1080p' ? ['1080p'] : [])],
  // Seedance 1.0: adaptive only with a first frame. 2.5: a first frame fixes the ratio (adaptive only).
  ratios: o.legacy ? RATIOS : [...RATIOS, 'adaptive'],
  ...(o.legacy ? { ratios_with_image: [...RATIOS, 'adaptive'] } : o.firstFrameAdaptiveOnly ? { ratios_with_image: ['adaptive'] } : {}),
  ...(o.legacy ? { seed: true, camera_fixed: true } : {}),
});

const SEEDANCE_2_5: VideoPrice = { perMTokensUsd: 10.7, perMTokensUsd1080p: 11.7, maxResolution: '1080p', durations: { min: 4, max: 15, default: 5 } };
const SEEDANCE_2_0: VideoPrice = { perMTokensUsd: 7.0, perMTokensUsd1080p: 7.7, maxResolution: '1080p', durations: { min: 4, max: 15, default: 5 } };
const SEEDANCE_2_0_FAST: VideoPrice = { perMTokensUsd: 5.6, maxResolution: '720p', durations: { min: 4, max: 15, default: 5 } };
const SEEDANCE_2_0_MINI: VideoPrice = { perMTokensUsd: 3.5, maxResolution: '720p', durations: { min: 4, max: 15, default: 5 } };
const SEEDANCE_1_0_PRO: VideoPrice = { perMTokensUsd: 2.5, perMTokensUsd1080p: 2.5, maxResolution: '1080p', durations: { min: 2, max: 12, default: 5 } };
const SEEDANCE_1_0_FAST: VideoPrice = { perMTokensUsd: 1.0, perMTokensUsd1080p: 1.0, maxResolution: '1080p', durations: { min: 2, max: 12, default: 5 } };

export const MEDIA_MODELS: MediaModel[] = [
  // Images, BytePlus (Seedream / Dola Seedream: ByteDance's Doubao image models on ModelArk).
  { id: 'dola-seedream-5-0-pro-260628', name: 'Dola Seedream 5.0 Pro', provider: 'BytePlus', kind: 'image', accepts: SEEDREAM_5, image: { perImageUsd: 0.045, above: { pixels: 2_610_000, perImageUsd: 0.09 }, extraInputImageUsd: 0.003 } },
  { id: 'dola-seedream-5-0-flash-260915', name: 'Dola Seedream 5.0 Flash', provider: 'BytePlus', kind: 'image', accepts: SEEDREAM_5, image: { perImageUsd: 0.018 } },
  { id: 'seedream-4-5-251128', name: 'Seedream 4.5', provider: 'BytePlus', kind: 'image', accepts: SEEDREAM_4_5, image: { perImageUsd: 0.04 } },
  { id: 'seedream-4-0-250828', name: 'Seedream 4.0', provider: 'BytePlus', kind: 'image', accepts: SEEDREAM_4_0, image: { perImageUsd: 0.03 } },
  // Images, WaveSpeed.
  { id: 'wavespeed-ai/flux-dev', name: 'FLUX.1 [dev]', provider: 'WaveSpeed', kind: 'image', accepts: { prompt: 'required', required: ['prompt'], n: { max: 4 }, response_format: ['url', 'b64_json'], size: { presets: [], default: '1024x1024' }, seed: true }, image: { perImageUsd: 0.012 } },
  // Videos, BytePlus (Seedance / Dreamina Seedance).
  { id: 'dreamina-seedance-2-5-260628', name: 'Dreamina Seedance 2.5', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_2_5, { lastImage: true, references: { images: 30, audio: 10 }, firstFrameAdaptiveOnly: true }), video: SEEDANCE_2_5 },
  { id: 'dreamina-seedance-2-0-260128', name: 'Dreamina Seedance 2.0', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_2_0, { lastImage: true, references: { images: 9, audio: 3 } }), video: SEEDANCE_2_0 },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Dreamina Seedance 2.0 Fast', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_2_0_FAST, { lastImage: true, references: { images: 9, audio: 3 } }), video: SEEDANCE_2_0_FAST },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Dreamina Seedance 2.0 Mini', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_2_0_MINI, { lastImage: true, references: { images: 9, audio: 3 } }), video: SEEDANCE_2_0_MINI },
  { id: 'seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_1_0_PRO, { lastImage: true, legacy: true }), video: SEEDANCE_1_0_PRO },
  { id: 'seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', provider: 'BytePlus', kind: 'video', accepts: seedance(SEEDANCE_1_0_FAST, { legacy: true }), video: SEEDANCE_1_0_FAST },
  // Talking avatars, BytePlus Vision AI (OmniHuman 2.0: https://docs.byteplus.com/docs/en/byteplus-vision/omnihuman-2-0-video-generation.md).
  { id: 'omnihuman-2.0', name: 'OmniHuman 2.0', provider: 'BytePlusVision', kind: 'video', accepts: { prompt: 'optional', required: ['image', 'audio'], image: { max: 1, sources: ['url'] }, audio: { max: 1, sources: ['url'] } }, avatar: { perSecondUsd: 0.07, audioSeconds: { min: 4, max: 300 }, reqKey: 'realman_avatar_picture_omni20_cv' } },
];

const BY_ID = new Map(MEDIA_MODELS.map((m) => [m.id, m]));

export function mediaModel(id: string, kind?: MediaKind): MediaModel | undefined {
  const m = BY_ID.get(id);
  return m && (!kind || m.kind === kind) ? m : undefined;
}

export function isMediaModel(id: string): boolean {
  return BY_ID.has(id);
}

/** The BytePlus media models (WaveSpeed has its own id format: isWaveSpeedModelId). */
export function isBytePlusMediaModel(id: string): boolean {
  const provider = BY_ID.get(id)?.provider;
  return provider === 'BytePlus' || provider === 'BytePlusVision';
}

export function mediaModelsOf(provider: MediaProvider, kind?: MediaKind): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.provider === provider && (!kind || m.kind === kind));
}

/** Pixels of a resolution preset at 1:1: enough to place it in a price tier at any aspect ratio. */
const PRESET_PIXELS: Record<string, number> = { '1K': 1024 * 1024, '1.5K': 1536 * 1536, '2K': 2048 * 2048, '4K': 4096 * 4096 };

/** "1024x1024", "1024*1024" or a preset ("2K") -> pixels; undefined when it isn't a size. */
export function pixelsOf(size: string | undefined): number | undefined {
  const preset = PRESET_PIXELS[(size ?? '').trim().toUpperCase()];
  if (preset !== undefined) return preset;
  const m = /^\s*(\d{2,5})\s*[x*×]\s*(\d{2,5})\s*$/i.exec(size ?? '');
  return m ? Number(m[1]) * Number(m[2]) : undefined;
}

/**
 * What `count` generated images cost, in US dollars (exact to the micro-dollar). `inputImages`: how many reference images
 * each one was made from (a request's are read again for every image it makes, so the fee is per generated image).
 */
export function imageCostUsd(model: MediaModel, count: number, size?: string, inputImages = 0): number {
  const p = model.image!;
  const px = pixelsOf(size);
  const each = (p.above && px !== undefined && px > p.above.pixels ? p.above.perImageUsd : p.perImageUsd)
    + (p.extraInputImageUsd ?? 0) * Math.max(0, Math.floor(inputImages) - 1);
  return Math.round(each * Math.max(0, Math.floor(count)) * 1_000_000) / 1_000_000;
}

/** What a finished video costs: its tokens x the per-million rate for its resolution. */
export function videoCostUsd(model: MediaModel, tokens: number, resolution?: string): number {
  const p = model.video!;
  const rate = resolution === '1080p' && p.perMTokensUsd1080p !== undefined ? p.perMTokensUsd1080p : p.perMTokensUsd;
  return Math.round((Math.max(0, tokens) * rate) / 1_000_000 * 1_000_000) / 1_000_000;
}

/**
 * What a finished talking-avatar video costs: its seconds (as measured from the video itself, to the millisecond) x
 * the per-second price, exact to the micro-dollar. Not a whole-second round-up: BytePlus publishes no rounding rule.
 */
export function avatarCostUsd(model: MediaModel, seconds: number): number {
  const p = model.avatar!;
  const s = Math.round(Math.max(0, seconds) * 1000) / 1000;
  return Math.round(s * p.perSecondUsd * 1_000_000) / 1_000_000;
}

/** The duration to ask for: the one requested within the model's range (whole seconds), else its default. */
export function videoDuration(model: MediaModel, requested: unknown): number {
  const d = model.video!.durations;
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.round(requested) : d.default;
  return Math.min(d.max, Math.max(d.min, n));
}

/** The resolution to ask for: 480p, 720p or (where offered) 1080p; default 720p. */
export function videoResolution(model: MediaModel, requested: unknown): '480p' | '720p' | '1080p' {
  if (requested === '480p') return '480p';
  if (requested === '1080p' && model.video!.maxResolution === '1080p') return '1080p';
  return '720p';
}
