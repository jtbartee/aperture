/** Encode PCM channels as a RIFF/WAVE file (16-bit with TPDF dither, or 24-bit). */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: 16 | 24 = 16): ArrayBuffer {
  const nCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bps = bitDepth / 8;
  const dataBytes = len * nCh * bps;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * bps, true);
  v.setUint16(32, nCh * bps, true);
  v.setUint16(34, bitDepth, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let x = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 16) {
        x = x * 32767 + (rnd() - rnd());
        v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x))), true);
        o += 2;
      } else {
        const s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
        v.setUint8(o, s & 0xff);
        v.setUint8(o + 1, (s >> 8) & 0xff);
        v.setUint8(o + 2, (s >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return buf;
}

/** Parse a 16/24-bit PCM WAV back into floats (used by tests). */
export function decodeWav(buf: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const v = new DataView(buf);
  const nCh = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const bytes = v.getUint32(40, true);
  const len = bytes / (nCh * bits / 8);
  const channels = Array.from({ length: nCh }, () => new Float32Array(len));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    if (bits === 16) { channels[c][i] = v.getInt16(o, true) / 32768; o += 2; }
    else { let s = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16); if (s & 0x800000) s |= ~0xffffff; channels[c][i] = s / 8388608; o += 3; }
  }
  return { sampleRate, channels };
}
