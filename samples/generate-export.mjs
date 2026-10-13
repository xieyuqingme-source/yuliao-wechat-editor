// Generates only this repository's synthetic sample; never reads the user's vault.
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildImageIndex, parseImageReferences, resolveImage, renderArticle} from '../core.mjs';
import {wrapArticleHtml} from '../app.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const vault=path.join(root,'vault');
const records=[];
async function walk(folder,prefix='') {
  for (const item of await readdir(folder,{withFileTypes:true})) {
    const relative=`${prefix}${item.name}`;
    if (item.isDirectory()) await walk(path.join(folder,item.name),`${relative}/`);
    else records.push({path:relative});
  }
}
await walk(vault);
const articlePath='文章/正常示例.md';
const source=await readFile(path.join(vault,articlePath),'utf8');
const index=buildImageIndex(records), assets=new Map();
for (const ref of parseImageReferences(source)) {
  const match=resolveImage(ref,{index,articlePath});
  if (match.status!=='matched') throw new Error(`Synthetic sample unresolved: ${ref.target}`);
  const bytes=await readFile(path.join(vault,match.path));
  assets.set(match.path,`data:image/png;base64,${bytes.toString('base64')}`);
}
const result=renderArticle(source,{index,articlePath,assetData:assets,stripFrontmatter:true,
  markdownFactory:createRequire(import.meta.url)('../vendor/markdown-it.cjs')});
if (result.issues.length) throw new Error('Synthetic export has unresolved images');
const output=path.join(root,'正常示例-导出.html');
await writeFile(output,wrapArticleHtml(result.html,'谢雨聊 · 合成文章排版样例'),'utf8');
console.log(`Generated synthetic portable HTML: ${output}; images=${result.images.length}`);
