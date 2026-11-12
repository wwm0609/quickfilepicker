这是一个vscode filepicker 插件，在大型项目中相比vscode原生的file picker速度更快

代码结构: src/ 下按职责分层 — search.ts/trigramIndex.ts/indexedFile.ts 是纯逻辑(无 vscode 依赖,可 npm test 单测),
fileIndexing.ts 管数据库构建与增删,quickOpen.ts 只管 UI,settings.ts 管排除配置,paths.ts/logger.ts 是基础工具。
数据库位于 ~/.q_file_picker/<workspace>/file_index.db(纯文本路径列表),启动时重建 trigram 内存索引。
