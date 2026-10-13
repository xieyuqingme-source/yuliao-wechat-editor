import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalServer} from '../server.mjs';

test('真实回环 HTTP：主页面、模块、CSP、路径与 host 防护', async t => {
  const server = createLocalServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(await page.text(), /谢雨聊/);
  for (const file of ['core.mjs', 'app.mjs', 'clipboard.mjs', 'drafts.mjs', 'components.mjs', 'history.mjs', 'directories.mjs', 'source-metadata.mjs', 'recommendation-title.mjs', 'layout-settings.mjs', 'input-limits.mjs', 'preview-sync.mjs', 'preview-layout.mjs', 'references.mjs', 'preflight.mjs', 'vendor/markdown-it.cjs']) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(`${base}/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/read?path=X:/Example%20Vault`)).status, 404);
  assert.equal((await fetch(base, {method:'POST',body:'private data'})).status, 405);
  await new Promise((resolve,reject) => {
    const req = http.get(`${base}/`, {headers:{Host:'attacker.example'}}, response => {
      assert.equal(response.statusCode, 403);
      response.resume(); response.on('end',resolve);
    }); req.on('error',reject);
  });
  await new Promise((resolve,reject) => {
    const req = http.get(`${base}/%2e%2e%5csecret`, response => {
      assert.equal(response.statusCode,403);
      response.resume(); response.on('end',resolve);
    }); req.on('error',reject);
  });
});
