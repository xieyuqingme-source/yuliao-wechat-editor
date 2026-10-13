# 第三方来源与许可证

「雨聊公众号排版」的本地文件导入、Obsidian 图片匹配、异常提示、草稿、界面及导出逻辑主要为独立实现。下列来源提供参考思路或实际包含的解析代码；本工具不是 Raphael 的完整移植，也没有完成微信公众号后台保存与手机预览验证。

## Raphael Publish（设计与源码参考）

- 来源：<https://github.com/liuxiaopai-ai/raphael-publish>
- 参考版本：[1243dff64795fbfc4f33923dae4238f5bfc1812d](https://github.com/liuxiaopai-ai/raphael-publish/commit/1243dff64795fbfc4f33923dae4238f5bfc1812d)。只读源码 ZIP 的提交标识已核对；没有运行 Raphael 安装、开发、测试或部署脚本。
- ZIP SHA-256：`4c3ba3845946a32694f4a570cb98120dee3017e934ac33f72dcb79b18afb56af`
- 许可证：MIT；版权为 `Copyright (c) 2024 Raphael Editor Contributors`。
- 完整原许可证原样保存在 [vendor/Raphael-LICENSE.txt](vendor/Raphael-LICENSE.txt)。分发本工具时应一并保留。
- 参考的具体实现：`src/lib/markdown.ts` 的 Markdown 渲染及逐元素内联样式，`src/lib/wechatCompat.ts` 的 section 包装及文本样式传递，`src/App.tsx` 的编辑／预览／HTML 与纯文本剪贴板流程，以及 `src/lib/themes/` 的中文文章排版思路。没有复制其全部主题、React 界面、远程图片抓取或 PDF 导出实现。

Raphael 的源码包含浏览器预览和 Base64 转换尝试，不能由这些代码推断微信后台保存、图片留存或实际手机预览已通过。新工具也不作这项保证。

## markdown-it 14.1.0（实际包含）

- 来源：<https://github.com/markdown-it/markdown-it>
- 官方 npm 包：<https://registry.npmjs.org/markdown-it/-/markdown-it-14.1.0.tgz>
- 官方包 SHA-256：`7c4fab4d4d39fe98206a7fbbed4b1e3578f2b70b6b69d309413e33eec140e19f`
- `vendor/markdown-it.cjs` 为该官方包 `dist/markdown-it.js` 的未修改浏览器／CommonJS 通用构建，仅改文件名。
- 该文件 SHA-256：`433ba2a6946e8200c464d8845b98d826022a1836b4a713f01fa2830477c381e8`；已逐字节与官方包核对。
- 许可证：MIT，完整文本在 [vendor/markdown-it-LICENSE.txt](vendor/markdown-it-LICENSE.txt)。原包元数据在 `vendor/markdown-it-package.json`。
- 只使用预构建解析代码，不运行 npm 安装、发布或 gh-pages 脚本。

该浏览器构建包含下列第三方代码。以下文本来自相应官方 npm 包的许可证；其中 entities 为 BSD 条款，其他为 MIT 条款。列出的包版本用于本次许可证文本核验，不能据此断言每段内嵌代码的确切构建提交。markdown-it 原包依赖范围为 entities `^4.4.0`、linkify-it `^5.0.0`、mdurl `^2.0.0`、punycode.js `^2.3.1`、uc.micro `^2.1.0`；浏览器构建内 punycode.js 标明版本 `2.3.1`。

### entities

许可证核验包：<https://registry.npmjs.org/entities/-/entities-4.5.0.tgz>，`package/LICENSE`。

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### linkify-it

许可证核验包：<https://registry.npmjs.org/linkify-it/-/linkify-it-5.0.0.tgz>，`package/LICENSE`。

```text
Copyright (c) 2015 Vitaly Puzrin.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### mdurl（含 Joyent／Node 代码）

许可证核验包：<https://registry.npmjs.org/mdurl/-/mdurl-2.0.0.tgz>，`package/LICENSE`。Joyent 部分也保留在 `vendor/markdown-it.cjs` 的注释中。

```text
Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

--------------------------------------------------------------------------------

.parse() is based on Joyent's node.js `url` code:

Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

### punycode.js 与 uc.micro

许可证核验包：<https://registry.npmjs.org/punycode.js/-/punycode.js-2.3.1.tgz> 的 `package/LICENSE-MIT.txt`，及 <https://registry.npmjs.org/uc.micro/-/uc.micro-2.1.0.tgz> 的 `package/LICENSE.txt`。两者原许可证文本相同：

```text
Copyright Mathias Bynens <https://mathiasbynens.be/>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
