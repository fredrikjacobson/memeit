import type { TextClip } from '@memeit/timeline';
import sharp from 'sharp';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function renderTextPng(clip: TextClip, W: number, H: number, outPath: string): Promise<void> {
  const scale = W / 1080;
  const fontSize = Math.max(12, clip.fontSize * scale);
  const stroke = Math.max(0, clip.strokeWidth * scale);
  const cx = W / 2 + clip.x * W;
  const cy = H / 2 + clip.y * H;
  const lines = clip.text.split('\n').slice(0, 8);
  const lh = fontSize * 1.12;
  const startY = cy - ((lines.length - 1) * lh) / 2;

  const texts = lines
    .map((ln, i) => {
      const y = startY + i * lh;
      return `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="Impact,'Arial Black',sans-serif" font-weight="900" font-size="${fontSize.toFixed(1)}" letter-spacing="1" fill="${clip.color}" ${stroke > 0 ? `stroke="${clip.strokeColor}" stroke-width="${stroke.toFixed(1)}" paint-order="stroke" stroke-linejoin="round"` : ''}>${esc(ln.toUpperCase())}</text>`;
    })
    .join('');

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><style>text{white-space:pre;}</style>${texts}</svg>`;

  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outPath);
}
