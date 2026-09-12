/**
 * Danh muc adapter cac nen tang.
 * Them nen tang moi: tao class ke thua BasePlatform roi dang ky vao day
 * (hoac goi `poster.use(MyPlatform, config)` tu ben ngoai).
 */

import { BasePlatform } from './base.js';
import { YouTubePlatform } from './youtube.js';
import { FacebookPlatform } from './facebook.js';
import { InstagramPlatform } from './instagram.js';
import { TikTokPlatform } from './tiktok.js';
import { TelegramPlatform } from './telegram.js';

/** @type {Record<string, typeof BasePlatform>} */
export const PLATFORM_REGISTRY = {
  [YouTubePlatform.id]: YouTubePlatform,
  [FacebookPlatform.id]: FacebookPlatform,
  [InstagramPlatform.id]: InstagramPlatform,
  [TikTokPlatform.id]: TikTokPlatform,
  [TelegramPlatform.id]: TelegramPlatform,
};

/** Danh sach id nen tang duoc ho tro san. */
export const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_REGISTRY);

export {
  BasePlatform,
  YouTubePlatform,
  FacebookPlatform,
  InstagramPlatform,
  TikTokPlatform,
  TelegramPlatform,
};

/**
 * Bang so sanh nhanh kha nang cua tung nen tang (dung cho tai lieu / CLI).
 * @returns {Array<{platform: string, name: string} & import('./base.js').PlatformCapabilities>}
 */
export function capabilitiesTable() {
  return Object.entries(PLATFORM_REGISTRY).map(([id, Klass]) => ({
    platform: id,
    name: Klass.displayName,
    ...Klass.capabilities,
  }));
}
