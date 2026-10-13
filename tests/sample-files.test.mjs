import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import markdownFactory from '../vendor/markdown-it.cjs';
import {buildImageIndex, renderArticle} from '../core.mjs';

const vault = fileURLToPath(new URL('../samples/vault/',import.meta.url));
const fixtureNames = ['文章/同位 图片.png','附件/中文 空格图片.png','附件/标准 图.png',
  '附件/宽图.png','附件/同名.png','其他/同名.png'];

async function fixtureImages() {
  const entries = [], assetData = new Map();
  for (const name of fixtureNames) {
    const bytes = await readFile(path.join(vault,...name.split('/')));
    entries.push({path:name,type:'image/png'});
    assetData.set(name,`data:image/png;base64,${bytes.toString('base64')}`);
  }
  return {index:buildImageIndex(entries),assetData};
}

test('sample PNG fixtures are actual RGB PNGs with complete decompressible pixel data',async () => {
  for (const name of fixtureNames) {
    const bytes = await readFile(path.join(vault,...name.split('/')));
    assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),name);
    const chunks = [];
    let offset = 8;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      assert.ok(offset + length + 12 <= bytes.length,`${name} truncated chunk`);
      chunks.push({type:bytes.toString('ascii',offset + 4,offset + 8),data:bytes.subarray(offset + 8,offset + 8 + length)});
      offset += length + 12;
    }
    assert.equal(chunks[0].type,'IHDR');
    assert.equal(chunks.at(-1).type,'IEND');
    assert.equal(offset,bytes.length);
    const header = chunks[0].data;
    const width = header.readUInt32BE(0),height = header.readUInt32BE(4);
    assert.ok(width >= 300 && height >= 180,name);
    assert.equal(header[8],8);
    assert.equal(header[9],2);
    const pixels = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
    assert.equal(pixels.length,(width * 3 + 1) * height,name);
    for (let row = 0; row < height; row++) assert.equal(pixels[row * (width * 3 + 1)],0,name);
  }
  const one = await readFile(path.join(vault,'附件','同名.png'));
  const two = await readFile(path.join(vault,'其他','同名.png'));
  assert.notDeepEqual(one,two,'same basenames must contain visibly different images');
});

test('normal sample imports five local images in order, including Chinese spaces and sizes',async () => {
  const sourceFile = path.join(vault,'文章','正常示例.md');
  const bytes = await readFile(sourceFile),source = bytes.toString('utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const inputs = await fixtureImages();
  const rendered = renderArticle(source,{...inputs,articlePath:'文章/正常示例.md',stripFrontmatter:true,markdownFactory});
  assert.deepEqual(rendered.issues,[]);
  assert.deepEqual(rendered.images.map(image => image.path),[
    '文章/同位 图片.png','附件/中文 空格图片.png','附件/标准 图.png','附件/中文 空格图片.png','附件/宽图.png'
  ]);
  assert.equal(rendered.images[1].width,320);
  assert.equal(rendered.images[1].height,180);
  assert.equal(rendered.images[4].width,300);
  assert.equal((rendered.html.match(/<img /g) || []).length,5);
  assert.equal(rendered.removedFrontmatter,true);
  assert.ok(!rendered.html.includes('publish: false'));
  assert.match(rendered.html,/<hr /);
  assert.match(rendered.html,/这篇文章到此结束/);
  for (const theme of ['clear','warm','ink']) {
    const themed = renderArticle(source,{...inputs,theme,articlePath:'文章/正常示例.md',stripFrontmatter:false,markdownFactory});
    assert.deepEqual(themed.issues,[]);
    assert.equal(themed.removedFrontmatter,false);
    assert.match(themed.html,/publish: false/);
    assert.equal(themed.images.length,5);
  }
  const again = renderArticle(source,{...inputs,articlePath:'文章/正常示例.md',stripFrontmatter:true,markdownFactory});
  assert.equal(again.html,rendered.html,'repeated rendering is deterministic');
  assert.equal(createHash('sha256').update(await readFile(sourceFile)).digest('hex'),digest,'source remains untouched');
});

test('abnormal sample reports missing, ambiguous and remote images without replacing them',async () => {
  const source = await readFile(path.join(vault,'文章','异常示例.md'),'utf8');
  const inputs = await fixtureImages();
  const rendered = renderArticle(source,{...inputs,articlePath:'文章/异常示例.md',stripFrontmatter:true,markdownFactory});
  assert.equal(rendered.images.length,6);
  assert.deepEqual(rendered.images.map(image => image.status),['missing','ambiguous','matched','matched','blocked','missing']);
  assert.deepEqual(rendered.issues.map(issue => issue.status),['missing','ambiguous','blocked','missing']);
  assert.deepEqual([...rendered.images[1].candidates].sort(),['其他/同名.png','附件/同名.png'].sort());
  assert.equal(rendered.images[2].path,'附件/同名.png');
  assert.equal(rendered.images[3].path,'其他/同名.png');
  assert.equal((rendered.html.match(/<img /g) || []).length,2);
  assert.ok(!rendered.html.includes('src="https:'));
  assert.match(rendered.html,/这一段仍应保留在预览末尾/);
  const normal = await readFile(path.join(vault,'文章','正常示例.md'),'utf8');
  assert.deepEqual(renderArticle(normal,{...inputs,articlePath:'文章/正常示例.md',markdownFactory}).issues,[]);
});
