import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {makeDraft,validateDraft,createDraftRepository} from '../drafts.mjs';
import {renderArticle} from '../core.mjs';
import {copyRichText} from '../clipboard.mjs';
import {wrapArticleHtml} from '../app.mjs';
import {syncRelatedFooter,toggleHistorySelection} from '../history.mjs';

const markdownFactory=createRequire(import.meta.url)('../vendor/markdown-it.cjs');
const firstId=`h-${'a'.repeat(64)}`;
const secondId=`h-${'b'.repeat(64)}`;
const thirdId=`h-${'c'.repeat(64)}`;
const emptyHistory=()=>({items:[],selectedIds:[],footer:null});
const items=()=>[
  {id:firstId,title:'第一篇：中文、空格 & <标签> [括号] *星号* 😄',name:'第一篇 有空格.md'},
  {id:secondId,title:'第二篇',name:'第二篇.txt'},
  {id:thirdId,title:'未选择的私人标题',name:'第三篇.md'}
];
const draft=(markdown='# 当前文章\n\n当前正文',relatedArticles)=>makeDraft({markdown,
  theme:'clear',articlePath:'文章/当前文章.md',stripFrontmatter:true,assets:new Map(),relatedArticles});
const roundTrip=value=>validateDraft(JSON.parse(JSON.stringify(value)));

function memoryBackend() {
  const records=new Map();
  return {records,getAll:async()=>[...records.values()].map(record=>structuredClone(record)),
    get:async id=>structuredClone(records.get(id)),put:async record=>records.set(record.id,structuredClone(record)),
    delete:async id=>records.delete(id),clear:async()=>records.clear()};
}

test('old version 1 draft without related articles remains valid and receives an empty local index',()=>{
  const legacy={format:'xieyuliao-draft',version:1,markdown:'# 旧版正文\n\n内容不能被替换',theme:'warm',
    articlePath:'文章/旧版.md',stripFrontmatter:false,assets:[],savedAt:'2026-10-13T07:00:00.000Z'};
  const restored=validateDraft(legacy);
  assert.equal(restored.version,1);
  assert.equal(restored.markdown,legacy.markdown);
  assert.equal(restored.theme,'warm');
  assert.equal(restored.stripFrontmatter,false);
  assert.deepEqual(restored.relatedArticles,emptyHistory());
  assert.deepEqual(roundTrip(restored),restored);
});

test('portable draft preserves history titles, ordered selections and matching footer range',()=>{
  const body='# 当前文章\n\n正文';
  const text='\n\n相关文章推荐：\n\n- 第二篇\n- 第一篇';
  const history={items:items(),selectedIds:[secondId,firstId],footer:{start:body.length,end:body.length+text.length,text}};
  const saved=draft(body+text,history);
  const restored=roundTrip(saved);
  assert.deepEqual(restored.relatedArticles,history);
  assert.equal(restored.relatedArticles.items[0].title,items()[0].title);
  assert.equal(restored.markdown,body+text);
  assert.deepEqual(restored,saved);
});

test('makeDraft accepts optional history alias while relatedArticles takes priority',()=>{
  const options={markdown:'# 正文',assets:new Map(),history:{items:items(),selectedIds:[firstId],footer:null}};
  assert.deepEqual(makeDraft(options).relatedArticles.selectedIds,[firstId]);
  assert.deepEqual(makeDraft({...options,relatedArticles:emptyHistory()}).relatedArticles,emptyHistory());
});

test('history state is allowlisted so article bodies, private paths, URLs and unknown fields do not survive JSON',()=>{
  const privateBody='禁止存入历史全文 SECRET-BODY';
  const privatePath='X:\\Example Vault\\私密\\第一篇.md';
  const privateUrl='https://example.invalid/private';
  const extra={body:privateBody,markdown:privateBody,source:privateBody,path:privatePath,fullpath:privatePath,
    url:privateUrl,sourceUrl:privateUrl,unknown:{also:privateBody}};
  const input={...draft(),relatedArticles:{...extra,
    items:items().map(item=>({...item,...extra})),selectedIds:[firstId],footer:null}};
  const checked=roundTrip(input);
  assert.deepEqual(checked.relatedArticles,{items:items(),selectedIds:[firstId],footer:null});
  const serialized=JSON.stringify(checked.relatedArticles);
  for (const secret of [privateBody,privatePath,privateUrl]) assert.equal(serialized.includes(secret),false);
  assert.deepEqual(Object.keys(checked.relatedArticles).sort(),['footer','items','selectedIds']);
  for (const item of checked.relatedArticles.items) assert.deepEqual(Object.keys(item).sort(),['id','name','title']);
});

test('restoration filters invalid metadata, duplicate IDs and nonexistent selections without reordering valid choices',()=>{
  const valid=items();
  const relatedArticles={items:[valid[0],{...valid[0],title:'同 ID 不应覆盖原题'},valid[1],
    {id:`h-${'d'.repeat(64)}`,title:'含\u0000控制符',name:'bad.md'},
    {id:`h-${'e'.repeat(64)}`,title:'长'.repeat(501),name:'bad.md'},
    {id:12,title:'错误 ID',name:'bad.md'},null],
    selectedIds:[secondId,'missing',firstId,secondId,null,12],footer:null};
  const checked=roundTrip(draft('# 当前文章',relatedArticles));
  assert.deepEqual(checked.relatedArticles.items,[valid[0],valid[1]]);
  assert.deepEqual(checked.relatedArticles.selectedIds,[secondId,firstId]);
  assert.equal(checked.markdown,'# 当前文章');
});

test('clearing selections and local history metadata survives save, restore and repository backups',async()=>{
  const backend=memoryBackend();
  const repo=createDraftRepository(backend,{now:()=>1000});
  await repo.save(draft('# 当前文章',{items:items(),selectedIds:[secondId,firstId],footer:null}));
  await repo.save(draft('# 当前文章',{items:items(),selectedIds:[],footer:null}));
  const cleared=await repo.loadLatest();
  assert.deepEqual(cleared.relatedArticles,{items:items(),selectedIds:[],footer:null});
  const backups=await repo.listBackups();
  const earlier=await repo.loadBackup(backups[1].id);
  assert.deepEqual(earlier.relatedArticles.selectedIds,[secondId,firstId]);
  await repo.save(draft('# 当前文章',emptyHistory()));
  assert.deepEqual((await repo.loadLatest()).relatedArticles,emptyHistory());
  assert.equal((await repo.listBackups()).length,3);
});

test('unselected history metadata and private bodies are absent from preview, HTML export and simulated rich clipboard',async()=>{
  const saved=draft('# 当前文章\n\n公开正文',{items:items().map(item=>({...item,body:'HISTORY SECRET BODY'})),
    selectedIds:[],footer:null});
  const restored=roundTrip(saved);
  const result=renderArticle(restored.markdown,{markdownFactory});
  const exported=wrapArticleHtml(result.html,'当前文章');
  const copied=[];
  class Item {constructor(data){this.data=data;}}
  await copyRichText({html:result.html,text:result.source,
    clipboard:{write:async value=>copied.push(...value)},ClipboardItemCtor:Item,BlobCtor:Blob,
    documentRef:null,selection:null});
  const copyHtml=await copied[0].data['text/html'].text();
  const copyPlain=await copied[0].data['text/plain'].text();
  assert.equal(copyHtml,result.html);
  assert.equal(copyPlain,result.source);
  for (const publicPayload of [result.html,exported,copyHtml,copyPlain]) {
    for (const privateValue of [...items().map(item=>item.title),'HISTORY SECRET BODY','相关文章推荐：']) {
      assert.equal(publicPayload.includes(privateValue),false);
    }
  }
  assert.ok(exported.includes(result.html));
});

test('invalid or tampered managed footer loses untrusted coordinates and text and cannot overwrite or append to the body',()=>{
  const markdown='# 真实正文\n\n原文必须保留';
  const invalidFooters=[
    {start:0,end:4,text:'篡改内容'},
    {start:-1,end:4,text:markdown.slice(0,4)},
    {start:0.5,end:4,text:markdown.slice(0,4)},
    {start:0,end:markdown.length+1,text:markdown},
    {start:5,end:2,text:''},
    {start:0,end:1,text:'X',detached:true},
    {detached:true,text:'SECRET UNTRUSTED FOOTER',path:'D:/private.md',body:'SECRET BODY'}
  ];
  for (const footer of invalidFooters) {
    const restored=roundTrip(draft(markdown,{items:items(),selectedIds:[firstId],footer}));
    assert.deepEqual(restored.relatedArticles.footer,{detached:true});
    assert.equal(restored.markdown,markdown);
    const synced=syncRelatedFooter(restored.markdown,[restored.relatedArticles.items[0]],restored.relatedArticles.footer);
    assert.equal(synced.conflict,true);
    assert.equal(synced.changed,false);
    assert.equal(synced.source,markdown);
  }
});

test('matching footer restores only its controlled fields even when unknown metadata is supplied',()=>{
  const markdown='正文\n\n相关文章推荐：\n\n- 标题';
  const start=markdown.indexOf('\n\n相关文章推荐');
  const footer={start,end:markdown.length,text:markdown.slice(start)};
  const restored=roundTrip(draft(markdown,{items:items(),selectedIds:[firstId],
    footer:{...footer,path:'D:/private.md',url:'https://example.invalid',body:'SECRET'}}));
  assert.deepEqual(restored.relatedArticles.footer,footer);
});

test('restored related articles can be toggled and resynchronized repeatedly without duplicate footer or private title leakage',async()=>{
  const body='# 当前文章\n\n正文原样保留。';
  const originalItems=items();
  const initial=syncRelatedFooter(body,[originalItems[1],originalItems[0]]);
  const restored=roundTrip(draft(initial.source,{items:originalItems,selectedIds:[secondId,firstId],footer:initial.footer}));
  let state=toggleHistorySelection(restored.relatedArticles,secondId,false);
  let source=restored.markdown;
  for (let i=0;i<3;i++) {
    const selected=state.selectedIds.map(id=>state.items.find(item=>item.id===id));
    const synced=syncRelatedFooter(source,selected,state.footer);
    assert.equal(synced.conflict,false);
    source=synced.source;
    state={...state,footer:synced.footer};
    assert.equal((source.match(/相关文章推荐：/g)||[]).length,1);
    assert.equal(source.startsWith(body),true);
  }
  const finalDraft=roundTrip(draft(source,state));
  const preview=renderArticle(finalDraft.markdown,{markdownFactory});
  assert.doesNotMatch(preview.html,/<a\b|<img\b/);
  assert.equal(preview.html.includes('未选择的私人标题'),false);
  assert.equal(preview.html.includes('第二篇'),false);
  assert.equal((preview.html.match(/相关文章推荐：/g)||[]).length,1);
  assert.match(preview.html,/&lt;标签&gt;/);
  const copied=[];
  class Item {constructor(data){this.data=data;}}
  await copyRichText({html:preview.html,text:preview.source,clipboard:{write:async value=>copied.push(...value)},
    ClipboardItemCtor:Item,BlobCtor:Blob,documentRef:null,selection:null});
  assert.equal(await copied[0].data['text/html'].text(),preview.html);
  assert.ok(wrapArticleHtml(preview.html,'当前文章').includes(preview.html));
  state=toggleHistorySelection(finalDraft.relatedArticles,firstId,false);
  const cleared=syncRelatedFooter(finalDraft.markdown,[],state.footer);
  assert.equal(cleared.source,body);
  assert.equal(cleared.footer,null);
  assert.deepEqual(roundTrip(draft(cleared.source,{...state,footer:cleared.footer})).relatedArticles.selectedIds,[]);
});
