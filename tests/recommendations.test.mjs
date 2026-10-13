import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {getDisplayTitle,suggestDisplayTitle,setDisplayTitle,findDuplicateDisplayTitles} from '../recommendation-title.mjs';
import {syncRelatedFooter,trackRelatedFooterEdit,relatedMarkdown,normalizeHistoryState} from '../history.mjs';
import {renderArticle,buildImageIndex,THEMES} from '../core.mjs';
import {copyRichText} from '../clipboard.mjs';
import {wrapArticleHtml} from '../app.mjs';

const require = createRequire(import.meta.url);
const markdownFactory = require('../vendor/markdown-it.cjs');
const render = (source,footer,options={}) => renderArticle(source,{markdownFactory,relatedFooter:footer,...options});
const item = (title,id='one',more={}) => ({id,title,name:`${id}.md`,...more});
const footerSection = html => html.match(/<section aria-label="相关文章推荐"[^>]*>[\s\S]*?<\/section>/)?.[0] || '';

test('display titles are optional, validated, and never alter the original record',() => {
  const original = Object.freeze(item('1005_吉隆坡的天气分析','a',{titleSource:'filename'}));
  assert.equal(getDisplayTitle(original),original.title);
  const edited = setDisplayTitle(original,'  吉隆坡的天气分析  ');
  assert.equal(edited.title,original.title);
  assert.equal(edited.displayTitle,'吉隆坡的天气分析');
  assert.equal(getDisplayTitle(edited),'吉隆坡的天气分析');
  assert.deepEqual(setDisplayTitle(edited,''),original);
  assert.deepEqual(setDisplayTitle(edited,original.title),original);
  for (const invalid of ['bad\nline','bad\tline','\u0000bad','x'.repeat(501)]) {
    assert.equal(setDisplayTitle(original,invalid),original);
    assert.equal(getDisplayTitle({...original,displayTitle:invalid}),original.title);
  }
  assert.equal(getDisplayTitle({title:'原题',displayTitle:'  '}),'原题');
  assert.equal(getDisplayTitle(null),'');
});

test('date cleanup is an optional filename-only suggestion with calendar validation',() => {
  const suggest = title => suggestDisplayTitle(item(title,'a',{titleSource:'filename'}));
  for (const title of ['1005_吉隆坡的天气分析','0929_吉隆坡地铁分析','20261013_吉隆坡地铁分析','2026-10-13_吉隆坡地铁分析',
    '2024-02-29_吉隆坡地铁分析','0229_吉隆坡地铁分析','0101 1984 年的故事']) {
    assert.ok(suggest(title));
  }
  assert.equal(suggest('1005_吉隆坡的天气分析'),'吉隆坡的天气分析');
  assert.equal(suggest('0101 1984 年的故事'),'1984 年的故事');
  for (const title of ['1984_小说','1984','2026_年度总结','1301_标题','0001_标题','0431_标题','0230_标题',
    '2023-02-29_标题','2026-13-01_标题','20260431_标题','1005正文数字','1005_','第 1005 期']) {
    assert.equal(suggest(title),null,title);
  }
  for (const titleSource of ['heading','frontmatter',undefined,'unknown']) {
    assert.equal(suggestDisplayTitle(item('1005_真实文内标题','a',{titleSource})),null);
  }
});

test('duplicate display titles produce review hints without merging or guessing similarity',() => {
  const items = Object.freeze([
    Object.freeze(item('1005_同题','a',{displayTitle:'同题'})),Object.freeze(item('同题','b')),
    Object.freeze(item('ＡＢＣ','c')),Object.freeze(item('abc','d')),Object.freeze(item('相似标题','e')),
    Object.freeze(item('相似题','f')),Object.freeze(item('同题','a')),
  ]);
  assert.deepEqual(findDuplicateDisplayTitles(items),[{title:'同题',ids:['a','b']},{title:'ＡＢＣ',ids:['c','d']}]);
  assert.equal(items.length,7);
  assert.equal(items[0].title,'1005_同题');
});

test('all themes render a restrained inline recommendation section and preserve source',() => {
  const items=[item('吉隆坡的天气分析'),item('快乐的马来西亚中学生','two')];
  const managed=syncRelatedFooter('# 当前正文\n\n- 正文项目',items);
  const accents={clear:'#237a63',warm:'#995b3f',ink:'#345875'};
  for (const theme of THEMES) {
    const rendered=render(managed.source,managed.footer,{theme:theme.id});
    const section=footerSection(rendered.html);
    assert.ok(section);
    assert.match(section,/margin:38px 0 0;padding:20px 0 0;border-top:1px solid/);
    assert.match(section,/font-size:14px;line-height:1\.6;font-weight:600/);
    assert.ok(section.includes(`color:${accents[theme.id]}`));
    assert.match(section,/list-style:none;margin:0;padding:0/);
    assert.match(section,/font-size:14px;line-height:1\.85/);
    assert.match(section,/padding:10px 0/);
    assert.equal((section.match(/border-bottom:1px solid/g)||[]).length,1);
    assert.equal((section.match(/<li /g)||[]).length,2);
    assert.doesNotMatch(section,/background-color|border-radius|<a\b|href=|<img\b|class=/);
    assert.match(rendered.html,/list-style-type:disc/);
    assert.equal(rendered.source,managed.source);
    assert.deepEqual(rendered.issues,[]);
  }
});

test('an ordinary same-name body header/list cannot receive recommendation styling',() => {
  const body='相关文章推荐：\n\n- 作者原先手写\n\n正文尾段';
  const managed=syncRelatedFooter(body,[item('实际勾选')]);
  const rendered=render(managed.source,managed.footer);
  assert.equal((rendered.html.match(/aria-label="相关文章推荐"/g)||[]).length,1);
  assert.match(rendered.html,/list-style-type:disc/);
  assert.ok(rendered.html.indexOf('作者原先手写')<rendered.html.indexOf('aria-label="相关文章推荐"'));
  assert.equal(footerSection(rendered.html).includes('作者原先手写'),false);
  assert.equal(footerSection(rendered.html).includes('实际勾选'),true);
  assert.equal(rendered.source,managed.source);
  assert.equal(footerSection(render(body,null).html),'');
});

test('unknown and inherited-property theme names use the same clear theme fallback',() => {
  const managed=syncRelatedFooter('正文',[item('推荐标题')]);
  const defaults=render(managed.source,managed.footer,{theme:'clear'});
  for (const theme of ['missing','constructor','__proto__','toString']) {
    const result=render(managed.source,managed.footer,{theme});
    assert.equal(result.theme,'clear');
    assert.equal(result.html,defaults.html);
    assert.doesNotMatch(result.html,/undefined/);
  }
});

test('controlled typography applies to body and recommendation output with safe theme fallback',() => {
  const managed=syncRelatedFooter('# 文章标题\n\n正文文字\n\n> 引用内容',[item('推荐标题')]);
  for (const theme of THEMES) {
    const options={theme:theme.id,presentation:{fontSize:18,lineHeight:2,accentColor:'#8B4E3A'}};
    const rendered=render(managed.source,managed.footer,options),section=footerSection(rendered.html);
    assert.match(rendered.html,/font-size:18px;line-height:2;/);
    assert.match(section,/font-size:15\.75px;line-height:2;/);
    assert.match(section,/font-size:15\.75px;line-height:1\.6;/);
    assert.match(section,/color:#8b4e3a/i);
    assert.ok(rendered.html.includes('font-size:27px'));
    assert.equal(rendered.source,managed.source);
    const exported=wrapArticleHtml(rendered.html,'文章标题');
    assert.ok(exported.includes(section));
  }
  const defaults=render(managed.source,managed.footer,{theme:'warm'});
  for (const presentation of [null,{},
    {fontSize:'18',lineHeight:'2',accentColor:'red'},
    {fontSize:NaN,lineHeight:Infinity,accentColor:'#000;position:absolute',device:'desktop',width:9999}]) {
    assert.equal(render(managed.source,managed.footer,{theme:'warm',presentation}).html,defaults.html);
  }
  const bounded=render(managed.source,managed.footer,{theme:'warm',presentation:{fontSize:500,lineHeight:0,accentColor:'url(https://bad.test/image)'}});
  assert.match(bounded.html,/font-size:20px;line-height:1\.5;/);
  assert.match(footerSection(bounded.html),/font-size:17\.5px;line-height:1\.5;/);
  assert.doesNotMatch(bounded.html,/bad\.test|url\(/);
});

test('frontmatter cleanup and replaced local images retain the tracked footer position',() => {
  const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const body='---\ntitle: 当前文章\n---\n\n# 当前文章\n\n![[附件/图.png]]\n\n正文尾段';
  const managed=syncRelatedFooter(body,[item('推荐标题')]);
  const index=buildImageIndex([{path:'附件/图.png'}]),assetData=new Map([['附件/图.png',PNG]]);
  const rendered=render(managed.source,managed.footer,{stripFrontmatter:true,index,assetData});
  assert.equal(rendered.removedFrontmatter,true);
  assert.equal(rendered.images.length,1);
  assert.ok(rendered.html.indexOf('<img ')<rendered.html.indexOf('正文尾段'));
  assert.ok(rendered.html.indexOf('正文尾段')<rendered.html.indexOf('aria-label="相关文章推荐"'));
  assert.ok(footerSection(rendered.html).includes('推荐标题'));
  assert.equal(rendered.source,managed.source.replace(/^---\ntitle: 当前文章\n---\n/,''));
});

test('special and custom display titles remain escaped real text without links or images',() => {
  const title='![实际图片](https://bad.test/a.png) **真标题** <script>x</script> &amp; `代码` \\ [链接](file:///D:/private)';
  const entry=item('1005_原始题','a',{displayTitle:title,titleSource:'filename'});
  const managed=syncRelatedFooter('正文',[entry]);
  const rendered=render(managed.source,managed.footer);
  const section=footerSection(rendered.html);
  assert.ok(section.includes('![实际图片](https://bad.test/a.png) **真标题**'));
  assert.ok(section.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(section.includes('&amp;amp;'));
  assert.ok(section.includes('`代码`'));
  assert.ok(section.includes(' \\ [链接]'));
  assert.doesNotMatch(section,/<(?:a|img|script|strong|code)\b|href=|src=/);
  assert.deepEqual(rendered.images,[]);
  assert.deepEqual(rendered.issues,[]);
  assert.doesNotMatch(section,/1005_原始题/);
  assert.equal(entry.title,'1005_原始题');
  assert.equal(relatedMarkdown([entry]),managed.footer.text.trimStart());
});

test('manual same-line title edits stay real editable text while detached blocks render normally',() => {
  const managed=syncRelatedFooter('正文',[item('原题')]);
  const after=managed.source.replace('- 原题','- ![用户亲写](https://bad.test/img.png)');
  const footer=trackRelatedFooterEdit(managed.source,after,managed.footer);
  assert.equal(footer.detached,undefined);
  const rendered=render(after,footer);
  assert.ok(footerSection(rendered.html).includes('![用户亲写](https://bad.test/img.png)'));
  assert.deepEqual(rendered.images,[]);
  assert.deepEqual(rendered.issues,[]);
  const detachedSource=after.replace('相关文章推荐：','我自己改的标题：');
  const detached=trackRelatedFooterEdit(after,detachedSource,footer);
  assert.deepEqual(detached,{detached:true});
  assert.equal(footerSection(render(detachedSource,detached).html),'');
  assert.equal(render(detachedSource,detached).source,detachedSource);
  assert.equal(syncRelatedFooter(detachedSource,[],detached).source,detachedSource);
});

test('stale, invalid, mid-line and code-fence ranges cannot inject a styled block or marker',() => {
  const managed=syncRelatedFooter('正文',[item('标题')]);
  for (const footer of [null,{detached:true},{...managed.footer,text:'unowned'},
    {...managed.footer,start:-1},{...managed.footer,end:managed.source.length+1},
    {...managed.footer,start:0,end:managed.source.length,text:managed.source}]) {
    const rendered=render(managed.source,footer);
    assert.equal(footerSection(rendered.html),'');
    assert.equal(rendered.source,managed.source);
    assert.doesNotMatch(rendered.html,/XYLLOCALIMAGE.*RELATEDFOOTEREND/);
  }
  const text='相关文章推荐：\n\n- 标题\n';
  assert.equal(footerSection(render('x'+text,{start:1,end:text.length+1,text}).html),'');
  const code=syncRelatedFooter('```md\n代码内容',[item('代码里的标题')]);
  const result=render(code.source,code.footer);
  assert.equal(footerSection(result.html),'');
  assert.match(result.html,/<pre /);
  assert.match(result.html,/代码里的标题/);
  assert.doesNotMatch(result.html,/XYLLOCALIMAGE.*RELATEDFOOTEREND/);
});

test('repeated render, clipboard payload and HTML export all use one unchanged source',async () => {
  const entries=[item('0929_吉隆坡地铁分析','a',{displayTitle:'吉隆坡地铁分析',titleSource:'filename'}),item('1984','b')];
  const managed=syncRelatedFooter('# 当前正文\n\n正文内容',entries);
  const rendered=render(managed.source,managed.footer);
  for (let i=0;i<8;i++) assert.equal(render(managed.source,managed.footer).html,rendered.html);
  assert.equal((rendered.html.match(/>相关文章推荐：<\/p>/g)||[]).length,1);
  let copied;class ClipboardItem {constructor(data){this.data=data;}}
  await copyRichText({html:rendered.html,text:rendered.source,clipboard:{write:async items=>{copied=items[0];}},ClipboardItemCtor:ClipboardItem,documentRef:null});
  assert.equal(await copied.data['text/html'].text(),rendered.html);
  assert.equal(await copied.data['text/plain'].text(),managed.source);
  const exported=wrapArticleHtml(rendered.html,'当前文章');
  assert.ok(exported.includes(rendered.html));
  assert.doesNotMatch(exported,/0929_吉隆坡|D:\\Obsidian|titleSource|displayTitle|articleId/);
  const restored=normalizeHistoryState(JSON.parse(JSON.stringify({items:entries,selectedIds:['a','b'],footer:managed.footer})),managed.source);
  assert.equal(getDisplayTitle(restored.items[0]),'吉隆坡地铁分析');
  assert.equal(render(managed.source,restored.footer).html,rendered.html);
});
