# dsh-rewind-branch

回退 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话中的某一轮，然后在一个新分支里继续——同时把那轮改过的文件恢复到提问前。来源会话保持原样。

[English](README.md) | 中文

## 它做什么

每轮回答结束时，回复下方会出现一个动作：**回到这轮提问前**。

点击后：

1. 先向 Host 取回退计划——这一轮改了哪些文件、新建了哪些文件、哪些已经冲突、这一轮有哪些风险；
2. 确认后，把这些文件恢复到**提问之前**的状态（恢复前先备份当前内容）；
3. 在该消息边界 fork 出一个**新分支会话**，并自动切过去。

原会话不会被删除或截断：日志、消息、后续内容都保持原样。新分支只继承到回退点之前的那条消息为止。

## 为什么用分支而不是原地回退

原地回退会截断当前对话。分支方式把原会话作为证据保留下来，也让这次回退本身可逆：旧会话还在，随时可以对比或继续。

文件恢复**不需要 Git**。Host 会把 DSH 文件工具目标文件的写前字节存进内容寻址库，因此即使工作区不是 git 仓库（或带着无关的未提交改动），也能逐文件恢复，而不是靠 `git reset` 重置整个仓库。

## 安装

要求 DeepSeek Harness **0.2.1-rc.3 或更新版本**（已在 `dsh.engines` 中声明）。无依赖、无构建步骤，纯 JavaScript。

从 GitHub 安装：

```bash
dsh plugin --profile <profile> add "git+https://github.com/shutongcao1-design/dsh-rewind-branch.git"
```

`dsh plugin` 会在同一次操作里安装包并选中这个 bundle。**安装完成后需要完整重启 DSH**（不是刷新页面），Host 半才会启动、回合尾部的动作才会送到客户端。

这个插件没有发布到 npm，请从本仓库安装。

## 使用

1. 等某一轮回答结束——会话需要处于空闲状态。
2. 在该轮回复下方点击 **回到这轮提问前**。
3. 查看计划：要恢复的文件、要删除的新建文件、冲突、警告。
4. 点击 **确认**——文件被恢复，同时打开一个新的分支会话。

注意：

- 会话的第一轮之前没有检查点，不能回退。
- 有回合正在运行时拒绝回退（`session-running`），等它结束即可。
- 插件安装之前、或被禁用期间产生的回合没有快照。

## 捕获范围

会被捕获（每个文件一份写前字节 + 一份写后快照）：

- `write`、`edit`、`str_replace_editor`、`multi_edit`——通过 DSH 写文件的工具。

不会捕获：

- `bash`、`pwsh`、终端工具、`run_code` 等 shell/代码执行器。如果被回退的那一轮跑过这些工具，预览会给出警告，它们改过的文件不会被还原；被捕获的文件仍然正常恢复。
- 符号链接、目录、大于 4 MiB 的文件会被跳过。
- 文件权限位、ACL、硬链接、submodule 内容不会恢复。

## 冲突与安全

- Host 会把文件当前内容与该路径最晚的写后快照对比。不一致时（你手动改过、或被 shell 改过），该文件**跳过并列为冲突**，绝不覆盖。
- 任何写入之前，先把当前内容备份到 `<data>/safety/<时间戳>/`（`manifest.json` + 每个文件一个 `.bin`）。
- 真正落盘前会再做一次校验（TOCTOU）：确认弹窗打开期间被改过的文件会被跳过，而不是被覆盖。
- 写入走「临时文件 + rename」，写了一半的文件不会替换掉原本完好的文件。

## 数据

- journal 与内容寻址 blob 位于 `<DSH_HOME>/dsh-rewind-branch/`（`journal.jsonl`、`blobs/`、`safety/`）。
- 桌面版 Host 没有继承 `DSH_HOME` 时，会落在本包旁边的 `data/` 目录。
- journal 只增，超过 64 MB 轮转为 `journal.1.jsonl`。删掉该目录即清空全部检查点历史；`safety/` 里是普通文件，可以先拷走。

## 安全

- 三条 HTTP 路由（`/preview`、`/rewind`、`/client.js`）都只对同源页面开放：每条先过 `connection.requestRejection`，不是本 profile 已认证页面时直接 403（fail-closed）。
- 插件不发起任何网络请求。它只在本地存字节，并通过 Host 的 `sessions` 服务 fork 会话。
- 恢复发生在 Host 进程内、由你明确点击触发，且只作用于 journal 里该回合记录过的绝对路径。

## 兼容性与边界

- 支持 DSH Web 客户端和 DSH Desktop 壳（任何提供 Web GUI 的部署形态）。
- 工作区不需要 Git；不会改 Git 的 index、HEAD、refs 和提交。如果那一轮做过提交，提交会保留，预览会给出警告。
- 只恢复 DSH 文件工具改过的文件；shell/终端/代码运行器造成的改动只提示、不处理。
- 回退边界必须是已存在的会话事件（`turn/start.seq - 1`），所以第一轮无法回退。

## 开发

```bash
node --test test/     # 单测：计划计算、恢复执行、TOCTOU、safety 备份、manifest
npm run check         # 对每个运行时文件做语法检查
```

结构：

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：捕获、计划路由、恢复 |
| `client.js` | 浏览器半：回合尾部动作、预览面板、fork 并切换 |
| `lib/store.js` | 内容寻址 blob + 追加式 journal |
| `lib/plan.js` | 纯计划计算 + 计划执行（有单测） |
| `test/` | 单测与 manifest 检查 |

没有构建步骤：运行时文件就是普通 ESM 加一个浏览器脚本。

## 许可证

MIT，见 [LICENSE](LICENSE)。
