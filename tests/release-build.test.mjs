import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {buildDistribution, DISTRIBUTION_FILES} from '../build.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuliao-build-'));
  assert.ok(path.dirname(root) === os.tmpdir());
  t.after(() => rm(root, {recursive:true, force:true}));
  for (const relative of DISTRIBUTION_FILES) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), {recursive:true});
    await writeFile(file, `Synthetic public fixture: ${relative}\n`);
  }
  return root;
}
async function contents(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), {withFileTypes:true})) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await contents(root, `${relative}/`));
    else result.push([relative, createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')]);
  }
  return result.sort((a,b) => a[0].localeCompare(b[0]));
}

test('public distribution includes only allowlisted files and excludes arbitrary private docs, drafts and pictures', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root,'personal-draft.json'), 'SYNTHETIC_PRIVATE_DRAFT');
  await writeFile(path.join(root,'docs','private.md'), 'SYNTHETIC_PRIVATE_ARTICLE');
  await writeFile(path.join(root,'samples','unknown.png'), 'SYNTHETIC_PRIVATE_IMAGE');
  const result = await buildDistribution(root), actual = await contents(result.output);
  assert.deepEqual(actual.map(item => item[0]).sort(), [...DISTRIBUTION_FILES].sort());
  assert.ok(!JSON.stringify(actual).includes('private.md'));
  assert.equal(await readFile(path.join(root,'personal-draft.json'),'utf8'), 'SYNTHETIC_PRIVATE_DRAFT');
});

test('rebuilding fixed dist removes stale output and produces identical hashes without changing source', async t => {
  const root = await fixture(t), one = await buildDistribution(root), before = await contents(one.output);
  const source = await readFile(path.join(root,'README.md'));
  await writeFile(path.join(one.output,'stale-private-output.json'), 'SYNTHETIC_OLD_OUTPUT');
  const two = await buildDistribution(root);
  assert.deepEqual(await contents(two.output), before);
  assert.deepEqual(await readFile(path.join(root,'README.md')), source);
});

test('missing public source fails before changing existing build output', async t => {
  const root = await fixture(t), built = await buildDistribution(root);
  await writeFile(path.join(built.output,'keep.txt'), 'SYNTHETIC_KEEP');
  await rm(path.join(root,'README.md'));
  await assert.rejects(buildDistribution(root), /ENOENT/);
  assert.equal(await readFile(path.join(built.output,'keep.txt'),'utf8'), 'SYNTHETIC_KEEP');
});

test('redirected dist is rejected and an external directory remains untouched', async t => {
  const root = await fixture(t), outside = await mkdtemp(path.join(os.tmpdir(), 'yuliao-external-'));
  assert.ok(path.dirname(outside) === os.tmpdir());
  t.after(() => rm(outside, {recursive:true, force:true}));
  await writeFile(path.join(outside,'keep.txt'), 'SYNTHETIC_EXTERNAL_KEEP');
  await symlink(outside, path.join(root,'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildDistribution(root), /Unsafe existing dist output/);
  assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'), 'SYNTHETIC_EXTERNAL_KEEP');
});
