# GitHub Pages 静态网页版方案

这是后续部署方案。当前仓库提供本地运行方式，**未启用 GitHub Pages，没有修改个人网站或配置部署**。

## 可行性

编辑器、Markdown 渲染、图片匹配和草稿处理都在浏览器中完成，不依赖 Node 后端接口。Node 服务仅提供程序静态文件，因此可以准备独立的静态构建。[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) 支持 HTML、CSS 和 JavaScript，但不能运行这里的 Node 服务。

当前页面资源和模块使用相对路径，适合项目站点 `/yuliao-wechat-editor/` 子路径，不应改成站点根目录的 `/app.mjs` 等路径。上线前仍需在实际子路径逐项检查模块、CSS 和依赖加载，不能把本机服务通过当作部署验收。

## 发布前要做的工作

1. 增加单独的静态构建输出，程序资源按 `server.mjs` 白名单收录：入口 HTML、CSS、浏览器模块和渲染依赖，另附必要许可证及依赖声明。不能直接把当前用于本地分发的 `dist/` 整个目录部署；其中可能含 Node 服务、启动脚本和样例，不是网页最小集合。
2. 将随附 `vendor/markdown-it.cjs` 复制为浏览器可正确识别 MIME 的 `.js` 文件，并同步改写静态入口引用。这里是已有浏览器 UMD 依赖的文件名适配，不是转换服务器 CommonJS 程序。检查 `.mjs` 的 JavaScript MIME 和所有依赖是否成功加载。
3. 保留页面 CSP 与无远程图片读取的规则；确认不加入统计、上传、外部字体或第三方脚本。Pages 无法沿用 Node 返回的所有 HTTP 安全头，需检查页面内策略及静态宿主行为。
4. 只发布公开程序资源。不得将用户文章、图片、完整草稿、导出文件、备份、日志、密钥或本机路径打入静态产物。
5. 在得到明确部署授权后配置独立项目的 Pages 发布来源，再验证 HTTPS、子路径、选择目录、实际剪贴板、图片显示和草稿恢复。

## 网页权限与存储

HTTPS 有利于剪贴板 API，但不代表每次复制必然成功，仍取决于用户点击、浏览器支持及权限。[MDN Clipboard.write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write) 说明了安全上下文要求。

静态网页仍只能读取用户主动选择、拖入或粘贴的本地文件。GitHub Pages 提供程序文件，不使程序获得磁盘扫描权限；远程网页上的隐私承诺也需在构建产物中验证。站点访问本身会请求静态宿主，宿主有其日志与隐私政策；“文章图片不上传”不等于访问网页没有网络请求。

从本机回环地址换到 HTTPS 站点是新的浏览器存储来源。旧草稿不会自动出现，应在本地导出完整草稿，再在新地址手动导入，验证后保留备份。

IndexedDB 使用[同源规则](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)，隔离按协议、主机和端口，而非 URL 路径。同一账号的多个 `github.io` 项目通常共享来源；不同项目路径并非私密数据隔离边界。正式部署应确认是否需要独立域名和数据库命名策略，同时保留草稿迁移兼容性。

账号主站若使用自定义域名，项目站点还可能继承该域名。启用前检查主站、项目站点地址和 DNS，不要为部署工具而修改已有个人网站或其域名设置。详见 [GitHub 自定义域名说明](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)。

完成静态构建及上述验收后，才可将网页版链接作为可用入口。微信保存、Base64 图片保留和真实手机预览仍需另外手动验证。
