import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './platform';

describe('bytesToBase64', () => {
  it('encodes binary data exactly like Node', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('handles files larger than the chunk size', () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 7) % 256);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
