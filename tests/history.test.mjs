import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fingerprintText,extractHistoryTitle,importHistoryFiles,normalizeHistoryState,searchHistory,
  toggleHistorySelection,moveHistorySelection,removeHistoryItem,escapeRelatedTitle,relatedMarkdown,
  syncRelatedFooter,trackRelatedFooterEdit} from '../history.mjs';
import {renderArticle,parseImageReferences,buildImageIndex} from '../core.mjs';
import {copyRichText} from '../clipboard.mjs';
import {wrapArticleHtml} from '../app.mjs';

const require = createRequire(import.meta.url);
const markdownFactory = require('../vendor/markdown-it.cjs');
const item = (title,body=title,name=`${title}.md`) => ({id:fingerprintText(body),title,name});
const record = title => item(title);
const selected = state => state.selectedIds.map(id => state.items.find(entry => entry.id === id)).filter(Boolean);
function file(name,text,{size,bytes,read,webkitRelativePath} = {}) {
  const content=bytes ?? new TextEncoder().encode(text);
  return {name,size:size ?? content.byteLength,webkitRelativePath,
    async arrayBuffer(){read?.();return content.buffer.slice(content.byteOffset,content.byteOffset+content.byteLength);}};
}

test('history fingerprints match actual SHA256 for UTF8, BOM and normalized line endings',() => {
  for (const value of ['', 'abc', '中文文章\r\n'.repeat(30), '\uFEFFa\rb\r\nc']) {
    const normalized=value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
    assert.equal(fingerprintText(value),'h-'+createHash('sha256').update(normalized,'utf8').digest('hex'));
  }
});

test('title priority is safe top-level YAML scalar, first H1, then basename',() => {
  assert.deepEqual(extractHistoryTitle('---\ntitle: "标题：测试 [一]" # 注释\n---\n# 次标题\n正文','回退.md'),{title:'标题：测试 [一]',source:'frontmatter'});
  assert.equal(extractHistoryTitle("---\ntitle: '作者''s 标题'\n---\n# H1",'x.md').title,"作者's 标题");
  assert.deepEqual(extractHistoryTitle('---\nmeta:\n  title: 不该取\n---\n```md\n# 代码标题\n```\n# 正确标题 #','x.md'),{title:'正确标题',source:'heading'});
  assert.equal(extractHistoryTitle('# C#\n正文','x.md').title,'C#');
  assert.deepEqual(extractHistoryTitle('正文没有标题','D:\\私人目录\\文章 空格.TXT'),{title:'文章 空格',source:'filename'});
});

test('unsupported YAML cannot execute and falls back to a heading or filename',() => {
  for (const yaml of ['!!python/object:exec [payload]','[a,b]','|','"broken']) {
    assert.deepEqual(extractHistoryTitle(`---\ntitle: ${yaml}\n---\n# 实际标题`,'safe.md'),{title:'实际标题',source:'heading'});
  }
  assert.equal(extractHistoryTitle('---\nbody: "# 假标题"\n---\n没有标题','无标题.md').title,'无标题');
});

test('imports actual synthetic UTF8 .md/.txt files; stored records contain no body/path/url',async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'xyl-history-test-'));
  t.after(async () => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));
    assert.ok(path.basename(temp).startsWith('xyl-history-test-'));
    await rm(temp,{recursive:true,force:true});
  });
  const fixtures=[['文章 空格.md','\uFEFF---\ntitle: 中文属性标题\n---\n正文隐私：不得公开'],['过去的文章.TXT','# 一级标题\n另一份私密正文']];
  const files=[];
  for (const [name,text] of fixtures) {
    const target=path.join(temp,name);await writeFile(target,text,'utf8');
    files.push({name,webkitRelativePath:`历史/私人子目录/${name}`,async arrayBuffer(){const data=await readFile(target);return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);}});
  }
  const result=await importHistoryFiles(files);
  assert.equal(result.added,2);assert.equal(result.skipped,0);assert.equal(result.cancelled,false);
  assert.deepEqual(result.items.map(entry=>entry.title),['中文属性标题','一级标题']);
  assert.deepEqual(result.titleSources.map(entry=>entry.source),['frontmatter','heading']);
  for (const entry of result.items) assert.deepEqual(Object.keys(entry),['id','title','name']);
  const saved=JSON.stringify(result.items);
  assert.doesNotMatch(saved,/正文隐私|私密正文|私人子目录|D:|url|body/);
});

test('directory imports read only markdown and individual selection also accepts text',async () => {
  const reads=[];
  const files=[file('正文.MD','# 标题',{read:()=>reads.push('md')}),file('文章.txt','文本',{read:()=>reads.push('txt')}),
    file('图片.png','fake',{read:()=>reads.push('png')}),file('脚本.js','fake',{read:()=>reads.push('js')})];
  const directory=await importHistoryFiles(files,{directory:true});
  assert.equal(directory.added,1);assert.equal(directory.skipped,3);assert.deepEqual(reads,['md']);
  reads.length=0;
  const individual=await importHistoryFiles(files);
  assert.equal(individual.added,2);assert.equal(individual.skipped,2);assert.deepEqual(reads,['md','txt']);
});

test('directory limits count markdown candidates, while thousands of irrelevant files remain unread',async () => {
  let ignoredReads=0,mdReads=0;
  const files=Array.from({length:2501},(_,i)=>file(`图片${i}.png`,'',{read:()=>ignoredReads++}));
  files.push(file('唯一.md','# 唯一文章',{read:()=>mdReads++}));
  const result=await importHistoryFiles(files,{directory:true,maxFiles:1});
  assert.equal(result.added,1);assert.equal(result.skipped,2501);assert.equal(ignoredReads,0);assert.equal(mdReads,1);
});

test('re-importing or duplicate content skips; same title different articles stay with warning',async () => {
  const first=await importHistoryFiles([file('一.md','# 同标题\n正文一'),file('复制.md','# 同标题\r\n正文一'),file('二.md','# 同标题\n正文二')]);
  assert.equal(first.added,2);assert.equal(first.skipped,1);
  assert.deepEqual(first.issues.map(entry=>entry.status),['duplicate','same-title']);
  assert.deepEqual(first.items.map(entry=>entry.name),['一.md','二.md']);
  const second=await importHistoryFiles([file('一.md','# 同标题\n正文一')],{existing:first.items});
  assert.equal(second.added,0);assert.equal(second.skipped,1);assert.deepEqual(second.items,first.items);
});

test('empty picker cancellation and abort before/during reads leave existing index unchanged',async () => {
  const existing=[record('原文章')];let reads=0;
  assert.deepEqual((await importHistoryFiles([],{existing})).items,existing);
  const controller=new AbortController();controller.abort();
  const before=await importHistoryFiles([file('新.md','# 新',{read:()=>reads++})],{existing,signal:controller.signal});
  assert.equal(before.cancelled,true);assert.equal(reads,0);assert.deepEqual(before.items,existing);
  let cancel=false;
  const during=await importHistoryFiles([file('一.md','# 第一'),file('二.md','# 第二',{read:()=>{cancel=true;}}),file('三.md','# 第三',{read:()=>reads++})],
    {existing,isCancelled:()=>cancel});
  assert.equal(during.cancelled,true);assert.equal(during.added,0);assert.equal(reads,0);assert.deepEqual(during.items,existing);
});

test('generation cancellation makes an earlier concurrent import uncommittable',async () => {
  let generation=1,release;
  const delayed={name:'旧批次.md',size:20,arrayBuffer:()=>new Promise(resolve=>{release=()=>resolve(new TextEncoder().encode('# 旧批次').buffer);})};
  const old=importHistoryFiles([delayed],{isCancelled:()=>generation!==1});
  generation=2;
  const newest=await importHistoryFiles([file('新批次.md','# 新批次')],{isCancelled:()=>generation!==2});
  release();
  assert.equal((await old).cancelled,true);assert.equal(newest.cancelled,false);
  assert.deepEqual(newest.items.map(entry=>entry.title),['新批次']);
});

test('limits, invalid UTF8 and read failures do not expose raw text or read unsupported files',async () => {
  let readCount=0;
  const result=await importHistoryFiles([file('大文件.md','',{size:100,read:()=>readCount++}),file('坏编码.txt','',{bytes:Uint8Array.of(0xff,0xfe)}),
    {name:'无法读取.md',size:0,arrayBuffer:async()=>{throw new Error('PRIVATE_BODY');}},file('正确.md','# 有效')],{maxFileBytes:50});
  assert.equal(readCount,0);assert.equal(result.added,1);assert.equal(result.skipped,3);
  assert.deepEqual(result.issues.map(issue=>issue.status),['file-limit','read-error','read-error']);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY/);
  const tooMany=await importHistoryFiles([file('一.md','1'),file('二.md','2')],{maxFiles:1});
  assert.equal(tooMany.added,0);assert.equal(tooMany.issues[0].status,'batch-limit');
});

test('total batch size failure rolls back staged additions while keeping prior index',async () => {
  const existing=[record('已有')];
  const result=await importHistoryFiles([file('一.md','# 新一'),file('二.md','# 新二')],{existing,maxTotalBytes:12});
  assert.equal(result.added,0);assert.deepEqual(result.items,existing);assert.deepEqual(result.titleSources,[]);
  assert.ok(result.issues.some(issue=>issue.status==='batch-limit'));
});

test('normalization whitelists metadata, selection order and controlled footer only',() => {
  const a=record('标题甲'),b=record('标题乙');
  const managed=syncRelatedFooter('abcd',[a]);
  const normalized=normalizeHistoryState({items:[{...a,body:'PRIVATE',url:'https://hidden',path:'D:/私人'},a,b,
    {id:'bad',title:'有\n换行',name:'x'},{id:2,title:'数字ID'}, {id:'long',title:'x'.repeat(501)}],
    selectedIds:[b.id,'unknown',b.id,a.id],body:'SECRET',footer:{...managed.footer,body:'hidden'}},managed.source);
  assert.deepEqual(normalized.items,[a,b]);assert.deepEqual(normalized.selectedIds,[b.id,a.id]);
  assert.deepEqual(normalized.footer,managed.footer);assert.doesNotMatch(JSON.stringify(normalized),/PRIVATE|SECRET|https|path|body/);
  assert.deepEqual(normalizeHistoryState({footer:{start:-1,end:9,text:'secret'}},'abc').footer,{detached:true});
  assert.deepEqual(normalizeHistoryState({footer:{start:0,end:1,text:'x'}},'abc').footer,{detached:true});
  assert.deepEqual(normalizeHistoryState({footer:{detached:true,text:'secret',start:0,end:6}},'secret').footer,{detached:true});
});

test('search matches title or filename without modifying stored records',() => {
  const records=[item('写作笔记','a','中文 文件.md'),item('Reading ABC','b','second.txt')];
  assert.deepEqual(searchHistory(records,'ＡＢＣ'),[records[1]]);assert.deepEqual(searchHistory(records,'中文 文件'),[records[0]]);
  assert.deepEqual(searchHistory(records,'不存在'),[]);assert.deepEqual(searchHistory(records,''),records);
});

test('manual selection, repeated checking, reordering and removal preserve intended order',() => {
  const records=[record('甲'),record('乙'),record('丙')];let state={items:records,selectedIds:[],footer:null};
  state=toggleHistorySelection(state,records[0].id,true);state=toggleHistorySelection(state,records[1].id,true);
  state=toggleHistorySelection(state,records[0].id,true);assert.deepEqual(state.selectedIds,[records[0].id,records[1].id]);
  state=moveHistorySelection(state,records[1].id,'up');assert.deepEqual(state.selectedIds,[records[1].id,records[0].id]);
  state=moveHistorySelection(state,records[1].id,-1);assert.deepEqual(state.selectedIds,[records[1].id,records[0].id]);
  state=toggleHistorySelection(state,records[0].id,false);assert.deepEqual(state.selectedIds,[records[1].id]);
  state=removeHistoryItem(state,records[1].id);assert.deepEqual(state.selectedIds,[]);assert.deepEqual(state.items,[records[0],records[2]]);
});

test('generated special-character titles are ordinary text, never links, images or HTML',() => {
  const title='![偷读](https://remote/image.png) **重点** <script>alert(1)</script> &amp; `代码` \\ [链接](file:///D:/private)';
  const source=relatedMarkdown([item(title)]);
  assert.equal(parseImageReferences(source).length,0);
  const result=renderArticle(source,{markdownFactory,index:buildImageIndex([])});
  assert.equal(result.images.length,0);assert.equal(result.issues.length,0);
  assert.doesNotMatch(result.html,/<(?:img|a|script|strong|code)\b/);
  assert.match(result.html,/偷读/);assert.match(result.html,/&lt;script&gt;/);assert.match(result.html,/&amp;amp;/);
  assert.ok(escapeRelatedTitle(title).includes('\\!\\['));
});

test('footer sync is repeatable, uses source once and never deletes matching original body',() => {
  const body='# 正文\n\n相关文章推荐：\n\n- 原稿本来就有这段\n\n继续正文';
  const records=[record('甲'),record('乙')];
  let result=syncRelatedFooter(body,records);
  assert.ok(result.source.startsWith(body));assert.equal(result.source.split('相关文章推荐：').length-1,2);
  for (let i=0;i<10;i++) {result=syncRelatedFooter(result.source,records,result.footer);assert.equal(result.changed,false);}
  assert.equal(result.source.split('相关文章推荐：').length-1,2);
  const clear=syncRelatedFooter(result.source,[],result.footer);
  assert.equal(clear.source,body);assert.equal(clear.footer,null);
});

test('selection order and index deletion synchronize only the tracked footer',() => {
  let state={items:[record('甲'),record('乙'),record('丙')],selectedIds:[],footer:null};const body='未改正文';
  for (const entry of state.items) state=toggleHistorySelection(state,entry.id,true);
  let rendered=syncRelatedFooter(body,selected(state));state.footer=rendered.footer;
  state=moveHistorySelection(state,state.items[2].id,'up');rendered=syncRelatedFooter(rendered.source,selected(state),state.footer);state.footer=rendered.footer;
  assert.match(rendered.source,/- 甲\n- 丙\n- 乙/);
  state=removeHistoryItem(state,state.items[2].id);rendered=syncRelatedFooter(rendered.source,selected(state),state.footer);
  assert.match(rendered.source,/- 甲\n- 乙/);assert.ok(rendered.source.startsWith(body));assert.doesNotMatch(rendered.source,/- 丙/);
});

test('in-range manual text edit stays editable through ordinary rendering and later controlled sync',() => {
  const records=[record('文章原名')],initial=syncRelatedFooter('正文',records);
  const edited=initial.source.replace('文章原名','自己编辑的标题');
  const footer=trackRelatedFooterEdit(initial.source,edited,initial.footer);
  assert.equal(footer.detached,undefined);assert.equal(edited.slice(footer.start,footer.end),footer.text);
  const preview=renderArticle(edited,{markdownFactory,index:buildImageIndex([])});
  assert.match(preview.html,/自己编辑的标题/);assert.doesNotMatch(preview.html,/文章原名/);
  const next=syncRelatedFooter(edited,[record('另一篇')],footer);
  assert.ok(next.source.startsWith('正文'));assert.match(next.source,/另一篇/);assert.doesNotMatch(next.source,/自己编辑的标题/);
});

test('edits before and after footer track positions and preserve unrelated source',() => {
  const initial=syncRelatedFooter('原正文',[record('甲')]);
  const prefixed='新开头\n'+initial.source;
  const moved=trackRelatedFooterEdit(initial.source,prefixed,initial.footer);
  assert.equal(moved.start,initial.footer.start+'新开头\n'.length);assert.equal(moved.text,initial.footer.text);
  const after=prefixed+'\n作者补充的正文';
  const tracked=trackRelatedFooterEdit(prefixed,after,moved);
  const clear=syncRelatedFooter(after,[],tracked);
  assert.equal(clear.source,'新开头\n原正文\n作者补充的正文');
});

test('cross-boundary edits or stale ranges detach and never overwrite or append on sync',() => {
  const initial=syncRelatedFooter('正文内容',[record('甲')]);
  const replaced='全部改过的正文';
  const detached=trackRelatedFooterEdit(initial.source,replaced,initial.footer);
  assert.deepEqual(detached,{detached:true});
  for (const footer of [detached,{...initial.footer,text:'invalid'}]) {
    const result=syncRelatedFooter(replaced,[record('乙')],footer);
    assert.equal(result.conflict,true);assert.equal(result.changed,false);assert.equal(result.source,replaced);
  }
});

test('manual paragraph additions or deleting the entire footer pause management and never lose text',() => {
  const initial=syncRelatedFooter('原稿正文',[record('甲'),record('乙')]);
  const extra=initial.source.replace('- 甲\n','- 甲\n\n另加的正文\n');
  const editedFooter=trackRelatedFooterEdit(initial.source,extra,initial.footer);
  assert.deepEqual(editedFooter,{detached:true});
  const removed=syncRelatedFooter(extra,[],editedFooter);
  assert.equal(removed.conflict,true);assert.equal(removed.source,extra);assert.match(removed.source,/另加的正文/);
  const manuallyDeleted=initial.source.slice(0,initial.footer.start)+initial.source.slice(initial.footer.end);
  const deletedFooter=trackRelatedFooterEdit(initial.source,manuallyDeleted,initial.footer);
  assert.deepEqual(deletedFooter,{detached:true});
  const reselect=syncRelatedFooter(manuallyDeleted,[record('乙')],deletedFooter);
  assert.equal(reselect.conflict,true);assert.equal(reselect.source,'原稿正文');
});

test('a matching arbitrary body range cannot acquire ownership or be removed by deselection',() => {
  const body='正文中的重要段落\n不要删除';
  for (const text of ['重要段落','正文中的重要段落\n不要删除','相关文章推荐：\n\n实际正文没有列表']) {
    const source='开头'+text+'结尾',range={start:2,end:2+text.length,text};
    assert.deepEqual(normalizeHistoryState({footer:range},source).footer,{detached:true});
    const result=syncRelatedFooter(source,[],range);
    assert.equal(result.conflict,true);assert.equal(result.source,source);
  }
  assert.equal(syncRelatedFooter(body,[],{start:0,end:body.length,text:body}).source,body);
});

test('in-range header changes, whole-item deletion and newline title edits are detached',() => {
  const initial=syncRelatedFooter('正文',[record('甲'),record('乙')]);
  for (const after of [initial.source.replace('相关文章推荐：','我的参考文：'),initial.source.replace('- 甲\n',''),
    initial.source.replace('- 甲','- 甲\n用户自己的正文'),initial.source.replace('- 甲','- ')]) {
    const footer=trackRelatedFooterEdit(initial.source,after,initial.footer);
    assert.deepEqual(footer,{detached:true});assert.equal(syncRelatedFooter(after,[],footer).source,after);
  }
});

test('restored metadata can toggle and sync without duplicate footer or historical bodies',async () => {
  const imported=await importHistoryFiles([file('一.md','# 甲\n隐私BODY一'),file('二.md','# 乙\n隐私BODY二')]);
  const initial=syncRelatedFooter('当前正文',[imported.items[0]]);
  const restored=normalizeHistoryState(JSON.parse(JSON.stringify({items:imported.items,selectedIds:[imported.items[0].id],footer:initial.footer})),initial.source);
  const changed=toggleHistorySelection(restored,imported.items[1].id,true);
  const result=syncRelatedFooter(initial.source,selected(changed),changed.footer);
  assert.equal(result.source.split('相关文章推荐：').length-1,1);assert.match(result.source,/- 甲\n- 乙/);
  assert.doesNotMatch(JSON.stringify(restored)+result.source,/隐私BODY/);
});

test('preview, injected rich copy and HTML export share exactly the one rendered source',async () => {
  const imported=await importHistoryFiles([file('历史.md','# 推荐标题\nPRIVATE_HISTORY_BODY')]);
  const source=syncRelatedFooter('# 当前文章\n\n当前正文',imported.items).source;
  const rendered=renderArticle(source,{markdownFactory,index:buildImageIndex([])});
  let copied;class Item {constructor(data){this.data=data;}}
  await copyRichText({html:rendered.html,text:rendered.source,clipboard:{write:async items=>{copied=items[0];}},ClipboardItemCtor:Item,documentRef:null});
  const html=wrapArticleHtml(rendered.html,'当前文章');
  assert.equal(await copied.data['text/html'].text(),rendered.html);assert.equal(await copied.data['text/plain'].text(),source);
  assert.ok(html.includes(rendered.html));assert.equal(html.split('相关文章推荐：').length-1,1);assert.doesNotMatch(html,/PRIVATE_HISTORY_BODY/);
});
