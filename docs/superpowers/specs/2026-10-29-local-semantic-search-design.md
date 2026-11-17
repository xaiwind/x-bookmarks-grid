# 本地 AI 语义搜索设计

## 目标

为本地收藏库增加自然语言语义搜索，支持中英文等多语言查询。功能关闭时保持现有关键词搜索；开启后将词法与语义结果合并。搜索问题、帖子内容、项目和备注不发送到服务器。

## 模型与数据边界

采用 multilingual E5 small 的量化 ONNX 模型，通过 Transformers.js 在本机推理。首次使用时由用户明确点击“下载并启用”，预计下载约 136 MB；模型文件来自 Hugging Face，固定到明确 revision。此后模型和 WASM 运行时缓存在扩展本地 Cache Storage，向量保存在当前 Chrome 配置的 IndexedDB。模型下载被取消或失败时保持关键词搜索可用。Transformers.js 文档支持 Web Worker、本地浏览器缓存、WebGPU/WASM 等执行选项；同类扩展使用 E5 实现跨语言检索，并提示 512-token 输入上限。

模型 JavaScript/WASM 运行时代码随扩展本地打包，禁止运行时下载脚本。只有显式模型下载操作可访问模型托管域名；下载完成后的搜索关闭远程模型加载。Manifest 仅增加模型下载所需的 Hugging Face 主机权限及本地大容量存储权限。

## 索引和搜索

在独立 Web Worker 中执行嵌入，避免阻塞管理页。每条记录的索引文本由标题、作者、正文、外链、项目名称、备注、收藏原因和使用用途组成；使用文本指纹跳过未变化的记录。向量单独存储在 IndexedDB `embeddings` store，按帖子 ID 更新；模型启用后打开管理页或开始语义查询时补齐新增/变化记录。提供索引进度、取消、重建索引、删除模型与向量的控件。

查询使用 E5 `query:` 前缀，记录使用 `passage:` 前缀。计算归一化向量余弦相似度，将语义排名与现有关键词排名通过 Reciprocal Rank Fusion 合并，再应用作者、日期、分类、状态、项目和外链等筛选。语义索引缺失、设备推理失败或模型文件不可用时回退到关键词结果。模型将长输入截断在 512 tokens；首期在详情区提示该限制。

## 验收

- 首次打开管理页不下载模型、不创建模型索引、不发模型网络请求。
- 只有用户明确启用后才下载固定版本模型并显示进度；取消后可继续关键词搜索。
- 中英文跨语言查询可检索语义相关的帖子；结果仍可和现有筛选组合使用。
- 收藏、搜索问题和备注都在本地；模型启用后的搜索不发外部网络请求。
- 重复索引不会创建重复向量；帖子或备注变化后只重算对应记录。
- 删除模型与索引会清除缓存、向量、状态和启用同意；导出数据不包含模型文件或向量。

## 自审

- 无云服务和 API 费用，代价是约 136 MB 的显式首次模型下载和设备推理开销。
- 默认关键词行为不变；语义索引/模型错误回退，不阻断核心收藏管理。
- 模型下载与搜索网络边界明确；项目代码和 WASM 运行时不得远程执行。

## 参考

- [Bookmark X 语义搜索架构](https://github.com/LucasDitchun/export-bookmarks-x-twitter/blob/main/docs/SEMANTIC_SEARCH.md)
- [Transformers.js 环境与缓存配置](https://huggingface.co/docs/transformers.js/en/api/env)
- [Xenova multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small)
