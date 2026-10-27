import type { Track } from '../core/types';

/** Solo wins over mute: with any track soloed, only soloed tracks sound. */
export function audible(t: Track, anySolo: boolean): boolean {
  return anySolo ? t.mix.solo : !t.mix.mute;
}
