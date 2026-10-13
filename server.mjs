import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

export const PUBLIC_FILES = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['index.html', ['index.html', 'text/html; charset=utf-8']],
  ['styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ...['app.mjs', 'core.mjs', 'clipboard.mjs', 'drafts.mjs', 'components.mjs', 'history.mjs', 'directories.mjs', 'source-metadata.mjs', 'recommendation-title.mjs', 'layout-settings.mjs', 'input-limits.mjs', 'preview-sync.mjs', 'preview-layout.mjs', 'references.mjs', 'preflight.mjs'].map(file => [file, [file, 'text/javascript; charset=utf-8']]),
  ['vendor/markdown-it.cjs', ['vendor/markdown-it.cjs', 'text/javascript; charset=utf-8']],
]);

export function createLocalServer(root = path.dirname(fileURLToPath(import.meta.url))) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'clipboard-write=(self), camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; frame-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const fail = (status, message) => { res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8'}); res.end(message); };
    if (!/^((127\.0\.0\.1)|(localhost))(:\d+)?$/.test(req.headers.host || '')) return fail(403, '仅允许本机回环地址');
    if (!['GET', 'HEAD'].includes(req.method)) return fail(405, '只支持读取静态页面');
    let requestPath;
    try { requestPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\//, ''); }
    catch { return fail(400, '无效路径'); }
    if (requestPath.split('/').some(part => ['..', '.'].includes(part)) || requestPath.includes('\\') || requestPath.includes('\0')) return fail(403, '无效路径');
    const entry = PUBLIC_FILES.get(requestPath);
    if (!entry) return fail(404, '文件不存在');
    try {
      const bytes = await readFile(path.join(root, entry[0]));
      res.writeHead(200, {'Content-Type': entry[1], 'Content-Length':bytes.length});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { fail(500, '页面文件缺失，请重新解压完整项目'); }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.XIEYULIAO_PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('XIEYULIAO_PORT 必须在 1024～65535 之间');
  const server = createLocalServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 正在使用。关闭已有工具，或设置 XIEYULIAO_PORT 为其他端口。` : `启动失败：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`谢雨聊 · 本地排版工具\n在 Edge / Chrome 打开：http://127.0.0.1:${port}\n仅本机访问，不读取 Obsidian 原稿；选取文件后由浏览器处理。\n关闭此窗口或按 Ctrl+C 停止。`);
  });
}
