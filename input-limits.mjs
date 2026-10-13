// Limits apply to new input. Previously valid drafts remain available for backup.
export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_DATA_BYTES = 64 * 1024 * 1024;
export const MAX_INDEX_ENTRIES = 100_000;

export function utf8ByteLength(value) {
  const text = String(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {bytes += 4;i++;}
    else bytes += 3;
  }
  return bytes;
}

export function acceptsSourceChange(previous, next) {
  if (previous === next) return true;
  const size = utf8ByteLength(next);
  return size <= MAX_MARKDOWN_BYTES || size < utf8ByteLength(previous);
}

/** Shared by overlapping preview requests, so their combined reads stay bounded. */
export function createLimitedReader(read, concurrency = 3) {
  const limit = Math.max(1, Math.min(3, Math.floor(concurrency) || 3));
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < limit && queue.length) {
      const {file,resolve,reject} = queue.shift();active++;
      Promise.resolve().then(() => read(file)).then(resolve,reject).finally(() => {active--;drain();});
    }
  };
  return file => new Promise((resolve,reject) => {queue.push({file,resolve,reject});drain();});
}

/** Return one atomic batch: a failed/over-budget batch supplies no new assets. */
export async function readAssetBatch(targets, {existingAssets = new Map(), read,
  budget = MAX_ASSET_DATA_BYTES, isCancelled = () => false} = {}) {
  const entries = [...targets], staged = new Map(), errors = new Map();
  if (!entries.length) return {staged,errors,cancelled:isCancelled()};
  const limit = Math.min(MAX_ASSET_DATA_BYTES,Math.max(0,budget));
  let total = [...existingAssets.values()].reduce((sum,value) => sum + value.length,0);
  const fail = message => ({staged:new Map(),errors:new Map(entries.map(([path]) => [path,message])),cancelled:false});
  // A size hint can reject clearly oversized batches before allocating image buffers.
  const predicted = entries.reduce((sum,[,file]) => sum + (Number.isFinite(file?.size) && file.size >= 0
    ? Math.ceil(file.size / 3) * 4 + 32 : 0),0);
  if (total >= limit || total + predicted > limit) return fail('本批新增图片将超过 64 MiB 已读图片总预算；原图片保留，请减少图片或重新选择目录。');
  let cursor = 0, failed = false;
  await Promise.all(Array.from({length:Math.min(3,entries.length)},async () => {
    while (!failed && !isCancelled() && cursor < entries.length) {
      const [path,file] = entries[cursor++];
      try {
        const value = await read(file);
        if (typeof value !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
          throw new Error('图片读取结果不是受支持的本地图片数据。');
        }
        total += value.length;
        if (total > limit) throw new Error('本批新增图片超过 64 MiB 已读图片总预算。');
        staged.set(path,value);
      } catch(error) {errors.set(path,error?.message || '图片无法读取。');failed = true;}
    }
  }));
  if (isCancelled()) return {staged:new Map(),errors:new Map(),cancelled:true};
  if (failed) {
    for (const [path] of entries) if (!errors.has(path)) errors.set(path,'本批图片未完整读取，新增图片均未保存；原图片保留，请重新选择图片。');
    return {staged:new Map(),errors,cancelled:false};
  }
  return {staged,errors,cancelled:false};
}
