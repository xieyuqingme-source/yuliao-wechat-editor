import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDraft,validateDraft,createDraftRepository,createDraftStore,saveDraftAfterRender} from '../drafts.mjs';
import {entriesFromDraft,replaceDirectoryEntries,insertMarkdownAtSelection,pastedImageReference} from '../app.mjs';
import {buildImageIndex,renderArticle} from '../core.mjs';
import {createRequire} from 'node:module';
const markdownFactory=createRequire(import.meta.url)('../vendor/markdown-it.cjs');

const sample = (markdown='---\ntitle: 原始属性\n---\n# 正文\n![[附件/中文 空格.png]]') => makeDraft({markdown,
  theme:'warm',articlePath:'文章/日常.md',stripFrontmatter:true,
  assets:new Map([['附件/中文 空格.png','data:image/png;base64,AA=='],['__pasted__/a.png','data:image/jpeg;base64,/9j/']])});

function memoryBackend() {
  const data = new Map();
  return {data,getAll:async () => [...data.values()].map(value=>structuredClone(value)),
    get:async id => structuredClone(data.get(id)),put:async value => {data.set(value.id,structuredClone(value));},
    delete:async id => {data.delete(id);},clear:async () => data.clear()};
}

test('portable draft round trip preserves original properties, paths and both image kinds',() => {
  const draft=sample();const restored=validateDraft(JSON.parse(JSON.stringify(draft)));
  assert.deepEqual(restored,draft);assert.match(restored.markdown,/title: 原始属性/);
  assert.equal(restored.assets.length,2);assert.equal(restored.stripFrontmatter,true);
  assert.equal(restored.theme,'warm');assert.equal(restored.articlePath,'文章/日常.md');
});

test('draft import rejects wrong version, remote images, SVG, duplicate and unsafe paths',() => {
  const draft=sample();
  assert.throws(()=>validateDraft({...draft,version:2}),/版本/);
  for (const dataURL of ['https://remote.example/a.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,<script>']) {
    assert.throws(()=>validateDraft({...draft,assets:[{path:'a.png',dataURL}]}),/不受支持/);
  }
  for (const path of ['../secret.png','/绝对.png','D:/vault/x.png','a\\b.png']) {
    assert.throws(()=>validateDraft({...draft,assets:[{path,dataURL:'data:image/png;base64,AA=='}]}),/不安全/);
  }
  assert.throws(()=>validateDraft({...draft,assets:[draft.assets[0],draft.assets[0]]}),/重复/);
});

test('parallel autosaves retain latest 8 complete recoverable backups',async () => {
  const backend=memoryBackend();const repo=createDraftRepository(backend,{now:()=>1234});
  await Promise.all(Array.from({length:12},(_,i)=>repo.save(sample(`第${i+1}份正文`))));
  assert.equal((await repo.listBackups()).length,8);
  assert.equal((await repo.loadLatest()).markdown,'第12份正文');
  const backups=await repo.listBackups();
  assert.equal((await repo.loadBackup(backups.at(-1).id)).markdown,'第5份正文');
  assert.equal((await repo.loadBackup(backups[0].id)).assets.length,2);
  assert.equal(await repo.loadBackup('missing'),null);
  await repo.clear();assert.deepEqual(await repo.listBackups(),[]);assert.equal(await repo.loadLatest(),null);
});

test('storage failure propagates and leaves earlier backup available',async () => {
  const backend=memoryBackend();const repo=createDraftRepository(backend);
  await repo.save(sample('旧草稿'));
  const normalPut=backend.put;
  backend.put=async () => {throw new Error('QuotaExceededError');};
  await assert.rejects(repo.save(sample('新草稿')),/QuotaExceededError/);
  assert.equal((await repo.loadLatest()).markdown,'旧草稿');
  backend.put=normalPut;await repo.save(sample('恢复后草稿'));
  assert.equal((await repo.loadLatest()).markdown,'恢复后草稿');
});

test('fewer than 5 retained backups is forbidden and unavailable IndexedDB is explicit',async () => {
  assert.throws(()=>createDraftRepository(memoryBackend(),{keep:4}),/至少保留 5/);
  await assert.rejects(createDraftStore({indexedDB:null}),/不支持本地草稿/);
});

test('pasted images render in nested article paths and survive draft restore plus folder replacement',() => {
  const path='__pasted__/generated-图片.png';
  const pasted=insertMarkdownAtSelection('# 原文\n\n末尾',5,5,`${pastedImageReference(path)}\n`).value;
  const draft=makeDraft({markdown:pasted,theme:'clear',articlePath:'文章/稿.md',stripFrontmatter:true,
    assets:new Map([[path,'data:image/png;base64,AA==']])});
  const restored=validateDraft(JSON.parse(JSON.stringify(draft)));
  const restoredEntries=entriesFromDraft(restored);
  assert.equal(restoredEntries[0].pasted,true);
  const afterReplacement=replaceDirectoryEntries(restoredEntries,[{path:'附件/新图.png'}]);
  const rendered=renderArticle(restored.markdown,{index:buildImageIndex(afterReplacement),articlePath:restored.articlePath,
    assetData:new Map(restored.assets.map(a=>[a.path,a.dataURL])),markdownFactory});
  assert.equal(rendered.images.length,1);assert.equal(rendered.images[0].hasData,true);
  assert.equal(rendered.issues.length,0);assert.match(rendered.html,/data:image\/png;base64,AA==/);
  assert.match(rendered.html,/末尾/);
});

test('reopening repository in the same clock tick creates a fresh backup instead of overwriting',async () => {
  const backend=memoryBackend();
  await createDraftRepository(backend,{now:()=>1234}).save(sample('第一份'));
  const reopened=createDraftRepository(backend,{now:()=>1234});
  await reopened.save(sample('第二份'));
  assert.equal((await reopened.listBackups()).length,2);
  assert.equal((await reopened.loadLatest()).markdown,'第二份');
});

test('two simultaneous repositories never overwrite each other at the same clock tick',async () => {
  const backend=memoryBackend();
  const first=createDraftRepository(backend,{now:()=>1000});
  const second=createDraftRepository(backend,{now:()=>1000});
  const [a,b]=await Promise.all([first.save(sample('窗口 A')),second.save(sample('窗口 B'))]);
  assert.notEqual(a.id,b.id);
  assert.equal(backend.data.size,2);
  assert.deepEqual(new Set([...backend.data.values()].map(record=>record.draft.markdown)),new Set(['窗口 A','窗口 B']));
});

test('clear cancels a save waiting for slow image rendering even if the next edit resumes autosave',async () => {
  const backend=memoryBackend();const store=createDraftRepository(backend);
  await store.save(sample('先前草稿'));
  let releaseRender, generation=0, paused=false, snapshotCalled=false;
  const startedGeneration=generation;
  const render=new Promise(resolve=>{releaseRender=resolve;});
  const pending=saveDraftAfterRender({render:()=>render,store,
    snapshot:()=>{snapshotCalled=true;return sample('旧的慢图草稿');},
    isCancelled:()=>paused || generation!==startedGeneration});
  paused=true;generation++;
  await store.clear();
  paused=false; // A new edit resumes autosave; generation still cancels old work.
  releaseRender();
  assert.equal(await pending,null);assert.equal(snapshotCalled,false);
  assert.deepEqual(await store.listBackups(),[]);
  await saveDraftAfterRender({render:async()=>{},snapshot:()=>sample('清除后新编辑'),store});
  assert.equal((await store.loadLatest()).markdown,'清除后新编辑');
});

test('draft keeps duplicate basename and exact-path ambiguity instead of silently selecting an earlier cached image',() => {
  for (const [markdown,entries] of [
    ['![[同名.png]]',[{path:'甲/同名.png'},{path:'乙/同名.png'}]],
    ['![[甲/同名.png]]',[{path:'甲/同名.png'},{path:'甲/同名.png'}]]
  ]) {
    const draft=makeDraft({markdown,theme:'clear',articlePath:'文章/稿.md',stripFrontmatter:true,
      assets:new Map([['甲/同名.png','data:image/png;base64,AA==']]),entries});
    const restored=validateDraft(JSON.parse(JSON.stringify(draft)));
    const result=renderArticle(restored.markdown,{index:buildImageIndex(entriesFromDraft(restored)),
      articlePath:restored.articlePath,assetData:new Map(restored.assets.map(a=>[a.path,a.dataURL])),markdownFactory});
    assert.equal(result.images[0].status,'ambiguous');assert.equal(result.images[0].hasData,false);
    assert.equal(result.issues.length,1);assert.doesNotMatch(result.html,/<img src=/);
  }
});
