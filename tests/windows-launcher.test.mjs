import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

test('Windows 中文路径启动 cmd 提供实际回环页面', {skip:process.platform !== 'win32', timeout:20000}, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = 18769;
  const launchEnv = {...process.env, XIEYULIAO_PORT:String(port)};
  const pathKey = Object.keys(launchEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  launchEnv[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${launchEnv[pathKey] || ''}`;
  const proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '启动谢雨聊.cmd'], {
    cwd:root, windowsHide:true, env:launchEnv, stdio:['pipe','pipe','pipe']
  });
  let output = '';
  proc.stdout.on('data',chunk => { output += chunk.toString('utf8'); });
  proc.stderr.on('data',chunk => { output += chunk.toString('utf8'); });
  t.after(async () => {
    if (proc.exitCode === null) await new Promise(resolve => execFile('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,timeout:3000}, () => resolve()));
  });
  let response;
  for (let attempt=0;attempt<70;attempt++) {
    if (proc.exitCode !== null) break;
    try { response = await fetch(`http://127.0.0.1:${port}`); break; } catch {}
    await delay(100);
  }
  assert.ok(response, `启动脚本没有提供页面：${output}`);
  assert.equal(response.status,200);
  assert.match(await response.text(),/谢雨聊/);
  assert.match(output,/18769/);
});
