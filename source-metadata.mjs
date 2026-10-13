/** Minimal local source metadata. No file bodies, handles, URLs or absolute paths. */
export const DIRECTORY_LIMITS = Object.freeze({sources:100, entries:10000, path:1000});
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const HASH = /^h-[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const own = value => value && typeof value === 'object' && !Array.isArray(value);
const excludedFolder = value => value.startsWith('.') || /^(?:backups?|备份|node_modules)$/i.test(value);

/** Filter obvious repository documents and backups before reading any bytes. */
export function isArticleRelativePath(path) {
  if (typeof path !== 'string' || !path || path.length > DIRECTORY_LIMITS.path || CONTROL.test(path)
    || /[\\:]/.test(path) || path.startsWith('/')) return false;
  let decoded = path;
  for (let depth = 0; depth < 8; depth++) {
    if (/%(?:2f|5c)/i.test(decoded)) return false;
    let next;
    try {next = decodeURIComponent(decoded);} catch {break;}
    if (next === decoded) break;
    if (CONTROL.test(next) || /[\\:]/.test(next) || next.startsWith('/')
      || next.split('/').some(segment => !segment || segment === '.' || segment === '..' || excludedFolder(segment))) return false;
    decoded = next;
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || excludedFolder(segment))) return false;
  const name = segments.at(-1);
  if (!/\.md$/i.test(name)) return false;
  if (/^(?:backups?|bak|备份)(?:[._ -]?\d+(?:[._ -]\d+)*)?\.md$/i.test(name)) return false;
  if (/^(?:readme(?:[._-][^/]*)?|agents|changelog|changes|license|licence|copying|third_party_notices|verification|reference_review|test_results(?:_.*)?)\.md$/i.test(name)) return false;
  return !/(?:[._ -](?:backup|bak|old|orig|tmp|备份)(?:[._ -]?\d+(?:[._ -]\d+)*)?|[（(](?:备份|backup)[）)])\.md$/i.test(name);
}

export function isDirectoryLabel(label) {
  return typeof label === 'string' && Boolean(label.trim()) && label === label.trim() && label.length <= 255
    && !CONTROL.test(label) && !/[\\/:]/.test(label) && label !== '.' && label !== '..' && !excludedFolder(label);
}

/** Preserve optional fields only when supplied; old v1/v2 records keep their exact shape. */
export function normalizeDirectoryMetadata(input, validIds) {
  if (!own(input) || !Object.hasOwn(input,'sources') && !Object.hasOwn(input,'manualIds')) return {};
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  const sources = [], sourceIds = new Set();
  let entryCount = 0;
  for (const source of Array.isArray(input.sources) ? input.sources.slice(0,DIRECTORY_LIMITS.sources) : []) {
    if (!own(source) || typeof source.id !== 'string' || !ID.test(source.id) || sourceIds.has(source.id) || !isDirectoryLabel(source.label)) continue;
    const entries = [], paths = new Set();
    for (const entry of Array.isArray(source.entries) ? source.entries : []) {
      if (entryCount >= DIRECTORY_LIMITS.entries) break;
      if (!own(entry) || !isArticleRelativePath(entry.path) || paths.has(entry.path)
        || !valid.has(entry.articleId) || typeof entry.fingerprint !== 'string' || !HASH.test(entry.fingerprint)) continue;
      paths.add(entry.path); entryCount++;
      entries.push({path:entry.path,articleId:entry.articleId,fingerprint:entry.fingerprint});
    }
    sourceIds.add(source.id); sources.push({id:source.id,label:source.label,entries});
  }
  const manualIds = [];
  for (const id of Array.isArray(input.manualIds) ? input.manualIds : []) {
    if (valid.has(id) && !manualIds.includes(id)) manualIds.push(id);
  }
  const metadata = {sources,manualIds};
  if (Object.hasOwn(input,'manualEntries')) {
    const manualEntries = [], seen = new Set();
    for (const entry of Array.isArray(input.manualEntries) ? input.manualEntries.slice(0,2000) : []) {
      if (!own(entry) || !manualIds.includes(entry.articleId) || seen.has(entry.articleId) || typeof entry.fingerprint !== 'string' || !HASH.test(entry.fingerprint)) continue;
      seen.add(entry.articleId);manualEntries.push({articleId:entry.articleId,fingerprint:entry.fingerprint});
    }
    metadata.manualEntries = manualEntries;
  }
  return metadata;
}
