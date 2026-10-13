import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {makeDraft,validateDraft,createDraftRepository} from '../drafts.mjs';
import {fingerprintText,normalizeHistoryState,toggleHistorySelection,moveHistorySelection,
  removeHistoryItem,syncRelatedFooter} from '../history.mjs';
import {renderArticle} from '../core.mjs';
import {copyRichText} from '../clipboard.mjs';
import {wrapArticleHtml} from '../app.mjs';
import {importHistoryDirectory,importManualHistoryFiles,removeHistoryDirectory} from '../directories.mjs';
import {normalizePresentation,DEFAULT_PRESENTATION} from '../layout-settings.mjs';

const markdownFactory=createRequire(import.meta.url)('../vendor/markdown-it.cjs');
const firstId=fingerprintText('# First\nPRIVATE_HISTORY_BODY_A');
const secondId=fingerprintText('# Second\nPRIVATE_HISTORY_BODY_B');
const thirdId=fingerprintText('# Unselected\nPRIVATE_HISTORY_BODY_C');
const labels=['\u5f80\u671f\u6587\u7ae0','\u6587\u7ae0'];
const records=()=>[
  {id:firstId,title:'\u4e2d\u6587\u7a7a\u683c & <tag> [brackets] *stars*',name:'\u4e00 \u7a7a\u683c.md'},
  {id:secondId,title:'Second article',name:'two.md'},
  {id:thirdId,title:'PRIVATE_UNSELECTED_TITLE',name:'three.md'}
];
const metadata=()=>({items:records(),selectedIds:[secondId,firstId],footer:null,
  sources:[
    {id:'d-past',label:labels[0],entries:[
      {path:'nested/\u4e00 \u7a7a\u683c.md',articleId:firstId,fingerprint:firstId},
      {path:'two.md',articleId:secondId,fingerprint:secondId}
    ]},
    {id:'d-articles',label:labels[1],entries:[
      {path:'copy.md',articleId:firstId,fingerprint:firstId},
      {path:'three.md',articleId:thirdId,fingerprint:thirdId}
    ]}
  ],manualIds:[secondId]});
const draft=(markdown='# Current article\n\nCurrent body',relatedArticles)=>makeDraft({markdown,
  theme:'warm',articlePath:'current.md',stripFrontmatter:false,assets:new Map(),relatedArticles});
const roundTrip=input=>validateDraft(JSON.parse(JSON.stringify(input)));
const selected=state=>state.selectedIds.map(id=>state.items.find(item=>item.id===id)).filter(Boolean);
const presentationDraft=(presentation,markdown='# Current article\n\nCurrent body',relatedArticles)=>makeDraft({
  markdown,theme:'warm',articlePath:'current.md',stripFrontmatter:false,assets:new Map(),relatedArticles,presentation});

function memoryBackend() {
  const records=new Map();
  return {records,getAll:async()=>[...records.values()].map(record=>structuredClone(record)),
    get:async id=>structuredClone(records.get(id)),put:async record=>records.set(record.id,structuredClone(record)),
    delete:async id=>records.delete(id),clear:async()=>records.clear()};
}

function directoryFile(root,path,text,{read=()=>{}}={}) {
  const bytes=new TextEncoder().encode(text);
  return {name:path.split('/').at(-1),webkitRelativePath:`${root}/${path}`,size:bytes.length,
    async arrayBuffer(){read();return bytes.buffer.slice(0);}};
}

test('v3 restoration leaves a v1 draft source-free and preserves the old exact history keys',()=>{
  const legacy={format:'xieyuliao-draft',version:1,markdown:'# Original\n\nKeep me',theme:'ink',
    articlePath:'old.md',stripFrontmatter:false,assets:[],savedAt:'2026-10-13T00:00:00.000Z'};
  const restored=roundTrip(legacy);
  assert.deepEqual(restored.relatedArticles,{items:[],selectedIds:[],footer:null});
  assert.deepEqual(Object.keys(restored.relatedArticles),['items','selectedIds','footer']);
  assert.equal(restored.markdown,legacy.markdown);
  assert.equal(restored.stripFrontmatter,false);
});

test('v2 title-only indices do not acquire inferred directory sources on restoration',()=>{
  const old={items:records(),selectedIds:[secondId,firstId],footer:null,
    source:'X:/Example Vault/old',directory:'PRIVATE_PATH',handles:[{name:'private'}]};
  const restored=roundTrip(draft('# Original',old));
  assert.deepEqual(restored.relatedArticles,{items:records(),selectedIds:[secondId,firstId],footer:null});
  assert.deepEqual(Object.keys(restored.relatedArticles),['items','selectedIds','footer']);
});

test('portable v3 drafts round-trip two local directory indices, shared content, order and manual provenance',()=>{
  const original=draft('# Current article',metadata());
  const restored=roundTrip(original);
  assert.deepEqual(restored,original);
  assert.deepEqual(restored.relatedArticles,metadata());
  assert.deepEqual(restored.relatedArticles.selectedIds,[secondId,firstId]);
  assert.equal(restored.relatedArticles.sources[0].entries[0].articleId,restored.relatedArticles.sources[1].entries[0].articleId);
  for (const item of restored.relatedArticles.items) assert.deepEqual(Object.keys(item),['id','title','name']);
});

test('directory metadata is allowlisted and never serializes historical bodies, handles, URLs or absolute paths',()=>{
  const secret='PRIVATE_HISTORY_BODY_FILE_OR_HANDLE';
  const injected={body:secret,markdown:secret,file:{text:secret},handle:{name:secret},
    directoryHandle:{name:secret},url:'https://private.invalid',absolutePath:'X:/Example Vault/private.md'};
  const input=metadata();
  Object.assign(input,injected);
  input.items=input.items.map(item=>({...item,...injected}));
  input.sources=input.sources.map(source=>({...source,...injected,
    entries:source.entries.map(entry=>({...entry,...injected}))}));
  const restored=roundTrip(draft('# Current',input));
  assert.deepEqual(restored.relatedArticles,metadata());
  const saved=JSON.stringify(restored.relatedArticles);
  assert.doesNotMatch(saved,/PRIVATE_HISTORY_BODY_FILE_OR_HANDLE|private\.invalid|Example Vault|absolutePath|directoryHandle|"body"|"file"|"handle"|"url"/);
  for (const source of restored.relatedArticles.sources) {
    assert.deepEqual(Object.keys(source).sort(),['entries','id','label']);
    for (const entry of source.entries) assert.deepEqual(Object.keys(entry).sort(),['articleId','fingerprint','path']);
  }
});

test('restored source entries reject unsafe parent, absolute, encoded and control-character paths',()=>{
  const unsafe=['../private.md','nested/../private.md','/private.md','D:/private.md','D:\\private.md',
    '\\\\server\\private.md','%2e%2e/private.md','nested/%2e%2e/private.md','%2Fprivate.md','file:///private.md',
    '%252e%252e/private.md','D%3A/private.md','%5c%5cserver/private.md',
    'nested/secret\u0000.md','README.md','backups/old.md','.git/old.md'];
  const input=metadata();
  input.sources=[{id:'d-safe',label:labels[0],entries:[
    {path:'nested/\u4e2d\u6587 \u7a7a\u683c.md',articleId:firstId,fingerprint:firstId},
    ...unsafe.map(path=>({path,articleId:secondId,fingerprint:secondId}))
  ]}];
  const restored=roundTrip(draft('# Current',input));
  assert.deepEqual(restored.relatedArticles.sources[0].entries,[
    {path:'nested/\u4e2d\u6587 \u7a7a\u683c.md',articleId:firstId,fingerprint:firstId}
  ]);
  assert.deepEqual(restored.relatedArticles.items,records());
});

test('invalid source IDs, duplicate paths and unknown article/manual IDs are filtered on restore',()=>{
  const input=metadata();
  input.sources=[input.sources[0],{...input.sources[0],label:'Duplicate ID'},
    {id:'../bad',label:'Unsafe ID',entries:input.sources[0].entries},
    {id:12,label:'Numeric ID',entries:input.sources[0].entries},
    {id:true,label:'Boolean ID',entries:input.sources[0].entries},
    {id:'d-valid',label:'Other',entries:[
      {path:'three.md',articleId:thirdId,fingerprint:thirdId},
      {path:'three.md',articleId:secondId,fingerprint:secondId},
      {path:'missing.md',articleId:'missing',fingerprint:firstId},
      {path:'bad-fingerprint.md',articleId:firstId,fingerprint:'not-a-fingerprint'},
      {path:'wrapped-fingerprint.md',articleId:firstId,fingerprint:new String(firstId)},
      {path:'object-fingerprint.md',articleId:firstId,fingerprint:{toString:()=>firstId,body:'PRIVATE_HASH_SECRET'}}
    ]}];
  input.manualIds=[secondId,'missing',secondId,null,firstId];
  input.selectedIds=[secondId,'missing',firstId,secondId];
  const restored=roundTrip(draft('# Current',input));
  assert.deepEqual(restored.relatedArticles.sources.map(source=>source.id),['d-past','d-valid']);
  assert.deepEqual(restored.relatedArticles.sources[1].entries,[{path:'three.md',articleId:thirdId,fingerprint:thirdId}]);
  assert.deepEqual(restored.relatedArticles.manualIds,[secondId,firstId]);
  assert.deepEqual(restored.relatedArticles.selectedIds,[secondId,firstId]);
  assert.doesNotMatch(JSON.stringify(draft('# Current',input).relatedArticles),/PRIVATE_HASH_SECRET/);
});

test('selection toggles and reordering preserve restored source provenance without granting handles',()=>{
  const restored=roundTrip(draft('# Current',metadata())).relatedArticles;
  let next=toggleHistorySelection(restored,thirdId,true);
  next=moveHistorySelection(next,thirdId,'up');
  next=toggleHistorySelection(next,secondId,false);
  assert.deepEqual(next.selectedIds,[thirdId,firstId]);
  assert.deepEqual(next.sources,restored.sources);
  assert.deepEqual(next.manualIds,restored.manualIds);
  assert.deepEqual(roundTrip(draft('# Current',next)).relatedArticles,next);
  assert.deepEqual(restored.selectedIds,[secondId,firstId]);
});

test('deleting an item removes its source references and selections while other sources remain intact',()=>{
  const restored=roundTrip(draft('# Current',metadata())).relatedArticles;
  const removed=removeHistoryItem(restored,firstId);
  assert.deepEqual(removed.items,records().slice(1));
  assert.deepEqual(removed.selectedIds,[secondId]);
  assert.ok(removed.sources.every(source=>source.entries.every(entry=>entry.articleId!==firstId)));
  assert.ok(removed.sources.flatMap(source=>source.entries).some(entry=>entry.articleId===secondId));
  assert.deepEqual(removed.manualIds,[secondId]);
  assert.deepEqual(roundTrip(draft('# Current',removed)).relatedArticles,removed);
  assert.deepEqual(restored.sources,metadata().sources);
});

test('repository backup round-trip retains a recoverable directory snapshot and does not share caller arrays',async()=>{
  const backend=memoryBackend();
  const store=createDraftRepository(backend,{now:()=>1000});
  const original=draft('# Current',metadata());
  await store.save(original);
  original.relatedArticles.sources[0].entries.length=0;
  original.relatedArticles.selectedIds.length=0;
  const first=await store.loadLatest();
  assert.deepEqual(first.relatedArticles,metadata());
  const removed=removeHistoryItem(first.relatedArticles,thirdId);
  await store.save(draft(first.markdown,removed));
  const backups=await store.listBackups();
  assert.equal(backups.length,2);
  const earlier=await store.loadBackup(backups[1].id);
  assert.deepEqual(earlier.relatedArticles,metadata());
  assert.deepEqual((await store.loadLatest()).relatedArticles.items,records().slice(0,2));
});

test('invalid optional provenance is not required for a valid draft or its original text',()=>{
  for (const extra of [{sources:'D:/private',manualIds:'bad'},
    {sources:[null,{id:12,label:'x',entries:[]}],manualIds:[null,'unknown']},
    {sources:[{id:'d-safe',label:'x',entries:'file://private'}]}]) {
    const restored=roundTrip(draft('# Original\n\nDo not erase',{
      items:records(),selectedIds:[firstId],footer:null,...extra}));
    assert.equal(restored.markdown,'# Original\n\nDo not erase');
    assert.deepEqual(restored.relatedArticles.items,records());
    assert.deepEqual(restored.relatedArticles.selectedIds,[firstId]);
    assert.doesNotMatch(JSON.stringify(restored.relatedArticles),/D:\/private|file:\/\/private/);
    assert.deepEqual(normalizeHistoryState(restored.relatedArticles),restored.relatedArticles);
  }
});

test('repeated restored directory-footer synchronization renders once and copy/export contain only chosen title text',async()=>{
  const body='# Current article\n\nCurrent body';
  const state=metadata();
  const initial=syncRelatedFooter(body,selected(state));
  let restored=roundTrip(draft(initial.source,{...state,footer:initial.footer}));
  for (let i=0;i<5;i++) {
    const synced=syncRelatedFooter(restored.markdown,selected(restored.relatedArticles),restored.relatedArticles.footer);
    assert.equal(synced.conflict,false);
    assert.equal(synced.changed,false);
    restored=roundTrip(draft(synced.source,{...restored.relatedArticles,footer:synced.footer}));
  }
  const header='\u76f8\u5173\u6587\u7ae0\u63a8\u8350\uff1a';
  assert.equal(restored.markdown.split(header).length-1,1);
  const preview=renderArticle(restored.markdown,{markdownFactory});
  const exported=wrapArticleHtml(preview.html,'Current');
  let copied;class Item {constructor(data){this.data=data;}}
  await copyRichText({html:preview.html,text:preview.source,clipboard:{write:async items=>{copied=items[0];}},
    ClipboardItemCtor:Item,BlobCtor:Blob,documentRef:null});
  const copyHtml=await copied.data['text/html'].text();
  const copyPlain=await copied.data['text/plain'].text();
  assert.equal(copyHtml,preview.html);assert.equal(copyPlain,restored.markdown);
  assert.ok(exported.includes(preview.html));
  for (const payload of [preview.html,exported,copyHtml,copyPlain]) {
    assert.doesNotMatch(payload,/PRIVATE_UNSELECTED_TITLE|PRIVATE_HISTORY_BODY|nested\/|copy\.md|two\.md|d-past|d-articles|manualIds|sources|<a\b|<img\b/);
    assert.equal(payload.split(header).length-1,1);
  }
  assert.match(preview.html,/&lt;tag&gt;/);
});

test('restored shared content survives refreshing one directory after that directory deletes its copy',async()=>{
  const shared='# Shared\nPRIVATE_HISTORY_BODY_SHARED';
  const first=await importHistoryDirectory([directoryFile(labels[0],'shared.md',shared)]);
  const second=await importHistoryDirectory([directoryFile(labels[1],'nested/shared-copy.md',shared)],{state:first.state});
  assert.equal(first.committed,true);assert.equal(second.committed,true);
  assert.equal(second.state.items.length,1);
  const id=second.state.items[0].id;
  const selectedState=toggleHistorySelection(second.state,id,true);
  const initial=syncRelatedFooter('# Current',selected(selectedState));
  const restored=roundTrip(draft(initial.source,{...selectedState,footer:initial.footer}));
  let ignoredReads=0;
  const refreshed=await importHistoryDirectory([directoryFile(labels[0],'README.md','DO_NOT_READ',{
    read:()=>ignoredReads++})],{state:restored.relatedArticles,sourceId:first.sourceId});
  assert.equal(refreshed.committed,true);assert.equal(ignoredReads,0);
  assert.equal(refreshed.removed,0);assert.equal(refreshed.state.items.length,1);
  assert.deepEqual(refreshed.state.selectedIds,[id]);
  assert.deepEqual(refreshed.state.sources.find(source=>source.id===first.sourceId).entries,[]);
  assert.equal(refreshed.state.sources.find(source=>source.id===second.sourceId).entries[0].articleId,id);
  const synced=syncRelatedFooter(restored.markdown,selected(refreshed.state),refreshed.state.footer);
  assert.equal(synced.changed,false);assert.equal(synced.conflict,false);
  assert.doesNotMatch(synced.source,/PRIVATE_HISTORY_BODY_SHARED|nested\/|shared-copy\.md/);
  assert.deepEqual(roundTrip(draft(synced.source,{...refreshed.state,footer:synced.footer})).relatedArticles,refreshed.state);
});

test('restored directory refresh keeps a same-path title edit selected, drops deleted items and replaces its footer once',async()=>{
  const imported=await importHistoryDirectory([
    directoryFile(labels[0],'kept.md','# Before title\nPRIVATE_HISTORY_BODY_BEFORE'),
    directoryFile(labels[0],'deleted.md','# Deleted article\nPRIVATE_HISTORY_BODY_DELETED'),
    directoryFile(labels[0],'last.md','# Last article\nPRIVATE_HISTORY_BODY_LAST')
  ]);
  const [kept,deleted,last]=imported.state.items;
  let state=imported.state;
  for (const item of [last,deleted,kept]) state=toggleHistorySelection(state,item.id,true);
  const initial=syncRelatedFooter('# Current\n\nKeep original body',selected(state));
  const restored=roundTrip(draft(initial.source,{...state,footer:initial.footer}));
  const refreshed=await importHistoryDirectory([
    directoryFile(labels[0],'last.md','# Last article\nPRIVATE_HISTORY_BODY_LAST'),
    directoryFile(labels[0],'kept.md','# Changed title & <safe>\nPRIVATE_HISTORY_BODY_AFTER')
  ],{state:restored.relatedArticles,sourceId:imported.sourceId});
  assert.equal(refreshed.committed,true);
  assert.equal(refreshed.updated,1);assert.equal(refreshed.removed,1);
  assert.deepEqual(refreshed.state.selectedIds,[last.id,kept.id]);
  assert.equal(refreshed.state.items.find(item=>item.id===kept.id).title,'Changed title & <safe>');
  const entry=refreshed.state.sources[0].entries.find(entry=>entry.path==='kept.md');
  assert.equal(entry.articleId,kept.id);
  assert.notEqual(entry.fingerprint,restored.relatedArticles.sources[0].entries.find(entry=>entry.path==='kept.md').fingerprint);
  const synced=syncRelatedFooter(restored.markdown,selected(refreshed.state),refreshed.state.footer);
  assert.equal(synced.conflict,false);assert.equal(synced.changed,true);
  assert.ok(synced.source.startsWith('# Current\n\nKeep original body'));
  assert.doesNotMatch(synced.source,/Before title|Deleted article|PRIVATE_HISTORY_BODY/);
  assert.match(synced.source,/- Last article\n- Changed title/);
  const saved=roundTrip(draft(synced.source,{...refreshed.state,footer:synced.footer}));
  for (let i=0;i<3;i++) {
    const repeat=syncRelatedFooter(saved.markdown,selected(saved.relatedArticles),saved.relatedArticles.footer);
    assert.equal(repeat.changed,false);assert.equal(repeat.source,saved.markdown);
  }
});

test('unknown legacy provenance stays unbound during refresh and is not inferred from title or filename',async()=>{
  const unknown={id:'old-unknown',title:'Legacy title',name:'same.md'};
  const legacy=roundTrip(draft('# Current',{items:[unknown],selectedIds:[unknown.id],footer:null}));
  const imported=await importHistoryDirectory([directoryFile(labels[0],'same.md','# Legacy title\nNew distinct body')],
    {state:legacy.relatedArticles});
  assert.equal(imported.committed,true);assert.equal(imported.state.items.length,2);
  assert.deepEqual(imported.state.items[0],unknown);
  assert.ok(imported.issues.some(issue=>issue.status==='legacy-unbound'));
  const restored=roundTrip(draft(legacy.markdown,imported.state));
  const refreshed=await importHistoryDirectory([directoryFile(labels[0],'README.md','Ignored')],
    {state:restored.relatedArticles,sourceId:imported.sourceId});
  assert.equal(refreshed.committed,true);assert.deepEqual(refreshed.state.items,[unknown]);
  assert.deepEqual(refreshed.state.selectedIds,[unknown.id]);
  assert.deepEqual(refreshed.state.sources[0].entries,[]);
  assert.deepEqual(refreshed.state.manualIds,[]);
});

test('cancelling reselection of a restored directory keeps titles, sources, selected order and footer unchanged',async()=>{
  const state=metadata();
  const initial=syncRelatedFooter('# Current',selected(state));
  const restored=roundTrip(draft(initial.source,{...state,footer:initial.footer}));
  const empty=await importHistoryDirectory([],{state:restored.relatedArticles,sourceId:'d-past'});
  assert.equal(empty.cancelled,true);assert.equal(empty.committed,false);
  assert.deepEqual(empty.state,restored.relatedArticles);
  const controller=new AbortController();let reads=0;
  controller.abort();
  const aborted=await importHistoryDirectory([directoryFile(labels[0],'changed.md','# Changed',{
    read:()=>reads++})],{state:restored.relatedArticles,sourceId:'d-past',signal:controller.signal});
  assert.equal(reads,0);assert.equal(aborted.cancelled,true);assert.equal(aborted.committed,false);
  assert.deepEqual(aborted.state,restored.relatedArticles);
  const cancelledDraft=roundTrip(draft(restored.markdown,aborted.state));
  assert.equal(cancelledDraft.markdown,restored.markdown);
  assert.deepEqual(cancelledDraft.relatedArticles,restored.relatedArticles);
});

test('explicitly imported single-file provenance survives restored directory deletion without duplicate content',async()=>{
  const text='# Manually retained\nPRIVATE_HISTORY_BODY_MANUAL';
  const imported=await importHistoryDirectory([directoryFile(labels[0],'one.md',text)]);
  const id=imported.state.items[0].id;
  const manual=await importManualHistoryFiles([directoryFile('ignored','copy.txt',text)],{state:imported.state});
  assert.equal(manual.committed,true);assert.equal(manual.state.items.length,1);
  assert.deepEqual(manual.state.manualIds,[id]);
  const state=toggleHistorySelection(manual.state,id,true);
  const restored=roundTrip(draft('# Current',state));
  const refreshed=await importHistoryDirectory([directoryFile(labels[0],'README.md','Ignored')],
    {state:restored.relatedArticles,sourceId:imported.sourceId});
  assert.equal(refreshed.committed,true);assert.deepEqual(refreshed.state.items,restored.relatedArticles.items);
  assert.deepEqual(refreshed.state.selectedIds,[id]);assert.deepEqual(refreshed.state.manualIds,[id]);
  assert.deepEqual(refreshed.state.sources[0].entries,[]);
  assert.doesNotMatch(JSON.stringify(refreshed.state),/PRIVATE_HISTORY_BODY_MANUAL/);
});

test('old drafts and makeDraft calls without presentation keep their exact field shape and original text',()=>{
  const source='---\ntitle: Original property\n---\n# Original\n\nKeep original text';
  const old=draft(source,metadata());
  const restored=roundTrip(old);
  assert.equal(Object.hasOwn(old,'presentation'),false);
  assert.equal(Object.hasOwn(restored,'presentation'),false);
  assert.deepEqual(Object.keys(restored),Object.keys(old));
  assert.deepEqual(restored,old);assert.equal(restored.markdown,source);
  assert.deepEqual(normalizePresentation(restored.presentation),DEFAULT_PRESENTATION);
});

test('presentation settings round-trip controlled font size, line height, accent, device and disabled scroll synchronization',()=>{
  const presentation={fontSize:18,lineHeight:1.9,accentColor:'#237a63',device:'tablet',scrollSync:false};
  const source='---\nprivateProperty: Keep\n---\n# Current\n\nOriginal body';
  const saved=presentationDraft(presentation,source,metadata());
  assert.deepEqual(saved.presentation,presentation);
  assert.deepEqual(roundTrip(saved),saved);
  assert.equal(saved.markdown,source);
  assert.equal(saved.stripFrontmatter,false);
  assert.deepEqual(saved.relatedArticles,metadata());
});

test('presentation normalization clamps finite numbers and strips unsafe CSS, unknown fields, paths and file handles',()=>{
  const input={fontSize:100,lineHeight:0,accentColor:'#A1B2C3',device:'desktop',scrollSync:false,
    css:'body{background:url(https://private.invalid)}',stylesheet:'PRIVATE_CSS_SECRET',style:'PRIVATE_CSS_SECRET',
    path:'X:/Example Vault/private.md',file:{name:'PRIVATE_FILE_SECRET'},handle:{name:'PRIVATE_HANDLE_SECRET'},
    body:'PRIVATE_SETTINGS_TEXT',url:'https://private.invalid'};
  const restored=roundTrip(presentationDraft(input));
  assert.deepEqual(restored.presentation,{fontSize:20,lineHeight:1.5,accentColor:'#a1b2c3',device:'desktop',scrollSync:false});
  assert.deepEqual(Object.keys(restored.presentation).sort(),['accentColor','device','fontSize','lineHeight','scrollSync']);
  assert.doesNotMatch(JSON.stringify(restored),/PRIVATE_CSS_SECRET|PRIVATE_FILE_SECRET|PRIVATE_HANDLE_SECRET|PRIVATE_SETTINGS_TEXT|private\.invalid|Example Vault/);
  const minimum=roundTrip(presentationDraft({fontSize:1,lineHeight:100}));
  assert.equal(minimum.presentation.fontSize,14);assert.equal(minimum.presentation.lineHeight,2.2);
});

test('invalid numeric strings, colors, device IDs and synchronization values safely restore defaults without changing Markdown',()=>{
  const source='# Original\n\nDo not rewrite';
  const invalid=[
    {fontSize:'18px',lineHeight:'1.8',accentColor:'red',device:'laptop',scrollSync:'false'},
    {fontSize:NaN,lineHeight:Infinity,accentColor:'#abc',device:'PHONE',scrollSync:0},
    {fontSize:{value:18},lineHeight:[],accentColor:'#abcdef;display:none',device:{id:'phone'},scrollSync:null},
    {fontSize:null,lineHeight:null,accentColor:null,device:['phone'],scrollSync:true},
    {fontSize:null,lineHeight:null,accentColor:null,device:{toString:()=> 'phone',body:'PRIVATE_SETTINGS_TEXT'},scrollSync:true},
    {fontSize:null,lineHeight:null,accentColor:'url(https://private.invalid)',device:'',scrollSync:undefined}
  ];
  for (const settings of invalid) {
    const restored=roundTrip(presentationDraft(settings,source));
    assert.deepEqual(restored.presentation,DEFAULT_PRESENTATION);
    assert.equal(restored.markdown,source);
    assert.doesNotMatch(JSON.stringify(restored),/PRIVATE_SETTINGS_TEXT/);
  }
});

test('explicitly supplied null or undefined presentation receives defaults while omission stays compatible',()=>{
  for (const presentation of [null,undefined,false,'PRIVATE_SETTINGS_TEXT',[],{css:'PRIVATE_SETTINGS_TEXT'}]) {
    const saved=presentationDraft(presentation);
    assert.equal(Object.hasOwn(saved,'presentation'),true);
    assert.deepEqual(saved.presentation,DEFAULT_PRESENTATION);
    assert.deepEqual(roundTrip(saved),saved);
    assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_SETTINGS_TEXT/);
  }
  assert.equal(Object.hasOwn(roundTrip(draft()),'presentation'),false);
});

test('repository presentation backups restore earlier choices and preserve disabled scroll sync without mutating caller settings',async()=>{
  const backend=memoryBackend();const store=createDraftRepository(backend,{now:()=>1000});
  const first=presentationDraft({fontSize:16.75,lineHeight:1.83,accentColor:'#0099aa',device:'phone',scrollSync:false});
  await store.save(first);
  first.presentation.fontSize=99;
  const second=presentationDraft({fontSize:19,lineHeight:2,accentColor:'#bb4411',device:'desktop',scrollSync:true});
  await store.save(second);
  const latest=await store.loadLatest();assert.deepEqual(latest.presentation,second.presentation);
  const backups=await store.listBackups();const earlier=await store.loadBackup(backups[1].id);
  assert.deepEqual(earlier.presentation,{fontSize:16.75,lineHeight:1.83,accentColor:'#0099aa',device:'phone',scrollSync:false});
  assert.equal(earlier.markdown,latest.markdown);
  await store.save(draft('# Legacy call without settings'));
  assert.equal(Object.hasOwn(await store.loadLatest(),'presentation'),false);
});

test('device width and synchronization preferences remain local metadata and cannot change public article HTML or copy text',async()=>{
  const source='# Current\n\nArticle body';
  const baseline=renderArticle(source,{theme:'warm',markdownFactory});
  for (const device of ['phone','tablet','desktop']) {
    for (const scrollSync of [false,true]) {
      const restored=roundTrip(presentationDraft({device,scrollSync},source));
      assert.equal(restored.presentation.device,device);assert.equal(restored.presentation.scrollSync,scrollSync);
      const rendered=renderArticle(restored.markdown,{theme:restored.theme,presentation:restored.presentation,markdownFactory});
      assert.equal(rendered.html,baseline.html);assert.equal(rendered.source,source);
      let copied;class Item {constructor(data){this.data=data;}}
      await copyRichText({html:rendered.html,text:rendered.source,clipboard:{write:async items=>{copied=items[0];}},
        ClipboardItemCtor:Item,BlobCtor:Blob,documentRef:null});
      const copyHtml=await copied.data['text/html'].text();const copyPlain=await copied.data['text/plain'].text();
      const exported=wrapArticleHtml(rendered.html,'Current');
      assert.equal(copyHtml,baseline.html);assert.equal(copyPlain,source);assert.ok(exported.includes(baseline.html));
      for (const payload of [rendered.html,exported,copyHtml,copyPlain]) {
        assert.doesNotMatch(payload,/"presentation"|"device"|"scrollSync"|tablet|desktop/);
      }
    }
  }
});

test('saving edited text with presentation settings preserves exact Markdown properties and a single editable recommendation footer',()=>{
  const base='---\ntitle: Keep property\n---\n# Original\n\nOriginal body';
  const state=metadata();const initial=syncRelatedFooter(base,selected(state));
  const settings={fontSize:17,lineHeight:2,accentColor:'#886644',device:'tablet',scrollSync:false};
  const saved=presentationDraft(settings,initial.source,{...state,footer:initial.footer});
  const edited=saved.markdown.replace('Original body','User edited body with [link](https://example.invalid)');
  // A text edit outside the tracked footer is kept verbatim; settings never create article text.
  const restored=roundTrip(presentationDraft(settings,edited,saved.relatedArticles));
  assert.equal(restored.markdown,edited);assert.deepEqual(restored.presentation,settings);
  assert.ok(restored.markdown.startsWith('---\ntitle: Keep property\n---\n# Original'));
  assert.equal(restored.markdown.split('\u76f8\u5173\u6587\u7ae0\u63a8\u8350\uff1a').length-1,1);
  assert.doesNotMatch(restored.markdown,/fontSize|lineHeight|accentColor|scrollSync|tablet/);
});

test('optional local display titles and title-source annotations survive draft normalization through a strict allowlist',()=>{
  const state=metadata();
  state.items[0]={...state.items[0],displayTitle:'User chosen title & <tag>',titleSource:'heading',body:'PRIVATE_HISTORY_BODY'};
  state.items[1]={...state.items[1],displayTitle:'Bad\u0000title',titleSource:'PRIVATE_UNKNOWN_SOURCE'};
  state.items[2]={...state.items[2],displayTitle:'x'.repeat(501),titleSource:'filename'};
  const restored=roundTrip(draft('# Current',state));
  assert.equal(restored.relatedArticles.items[0].title,records()[0].title);
  assert.equal(restored.relatedArticles.items[0].displayTitle,'User chosen title & <tag>');
  assert.equal(restored.relatedArticles.items[0].titleSource,'heading');
  assert.equal(Object.hasOwn(restored.relatedArticles.items[1],'displayTitle'),false);
  assert.equal(Object.hasOwn(restored.relatedArticles.items[1],'titleSource'),false);
  assert.equal(Object.hasOwn(restored.relatedArticles.items[2],'displayTitle'),false);
  assert.equal(restored.relatedArticles.items[2].titleSource,'filename');
  assert.doesNotMatch(JSON.stringify(restored),/PRIVATE_HISTORY_BODY|PRIVATE_UNKNOWN_SOURCE|Bad/);
});

test('optional manual current fingerprints round-trip only valid explicit references and strip unsafe metadata',()=>{
  const state=metadata();
  state.manualEntries=[
    {articleId:secondId,fingerprint:{toString:()=>firstId,body:'PRIVATE_HASH_SECRET'}},
    {articleId:secondId,fingerprint:new String(firstId)},
    {articleId:secondId,fingerprint:firstId,body:'PRIVATE_HISTORY_BODY',file:{name:'PRIVATE_FILE_HANDLE'},
      handle:{name:'PRIVATE_FILE_HANDLE'},path:'D:/private.md',url:'https://private.invalid'},
    {articleId:secondId,fingerprint:firstId},
    {articleId:firstId,fingerprint:firstId},
    {articleId:'missing',fingerprint:thirdId},
    {articleId:secondId,fingerprint:'invalid'}
  ];
  const restored=roundTrip(draft('# Current',state));
  assert.deepEqual(restored.relatedArticles.manualEntries,[{articleId:secondId,fingerprint:firstId}]);
  assert.deepEqual(restored.relatedArticles.manualIds,[secondId]);
  assert.deepEqual(restored.relatedArticles.sources,metadata().sources);
  assert.doesNotMatch(JSON.stringify(restored.relatedArticles),/PRIVATE_HISTORY_BODY|PRIVATE_FILE_HANDLE|D:\/private|private\.invalid/);
  assert.doesNotMatch(JSON.stringify(draft('# Current',state).relatedArticles),/PRIVATE_HASH_SECRET/);
  assert.equal(typeof draft('# Current',state).relatedArticles.manualEntries[0].fingerprint,'string');
  assert.equal(Object.hasOwn(roundTrip(draft('# Legacy',metadata())).relatedArticles,'manualEntries'),false);
});

test('restored manually retained changed content deduplicates by its current fingerprint after its last directory source is removed',async()=>{
  const before='# Before title\nPRIVATE_HISTORY_BODY_A';
  const changed='# Changed title\nPRIVATE_HISTORY_BODY_B';
  const original=await importHistoryDirectory([directoryFile(labels[0],'one.md',before)]);
  const id=original.state.items[0].id;
  const updated=await importHistoryDirectory([directoryFile(labels[0],'one.md',changed)],
    {state:original.state,sourceId:original.sourceId});
  assert.equal(updated.state.items[0].id,id);
  const manuallyImported=await importManualHistoryFiles([directoryFile('ignored','manual.txt',changed)],{state:updated.state});
  const selectedState=toggleHistorySelection(manuallyImported.state,id,true);
  const restored=roundTrip(draft('# Current',selectedState));
  const removed=removeHistoryDirectory(restored.relatedArticles,original.sourceId);
  const restoredAgain=roundTrip(draft('# Current',removed));
  assert.deepEqual(restoredAgain.relatedArticles.sources,[]);
  assert.deepEqual(restoredAgain.relatedArticles.manualEntries,[{articleId:id,fingerprint:fingerprintText(changed)}]);
  const repeated=await importManualHistoryFiles([directoryFile('ignored','again.md',changed)],{state:restoredAgain.relatedArticles});
  assert.equal(repeated.added,0);assert.equal(repeated.state.items.length,1);
  assert.deepEqual(repeated.state.selectedIds,[id]);assert.equal(repeated.state.items[0].title,'Changed title');
  const oldContent=await importManualHistoryFiles([directoryFile('ignored','old.md',before)],{state:repeated.state});
  assert.equal(oldContent.added,1);assert.equal(oldContent.state.items.length,2);
  assert.equal(oldContent.state.items.find(item=>item.id===id).title,'Changed title');
  assert.ok(oldContent.state.items.some(item=>item.id!==id && item.title==='Before title'));
  assert.doesNotMatch(JSON.stringify(oldContent.state),/PRIVATE_HISTORY_BODY_A|PRIVATE_HISTORY_BODY_B/);
});
