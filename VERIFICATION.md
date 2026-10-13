# 发布验证

日期：2026-10-13。实际运行环境为 Windows、Node.js 24.19.0。

完整 `node --test`：**332 项通过，0 失败，0 跳过**。包括原有 300 项和发布前新增 32 项：解析与草稿安全 12 项、应用资源限制 16 项、公开构建 4 项。根目录 `.mjs` 语法检查、中文 Windows 启动脚本和实际回环 HTTP 通过。构建仅含固定公开白名单，重复构建内容哈希一致；拒绝重定向输出，清除旧生成目录中的遗留输出，不打包任意文章、草稿或额外图片。

测试覆盖 Markdown/HTML 转义、链接协议、阻止远程及 SVG 图片、文件路径匹配与异常、本机静态文件白名单和目录穿越；新增测试覆盖 200K 畸形语法、深层括号、批量图片与草稿成员、5 MiB UTF-8 正文、20 MiB 单图、64 MiB 图片数据预算、3 个并发读取上限、失败原子保留、10 万索引、旧稿恢复和原样备份导出。25,000 组确定性随机解析输入与修复前结果相同。

新输入超限给出提示且不截断原文。符合旧格式的较大多字节草稿仍能恢复、删减、撤销、备份和原样导出；超出当前正文排版上限时暂停预览和富文本输出。

六张合成 PNG 与随附生成器结果逐字节一致，只含 IHDR、IDAT、IEND 数据，无 EXIF、GPS 或文本元数据。带图合成 HTML 的五张图片均来自这些样例。保留的 markdown-it bundle 和 Raphael 原始许可证已与官方来源逐字节核验，版本和哈希见 [第三方声明](THIRD_PARTY_NOTICES.md)。

markdown-it 的 `html`、`linkify`、`typographer` 均关闭并由测试锁定。14.1.0 的相关官方 DoS 公告以开启 linkify/typographer 为触发条件；本配置符合公告的临时规避方案，不能据此宣称不存在其他漏洞。[官方公告](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-r7fv-28h4-cvq7)、[linkify 公告](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-6v5v-wf23-fmfq)

CI 已配置 Windows/Linux、Node.js 22/24 的测试及构建矩阵，使用固定提交的官方动作、只读权限且不持久保存 checkout 凭据。**CI 配置尚未在 GitHub 执行，不代表这些矩阵已通过。** 本地完整日志留在仓库外，不随源码发布。

本项目的自动测试使用合成文章、生成图片和内存 DOM，不读取用户真实笔记，不代替真实浏览器、系统剪贴板、IndexedDB 或微信公众号验收。

实际浏览器视觉、剪贴板图片粘贴及权限、IndexedDB 落盘和重启恢复、其他系统运行、微信公众号后台保存和手机预览均未由本次自动测试验证。不保证微信保留 Base64 图片。GitHub Pages 仅有 [方案](docs/PAGES.md)，尚未启用；个人网站、域名和部署设置未修改。
