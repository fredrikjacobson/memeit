import { createStore, get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

// Separate IDB database for media blobs (video/image/audio can be 100s of MB)
const assetStore = createStore('memeit-assets', 'files');

export const assetKey = (clipId: string) => `clip:${clipId}`;

export async function saveAsset(clipId: string, blob: Blob): Promise<void> {
  await idbSet(assetKey(clipId), blob, assetStore);
}

export async function loadAsset(clipId: string): Promise<Blob | undefined> {
  return idbGet<Blob>(assetKey(clipId), assetStore);
}

export async function deleteAsset(clipId: string): Promise<void> {
  await idbDel(assetKey(clipId), assetStore);
}

// Portable reference stored in project JSON / localStorage instead of blob: URLs
export const toAssetRef = (clipId: string) => `asset:${clipId}`;
export const clipIdFromRef = (src: string) => (src.startsWith('asset:') ? src.slice(6) : null);
export const isMissingRef = (src: string) => src.startsWith('missing:');
