import test from 'node:test';
import assert from 'node:assert/strict';
import {importHistoryDirectory,importManualHistoryFiles,removeHistoryDirectory} from '../directories.mjs';
import {fingerprintText,normalizeHistoryState,toggleHistorySelection,moveHistorySelection,removeHistoryItem,relatedMarkdown,syncRelatedFooter,searchHistory} from '../history.mjs';
import {isArticleRelativePath} from '../source-metadata.mjs';
import {copyRichText} from '../clipboard.mjs';
import {renderArticle,buildImageIndex} from '../core.mjs';
import {wrapArticleHtml} from '../app.mjs';
import {createRequire} from 'node:module';

const markdownFactory = createRequire(import.meta.url)('../vendor/markdown-it.cjs');
function file(path,text = '# title\nPRIVATE_BODY',{read,size,bytes,error} = {}) {
  const content = bytes ?? new TextEncoder().encode(text);
  return {name:path.split('/').at(-1),webkitRelativePath:path,size:size ?? content.length,
    async arrayBuffer() {read?.();if(error) throw new Error(error);return content.buffer.slice(content.byteOffset,content.byteOffset+content.byteLength);}};
}
const active = state => state.selectedIds.map(id => state.items.find(item => item.id === id)).filter(Boolean);
const hasIssue = (result,status) => result.issues.some(issue => issue.status === status);
async function imported(files,state,sourceId) {
  const result = await importHistoryDirectory(files,{state,sourceId});assert.equal(result.committed,true);return result;
}

test('directory import preserves Chinese spaces and relative source metadata without article bodies',async () => {
  const result = await imported([file('往期文章/中文 子目录/一 篇.md','---\ntitle: "标题 [一]"\n---\nSECRET_HISTORY_BODY')]);
  assert.equal(result.state.sources[0].label,'往期文章');
  assert.deepEqual(result.state.sources[0].entries[0],{path:'中文 子目录/一 篇.md',articleId:result.state.items[0].id,fingerprint:fingerprintText('---\ntitle: "标题 [一]"\n---\nSECRET_HISTORY_BODY')});
  assert.equal(result.state.items[0].title,'标题 [一]');assert.equal(result.state.items[0].titleSource,'frontmatter');
  assert.doesNotMatch(JSON.stringify(result.state),/SECRET_HISTORY_BODY|D:|https|arrayBuffer|url|body/);
});

test('append two directory sources; content deduplicates while same name/title different content stays',async () => {
  const first = await imported([file('archive/same.md','# Same\nbody a')]);
  const checked = toggleHistorySelection(first.state,first.state.items[0].id,true);
  const second = await imported([file('articles/same.md','# Same\nbody b'),file('articles/copy.md','# Same\nbody a')],checked);
  assert.equal(second.state.items.length,2);assert.equal(second.state.sources.length,2);
  assert.deepEqual(second.state.selectedIds,checked.selectedIds);
  assert.equal(second.state.sources[0].entries[0].articleId,second.state.sources[1].entries[1].articleId);
  assert.ok(hasIssue(second,'duplicate'));assert.ok(hasIssue(second,'same-title'));
});

test('repeated add of a basename is refused before reading, even if its contents differ',async () => {
  const first = await imported([file('archive/a.md','# First')]);let reads=0;
  const second = await importHistoryDirectory([file('archive/b.md','# Other',{read:()=>reads++})],{state:first.state});
  assert.equal(second.committed,false);assert.ok(hasIssue(second,'source-conflict'));assert.equal(reads,0);
  assert.deepEqual(second.state,first.state);
});

test('explicit refresh rejects a different root and a missing source without reading',async () => {
  const first = await imported([file('archive/a.md')]);let reads=0;
  const wrong = await importHistoryDirectory([file('articles/a.md','new',{read:()=>reads++})],{state:first.state,sourceId:first.sourceId});
  const missing = await importHistoryDirectory([file('archive/a.md','new',{read:()=>reads++})],{state:first.state,sourceId:'missing'});
  assert.ok(hasIssue(wrong,'source-mismatch'));assert.ok(hasIssue(missing,'unknown-source'));assert.equal(reads,0);
  assert.deepEqual(wrong.state,first.state);assert.deepEqual(missing.state,first.state);
});

test('reselecting an identical directory is repeatable and preserves selection order',async () => {
  const files = [file('archive/a.md','# A'),file('archive/b.md','# B')];
  let first = await imported(files), state = first.state;
  for (const item of [...state.items].reverse()) state = toggleHistorySelection(state,item.id,true);
  for (let i=0;i<3;i++) {
    const next = await imported(files,state,first.sourceId);
    assert.deepEqual(next.state,state);assert.equal(next.added,0);assert.equal(next.updated,0);assert.equal(next.removed,0);
    state=next.state;
  }
});

test('reselecting same-content duplicate filenames never drifts the canonical filename or fallback title',async () => {
  for (const body of ['# H1 title','no title']) {
    const files=[file('archive/first.md',body),file('archive/copy.md',body)];
    const first=await imported(files);
    const next=await imported(files,first.state,first.sourceId);
    assert.deepEqual(next.state,first.state);assert.equal(next.updated,0);
    const reversed=await imported([...files].reverse(),next.state,first.sourceId);
    assert.deepEqual(reversed.state.items,first.state.items);
  }
});

test('same-path body-only edit reports an update while retaining selected ID and unchanged title',async () => {
  const first=await imported([file('archive/a.md','# A\nold')]);
  const next=await imported([file('archive/a.md','# A\nnew')],{...first.state,selectedIds:[first.state.items[0].id]},first.sourceId);
  assert.equal(next.updated,1);assert.equal(next.added,0);assert.equal(next.removed,0);
  assert.deepEqual(next.state.selectedIds,[first.state.items[0].id]);assert.deepEqual(next.state.items,first.state.items);
});

test('same path title/body edits preserve stable ID, custom displayed title and selected order',async () => {
  const first = await imported([file('archive/a.md','# Old\nold'),file('archive/b.md','# B')]);
  const [a,b] = first.state.items;
  let state = {...first.state,items:[{...a,displayTitle:'User title'},b],selectedIds:[b.id,a.id]};
  const next = await imported([file('archive/a.md','---\ntitle: New\n---\nnew body'),file('archive/b.md','# B')],state,first.sourceId);
  assert.deepEqual(next.state.selectedIds,[b.id,a.id]);
  assert.deepEqual(next.state.items.find(item => item.id === a.id),{...a,title:'New',titleSource:'frontmatter',displayTitle:'User title'});
  assert.equal(next.state.sources[0].entries[0].fingerprint,fingerprintText('---\ntitle: New\n---\nnew body'));
  assert.equal(next.updated,1);assert.match(relatedMarkdown(active(next.state)),/User title/);
  assert.deepEqual(searchHistory(next.state.items,'user'),[next.state.items.find(item => item.id === a.id)]);
  assert.equal(searchHistory(next.state.items,'New').length,1);
});

test('snapshot deletion only removes owned disappeared articles and preserves other directory',async () => {
  const first = await imported([file('archive/a.md','# A'),file('archive/b.md','# B')]);
  const second = await imported([file('articles/c.md','# C')],first.state);
  const selectedIds = second.state.items.map(item => item.id).reverse();
  const next = await imported([file('archive/b.md','# B')],{...second.state,selectedIds},first.sourceId);
  assert.deepEqual(next.state.items.map(item => item.title),['B','C']);
  assert.deepEqual(next.state.selectedIds,[selectedIds[0],selectedIds[1]]);assert.equal(next.removed,1);
  assert.deepEqual(next.state.sources[1],second.state.sources[1]);
});

test('shared article deletion retains the copy still referenced by another source',async () => {
  const first = await imported([file('archive/a.md','# A')]);
  const second = await imported([file('articles/copy.md','# A')],first.state);
  const state = toggleHistorySelection(second.state,first.state.items[0].id,true);
  const next = await imported([file('archive/README.md','# not article')],state,first.sourceId);
  assert.equal(next.state.items.length,1);assert.deepEqual(next.state.selectedIds,state.selectedIds);
  assert.equal(next.state.sources[0].entries.length,0);assert.equal(next.state.sources[1].entries.length,1);
});

test('same hash rename preserves ID and selection; filename fallback title follows sole-source filename',async () => {
  const first = await imported([file('archive/old.md','no heading')]);
  const state = toggleHistorySelection(first.state,first.state.items[0].id,true);
  const next = await imported([file('archive/nested/new.md','no heading')],state,first.sourceId);
  assert.equal(next.state.items[0].id,state.items[0].id);assert.equal(next.state.items[0].title,'new');
  assert.deepEqual(next.state.selectedIds,state.selectedIds);assert.equal(next.state.sources[0].entries[0].path,'nested/new.md');
});

test('path and content both changing is a new article without guessed selection',async () => {
  const first = await imported([file('archive/old.md','# Old')]);
  const state = toggleHistorySelection(first.state,first.state.items[0].id,true);
  const next = await imported([file('archive/new.md','# New')],state,first.sourceId);
  assert.notEqual(next.state.items[0].id,state.items[0].id);assert.deepEqual(next.state.selectedIds,[]);
  assert.equal(next.removed,1);assert.equal(next.added,1);
});

test('shared content edit forks without changing or selecting the other directory article',async () => {
  const first = await imported([file('archive/a.md','# Old\nbody')]);
  const second = await imported([file('articles/a.md','# Old\nbody')],first.state);
  const old = second.state.items[0], state = {...second.state,selectedIds:[old.id]};
  const next = await imported([file('archive/a.md','# New\nnewbody')],state,first.sourceId);
  assert.equal(next.state.items.length,2);assert.deepEqual(next.state.selectedIds,[old.id]);
  assert.deepEqual(next.state.items.find(item => item.id === old.id),old);
  assert.notEqual(next.state.sources[0].entries[0].articleId,old.id);assert.equal(next.state.sources[1].entries[0].articleId,old.id);
  assert.ok(hasIssue(next,'shared-change'));
});

test('duplicate paths with one changed copy keep the unchanged content selected and require new manual choice',async () => {
  const first = await imported([file('archive/a.md','# Old'),file('archive/copy.md','# Old')]);
  const old = first.state.items[0], state = {...first.state,selectedIds:[old.id]};
  const next = await imported([file('archive/a.md','# New'),file('archive/copy.md','# Old')],state,first.sourceId);
  assert.equal(next.state.items.length,2);assert.equal(next.state.items.find(item => item.id === old.id).title,'Old');
  assert.deepEqual(next.state.selectedIds,[old.id]);assert.ok(hasIssue(next,'shared-change'));
});

test('a sole-source edit merging into existing content translates selection once',async () => {
  const first = await imported([file('archive/a.md','# A'),file('archive/b.md','# B')]);
  const [a,b] = first.state.items;
  const next = await imported([file('archive/a.md','# B'),file('archive/b.md','# B')],{...first.state,selectedIds:[a.id,b.id]},first.sourceId);
  assert.equal(next.state.items.length,1);assert.equal(next.state.items[0].id,b.id);assert.deepEqual(next.state.selectedIds,[b.id]);
});

test('empty picker and explicit cancellation before or during reads retain old state atomically',async () => {
  const first = await imported([file('archive/a.md','# A')]);let reads=0,cancel=false;
  const empty = await importHistoryDirectory([],{state:first.state,sourceId:first.sourceId});
  const before = await importHistoryDirectory([file('archive/a.md','# B',{read:()=>reads++})],{state:first.state,sourceId:first.sourceId,isCancelled:()=>true});
  const during = await importHistoryDirectory([file('archive/a.md','# B',{read:()=>{reads++;cancel=true;}}),file('archive/b.md','# C',{read:()=>reads++})],
    {state:first.state,sourceId:first.sourceId,isCancelled:()=>cancel});
  for (const result of [empty,before,during]) {assert.equal(result.cancelled,true);assert.equal(result.committed,false);assert.deepEqual(result.state,first.state);}
  assert.equal(reads,1);
});

test('abort while a file read is pending cannot commit an earlier snapshot',async () => {
  const first = await imported([file('archive/a.md','# A')]);const controller = new AbortController();let release;
  const delayed = {name:'a.md',webkitRelativePath:'archive/a.md',size:1,arrayBuffer:()=>new Promise(resolve=>{release=()=>resolve(new TextEncoder().encode('# B').buffer);})};
  const pending = importHistoryDirectory([delayed],{state:first.state,sourceId:first.sourceId,signal:controller.signal});
  controller.abort();release();const result = await pending;
  assert.equal(result.cancelled,true);assert.deepEqual(result.state,first.state);
});

test('read failure or invalid UTF8 rolls back prior reads and never interprets disappearance as deletion',async () => {
  const first = await imported([file('archive/a.md','# A'),file('archive/b.md','# B')]);
  for (const bad of [file('archive/b.md','',{error:'SECRET_ERROR_BODY'}),file('archive/b.md','',{bytes:Uint8Array.of(0xff)})]) {
    const next = await importHistoryDirectory([file('archive/a.md','# changed'),bad],{state:first.state,sourceId:first.sourceId});
    assert.equal(next.committed,false);assert.deepEqual(next.state,first.state);assert.ok(hasIssue(next,'read-error'));
    assert.doesNotMatch(JSON.stringify(next),/SECRET_ERROR_BODY|# changed/);
  }
});

test('candidate limits ignore unsupported docs and backups before any file bytes are read',async () => {
  let ignored=0,articles=0;
  const excluded = ['README.md','README.zh-CN.md','AGENTS.md','CHANGELOG.md','LICENSE.md','backup.md','bak.md','备份.md','backup-20261013.md',
    '备份-2026-10-13.md','a.backup.2026-10-13.md','a.backup.md','a_bak.md','a（备份）.md',
    '.obsidian/a.md','.git/a.md','.trash/a.md','backups/a.md','backup/a.md','备份/a.md','x/.hidden/a.md','image.png','a.txt'];
  const files = excluded.map(path=>file('archive/'+path,'PRIVATE_META',{read:()=>ignored++}));
  files.push(file('archive/保留 空格.md','# Article',{read:()=>articles++}));
  const next = await importHistoryDirectory(files,{maxFiles:1});
  assert.equal(next.committed,true);assert.equal(next.state.items.length,1);assert.equal(ignored,0);assert.equal(articles,1);
  assert.equal(next.skipped,excluded.length);assert.doesNotMatch(JSON.stringify(next.state),/PRIVATE_META/);
});

test('eligible candidate count and byte limits roll back the entire source update',async () => {
  const first = await imported([file('archive/a.md','# A')]);
  for (const options of [{maxFiles:1},{maxTotalBytes:5},{maxFileBytes:5}]) {
    const next = await importHistoryDirectory([file('archive/a.md','# changed'),file('archive/b.md','# new')],{state:first.state,sourceId:first.sourceId,...options});
    assert.equal(next.committed,false);assert.deepEqual(next.state,first.state);assert.ok(next.issues.length);
  }
  const actualSize = await importHistoryDirectory([file('archive/a.md','# A LONG STRING',{size:1})],{state:first.state,sourceId:first.sourceId,maxFileBytes:5});
  assert.equal(actualSize.committed,false);assert.deepEqual(actualSize.state,first.state);
});

test('metadata rejects unsafe paths and forged source IDs without body/path coercion',() => {
  for (const path of ['../a.md','/a.md','D:/a.md','a\\b.md','a/../b.md','%2e%2e/private.md','nested/%2e%2e/private.md','%2Fprivate.md','%252e%252e/a.md']) assert.equal(isArticleRelativePath(path),false,path);
  assert.equal(isArticleRelativePath('中文 空格/一.md'),true);
  const item = {id:fingerprintText('a'),title:'A',name:'a.md'};
  const normalized = normalizeHistoryState({items:[item],sources:[{id:2,label:'archive',entries:[]},{id:true,label:'archive',entries:[]},
    {id:'d-safe',label:'archive',body:'SECRET',absolutePath:'D:/secret',entries:[{path:'a.md',articleId:item.id,fingerprint:item.id,body:'SECRET'},
      {path:'../private.md',articleId:item.id,fingerprint:item.id}]}],manualIds:[item.id,item.id,'missing']});
  assert.deepEqual(normalized.sources,[{id:'d-safe',label:'archive',entries:[{path:'a.md',articleId:item.id,fingerprint:item.id}]}]);
  assert.deepEqual(normalized.manualIds,[item.id]);assert.doesNotMatch(JSON.stringify(normalized),/SECRET|D:|absolutePath|body/);
});

test('manual files add explicit references; directory deletion then preserves selected manual article',async () => {
  const first = await imported([file('archive/a.md','# A')]);
  const manual = await importManualHistoryFiles([file('A.txt','# A')],{state:{...first.state,selectedIds:[first.state.items[0].id]}});
  assert.equal(manual.committed,true);assert.equal(manual.added,0);assert.deepEqual(manual.state.manualIds,manual.state.selectedIds);
  const removed = removeHistoryDirectory(manual.state,first.sourceId);
  assert.equal(removed.sources.length,0);assert.equal(removed.items.length,1);assert.deepEqual(removed.selectedIds,manual.state.selectedIds);
});

test('manual duplicate matching uses current fingerprint after a stable-ID directory edit',async () => {
  const first = await imported([file('archive/a.md','# A')]);
  const refreshed = await imported([file('archive/a.md','# B')],first.state,first.sourceId);
  const manual = await importManualHistoryFiles([file('B.txt','# B')],{state:refreshed.state});
  assert.equal(manual.state.items.length,1);assert.deepEqual(manual.state.manualIds,[first.state.items[0].id]);
  const oldContent = await importManualHistoryFiles([file('A.txt','# A')],{state:manual.state});
  assert.equal(oldContent.state.items.length,2);assert.notEqual(oldContent.state.items[1].id,oldContent.state.items[0].id);
  assert.equal(oldContent.state.items[1].title,'A');
});

test('manual current fingerprint survives the final directory removal and does not confuse former content',async () => {
  const first=await imported([file('archive/a.md','# A')]);
  const refreshed=await imported([file('archive/a.md','# B')],first.state,first.sourceId);
  const manual=await importManualHistoryFiles([file('b.md','# B')],{state:refreshed.state});
  const removed=removeHistoryDirectory(manual.state,first.sourceId);
  assert.deepEqual(removed.manualEntries,[{articleId:first.state.items[0].id,fingerprint:fingerprintText('# B')}]);
  const repeated=await importManualHistoryFiles([file('b.md','# B')],{state:removed});
  assert.equal(repeated.added,0);assert.equal(repeated.state.items.length,1);assert.equal(repeated.state.items[0].title,'B');
  const previous=await importManualHistoryFiles([file('a.md','# A')],{state:repeated.state});
  assert.equal(previous.added,1);assert.equal(previous.state.items.length,2);assert.equal(previous.state.items[1].title,'A');
  assert.notEqual(previous.state.items[0].id,previous.state.items[1].id);
});

test('unknown old manual fingerprints are preserved without treating their stable IDs as current content',async () => {
  const id=fingerprintText('# A');
  const state=normalizeHistoryState({items:[{id,title:'B',name:'b.md'}],selectedIds:[id],sources:[],manualIds:[id]});
  const previous=await importManualHistoryFiles([file('a.md','# A')],{state});
  assert.equal(previous.state.items.length,2);assert.equal(previous.state.items[0].title,'B');assert.equal(previous.state.items[1].title,'A');
  assert.deepEqual(previous.state.selectedIds,[id]);
});

test('manual file reference makes later directory edits fork while retaining the manually chosen original',async () => {
  const first = await imported([file('archive/a.md','# A')]);
  const manual = await importManualHistoryFiles([file('a.md','# A')],{state:{...first.state,selectedIds:[first.state.items[0].id]}});
  const next = await imported([file('archive/a.md','# B')],manual.state,first.sourceId);
  assert.equal(next.state.items.length,2);assert.deepEqual(next.state.selectedIds,manual.state.selectedIds);assert.ok(hasIssue(next,'shared-change'));
});

test('unbound legacy entries stay; exact fingerprint may bind without guessing title or filename',async () => {
  const legacy = [{id:fingerprintText('# Bound'),title:'Bound',name:'a.md'},{id:fingerprintText('# unrelated'),title:'Same',name:'same.md'}];
  const next = await imported([file('archive/a.md','# Bound'),file('archive/same.md','# Same\nDIFFERENT BODY')],{items:legacy,selectedIds:legacy.map(item=>item.id),footer:null});
  assert.equal(next.state.items.length,3);assert.equal(next.state.sources[0].entries[0].articleId,legacy[0].id);
  assert.ok(next.state.items.some(item => item.id === legacy[1].id));assert.ok(hasIssue(next,'legacy-unbound'));
  const refreshed = await imported([file('archive/README.md')],next.state,next.sourceId);
  assert.ok(refreshed.state.items.some(item=>item.id === legacy[1].id));assert.ok(!refreshed.state.items.some(item=>item.id === legacy[0].id));
});

test('selection/reorder helpers retain source metadata; index removal cleans all references',async () => {
  const first = await imported([file('archive/a.md','# A'),file('archive/b.md','# B')]);let state=first.state;
  for(const item of state.items) state=toggleHistorySelection(state,item.id,true);
  state=moveHistorySelection(state,state.items[1].id,'up');assert.deepEqual(state.sources,first.state.sources);
  state=removeHistoryItem(state,state.items[0].id);assert.equal(state.sources[0].entries.length,1);assert.equal(state.selectedIds.length,1);
  assert.deepEqual(state.manualIds,[]);
});

test('malformed/mixed roots or duplicate relative paths never read or partly update',async () => {
  let reads=0;const first=await imported([file('archive/a.md','# A')]);
  const cases = [[{name:'a.md',arrayBuffer:async()=>{reads++;}}],[file('archive/a.md','',{read:()=>reads++}),file('other/b.md','',{read:()=>reads++})],
    [file('archive/a.md','one',{read:()=>reads++}),file('archive/a.md','two',{read:()=>reads++})],
    [file('D:/archive/a.md','',{read:()=>reads++})]];
  for(const files of cases) {
    const next=await importHistoryDirectory(files,{state:first.state,sourceId:first.sourceId});
    assert.equal(next.committed,false);assert.deepEqual(next.state,first.state);
  }
  assert.equal(reads,0);
});

test('2000 item limit is atomic while replacing one formerly-owned item at capacity succeeds',async () => {
  const loose = Array.from({length:1999},(_,i)=>({id:`legacy-${i}`,title:`Legacy ${i}`,name:`l-${i}.md`}));
  const first=await imported([file('archive/a.md','# A')],{items:loose,selectedIds:[],footer:null});
  assert.equal(first.state.items.length,2000);
  const extra=await importHistoryDirectory([file('articles/b.md','# B')],{state:first.state});
  assert.equal(extra.committed,false);assert.ok(hasIssue(extra,'index-limit'));assert.deepEqual(extra.state,first.state);
  const replacement=await imported([file('archive/b.md','# B')],first.state,first.sourceId);
  assert.equal(replacement.state.items.length,2000);assert.equal(replacement.removed,1);assert.equal(replacement.added,1);
});

test('explicit source removal preserves other-source and unbound legacy records without reading',async () => {
  const first=await imported([file('archive/a.md','# A')],{items:[{id:'legacy',title:'Legacy',name:'legacy.md'}],selectedIds:['legacy'],footer:null});
  const second=await imported([file('articles/a.md','# A')],first.state);
  const next=removeHistoryDirectory(second.state,first.sourceId);
  assert.equal(next.items.length,2);assert.deepEqual(next.selectedIds,['legacy']);assert.equal(next.sources.length,1);
  assert.deepEqual(removeHistoryDirectory(next,'missing'),next);
});

test('repeated footer/render/copy/export include only checked display titles, never paths or history bodies',async () => {
  const first=await imported([file('archive/nested/a.md','# ![A](https://bad)\nPRIVATE_A'),file('archive/b.md','# B\nPRIVATE_B')]);
  let state=toggleHistorySelection(first.state,first.state.items[0].id,true),source='# Current\nCurrent body';
  for(let i=0;i<5;i++) {const next=syncRelatedFooter(source,active(state),state.footer);source=next.source;state={...state,footer:next.footer};}
  const rendered=renderArticle(source,{markdownFactory,index:buildImageIndex([])});let copied;
  class Item {constructor(data){this.data=data;}}
  await copyRichText({html:rendered.html,text:source,clipboard:{write:async items=>{copied=items[0];}},ClipboardItemCtor:Item,documentRef:null});
  const html=wrapArticleHtml(rendered.html,'Current');
  assert.equal(await copied.data['text/html'].text(),rendered.html);assert.equal(await copied.data['text/plain'].text(),source);
  assert.ok(html.includes(rendered.html));assert.doesNotMatch(source+html,/PRIVATE_A|PRIVATE_B|nested\/a\.md|archive|<a\b|<img\b/);
  assert.equal(source.split('相关文章推荐：').length-1,1);assert.equal(rendered.images.length,0);
  assert.doesNotMatch(source,/- B/);
});
