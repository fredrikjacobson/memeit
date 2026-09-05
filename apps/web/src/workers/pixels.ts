// Shared pixel-tensor helper (dependency-free — imported by both the main
// thread lib and the segmentation worker).
//
// Background: @imgly/background-removal's types claim `ImageData` is a valid
// input, but at runtime (1.7.0) a raw ImageData passes straight through
// `imageSourceToImageData` and crashes in `runInference` at
// `const [h, w, c] = imageTensor.shape` — `.shape` is undefined on a DOM
// ImageData, hence "undefined is not iterable". The pipeline actually wants an
// `ndarray`-shaped tensor ({ data, shape, stride, offset, get/set }), which is
// plain duck-typed data — this wrapper provides exactly what the inference
// path touches (shape destructuring, .get() in the resize, direct .data
// read/write for the alpha composite + raw encode).

export type RgbaTensor = {
  data: Uint8Array;
  shape: [number, number, number];
  stride: [number, number, number];
  offset: number;
  dtype: string;
  get: (y: number, x: number, c: number) => number;
  set: (y: number, x: number, c: number, v: number) => void;
};

/** Wrap W×H RGBA pixels as an inference-ready tensor. Null on size mismatch. */
export function wrapRgba(data: Uint8Array, width: number, height: number): RgbaTensor | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (data.byteLength !== width * height * 4) return null;
  return {
    data,
    shape: [height, width, 4],
    stride: [width * 4, 4, 1],
    offset: 0,
    dtype: 'uint8',
    get: (y, x, c) => data[(y * width + x) * 4 + c] ?? 0,
    set: (y, x, c, v) => {
      data[(y * width + x) * 4 + c] = v;
    },
  };
}
