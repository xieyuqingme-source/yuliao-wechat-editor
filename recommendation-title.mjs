/** Display-only history titles. No files, network, or original titles are changed. */
const MAX_TITLE = 500;
const controls = /[\u0000-\u001f\u007f]/;

function validTitle(value) {
  return typeof value === 'string' && value.trim() && value.length <= MAX_TITLE && !controls.test(value);
}

export function getDisplayTitle(item = {}) {
  return validTitle(item?.displayTitle) ? item.displayTitle.trim() : validTitle(item?.title) ? item.title.trim() : '';
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year === null || year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31][month-1];
}

/** Suggest only unmistakable, valid, separated dates from a filename-derived title. */
export function suggestDisplayTitle(item = {}) {
  if (item?.titleSource !== 'filename' || !validTitle(item?.title)) return null;
  const title = item.title.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})[_\-\s]+(.+)$/.exec(title);
  if (match && Number(match[1]) >= 1000 && validDate(Number(match[1]),Number(match[2]),Number(match[3]))) return match[4].trim() || null;
  match = /^(\d{4})(\d{2})(\d{2})[_\-\s]+(.+)$/.exec(title);
  if (match && Number(match[1]) >= 1000 && validDate(Number(match[1]),Number(match[2]),Number(match[3]))) return match[4].trim() || null;
  match = /^(\d{2})(\d{2})[_\-\s]+(.+)$/.exec(title);
  if (match && validDate(null,Number(match[1]),Number(match[2]))) return match[3].trim() || null;
  return null;
}

/** Empty input resets the display title; invalid input leaves the record unchanged. */
export function setDisplayTitle(item, value) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof value !== 'string') return item;
  const next = {...item};
  if (!value.trim()) { delete next.displayTitle; return next; }
  if (!validTitle(value)) return item;
  const title = value.trim();
  if (title === item.title?.trim()) delete next.displayTitle;
  else next.displayTitle = title;
  return next;
}

/** Same display titles are a prompt for manual review, never a merge decision. */
export function findDuplicateDisplayTitles(items = []) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const title = getDisplayTitle(item);
    if (!title || typeof item?.id !== 'string' || !item.id) continue;
    const key = title.normalize('NFKC').toLocaleLowerCase('en-US').trim();
    if (!groups.has(key)) groups.set(key,{title,ids:[]});
    const group = groups.get(key);
    if (!group.ids.includes(item.id)) group.ids.push(item.id);
  }
  return [...groups.values()].filter(group => group.ids.length > 1);
}
