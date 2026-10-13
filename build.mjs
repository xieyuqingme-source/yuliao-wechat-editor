import {mkdir, copyFile, lstat, realpath, rm} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {PUBLIC_FILES} from './server.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_FILES = Object.freeze([
  'samples/使用说明.md', 'samples/相关文章示例.md', 'samples/正常示例-导出.html',
  'samples/history/01_散步与观察_重复副本.md', 'samples/history/01_散步与观察.md',
  'samples/history/02_留一点空白.txt', 'samples/history/03_标题特殊字符.md',
  'samples/history/04_同标题_甲.md', 'samples/history/05_同标题_乙.md',
  'samples/history/06_没有一级标题的文章.md',
  'samples/vault/其他/同名.png', 'samples/vault/文章/同位 图片.png',
  'samples/vault/文章/异常示例.md', 'samples/vault/文章/正常示例.md',
  'samples/vault/附件/标准 图.png', 'samples/vault/附件/宽图.png',
  'samples/vault/附件/同名.png', 'samples/vault/附件/中文 空格图片.png',
]);
export const DISTRIBUTION_FILES = Object.freeze([...new Set([
  ...[...PUBLIC_FILES.values()].map(entry => entry[0]),
  'server.mjs', '启动谢雨聊.cmd', 'README.md', 'VERIFICATION.md',
  'THIRD_PARTY_NOTICES.md', 'LICENSE', 'CONTRIBUTING.md',
  'vendor/markdown-it-LICENSE.txt', 'vendor/Raphael-LICENSE.txt',
  'vendor/markdown-it-package.json', 'docs/USAGE.md', 'docs/PAGES.md',
  ...SAMPLE_FILES,
])]);

/** Rebuild only the fixed dist output; arbitrary docs/files are never packaged. */
export async function buildDistribution(root = projectRoot) {
  const resolvedRoot = await realpath(path.resolve(root));
  const output = path.resolve(resolvedRoot, 'dist');
  if (path.dirname(output) !== resolvedRoot || output === resolvedRoot) throw new Error('Unsafe build output');
  // Validate every source before changing output. Symlinked private files stay out.
  for (const relative of DISTRIBUTION_FILES) {
    const source = path.resolve(resolvedRoot, relative);
    if (!source.startsWith(resolvedRoot + path.sep)) throw new Error('Unsafe distribution path');
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Distribution source is not a regular file: ${relative}`);
    const actual = await realpath(source);
    if (!actual.startsWith(resolvedRoot + path.sep)) throw new Error(`Distribution source escapes project: ${relative}`);
  }
  let existing;
  try {existing = await lstat(output);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Unsafe existing dist output');
  if (existing) {
    if (await realpath(output) !== output) throw new Error('Unsafe redirected dist output');
    await rm(output, {recursive: true, force: true});
  }
  await mkdir(output, {recursive: true});
  for (const relative of DISTRIBUTION_FILES) {
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(path.join(resolvedRoot, relative), destination);
  }
  return {output, files: [...DISTRIBUTION_FILES]};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildDistribution();
  console.log(`离线运行文件已生成：${result.output}（无需 npm 安装；仅包含公开白名单文件）`);
}
