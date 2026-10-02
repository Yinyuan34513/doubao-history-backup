# 豆包历史备份器 (Doubao History Backup)

油猴/Tampermonkey 用户脚本：拦截豆包网页版的历史 API，自动翻页抓取你**全部**历史会话与消息，缓存进浏览器 **IndexedDB**（增量同步、不重复抓取），一键导出为 `history/<会话名>/main.md` 的 **ZIP 归档**。

## 功能

- **全量抓取**：会话列表翻页到 `has_more=false`（作者账号 3352 个会话可完整拉取），每个会话的消息按游标翻到末尾。
- **IndexedDB 缓存复用**（v1.2.0 核心）：
  - 会话元数据 + 每个会话的消息落库，刷新页面/重开浏览器后直接恢复上次进度；
  - 同步判定改为 `update_time > syncedTo`：**已抓齐且没变化的会话一律跳过**，只补抓新会话/有更新的会话；
  - 空会话抓完同样落 `syncedTo`，不再每次反复抓；
  - 列表按更新时间倒序，一旦某页全部是"已抓齐且未变化"的会话就提前停止 —— 已同步后每轮轮询**只翻 1 页**（此前每 60s 全量翻 168 页）。
- **自动刷新**：页面开着时每 60s 轮询一次（已同步状态开销 ≈ 1 个请求）。
- **面板**：右下角实时显示 会话数/消息数/待抓数、历史列表（更新时间倒序）、日志。
- **页面流量拦截**：patch `window.fetch` / `XMLHttpRequest`，你在豆包页面里正常翻历史时，流入的数据也会进缓存，并学习页面真实请求 URL 复用。
- **导出 ZIP**：使用 [JSZip](https://stuk.github.io/jszip/)（DEFLATE 压缩，未加载时回退 store），UTF-8 文件名。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)；
2. 打开安装链接任一其一：
   - GitHub：`https://raw.githubusercontent.com/Yinyuan34513/doubao-history-backup/main/doubao_history_backup.user.js`
   - Gist：`https://gist.githubusercontent.com/Yinyuan34513/f033a80d2a01be397b8e117b6b8c867d/raw/doubao_history_backup.user.js`
3. 登录 [doubao.com](https://www.doubao.com/)，右下角出现面板即生效，脚本会自动开始首次全量同步。

> 首次全量抓取耗时较长（3352 会话约 1 小时，取决于网络与限流），中途刷新页面也没关系，**进度存在 IndexedDB 里，下次继续**。

## 导出格式

点击「导出归档」得到 `doubao-history-<时间戳>.zip`：

```
history/
  <会话名>/
    main.md
  ...
```

`main.md` 模板：

```markdown
# 会话标题
**Session ID:** <conversation_id>
**Created:** 21/9/2026
**Updated:** 2/10/2026

---

## User(Name: 你的昵称)

用户消息内容

---

## Assistant(Model: 豆包)

_Thinking:_（思考过程，如有）

Body:
回复正文

---
```

- 日期格式 `D/M/Y`；
- 消息按 `index_in_conv` 升序；
- 图片输出为 `![image](url)`；附件占位为 `[图片附件]`。

## 豆包历史 API（逆向自抓包）

| 端点 | cmd | 用途 | 关键参数 |
|---|---|---|---|
| `/im/chain/recent_conv` | 3200 | 会话列表 | 第 1 页 `conv_version:0, direction:3, project_filter:0, need_coco_bot:true`；后续页 `conv_version:<上页 next_conv_version>, direction:1, project_filter:1`；到 `has_more:false` |
| `/im/chain/single` | 3100 | 单会话消息 | `anchor_index` 初始 `9007199254740991`，按 `next_index` 翻页，`direction:1`（新→旧） |
| `/im/conversation/batch_get` | 1111 | 批量会话信息 | `user_type='1'` 的 `nick_name` 作用户名兜底 |
| `/im/conversation/info` | 1110 | 单会话信息 | 名称/时间戳补全 |
| `/alice/profile/self` | — | 个人资料 | `nickname` |

**请求头硬性要求**（否则 `status_code 712012002 "不支持编码类型"`，返回 0 消息）：

```
content-type: application/json; encoding=utf-8
accept: application/json, text/plain, */*
agw-js-conv: str
```

消息解析：`user_type` 1=用户 / 2=AI；正文 `content_block[].block_type==10000 → text_block.text`；思考 `thinking_content`；模型名 `ext.bot_state(JSON).bot_name`（兜底 `豆包`）。

## 已知限制

- 列表接口响应**无 total 字段**，历史总数只能靠翻页数完才知道；
- 列表请求 `exclude_archive=true`，已归档会话不在拉取范围；
- 消息里的图片只保存 URL，未下载图片本体；
- 需要登录态：脚本用页面 cookie 直连豆包 API，不上传任何数据到第三方，缓存仅存本地 IndexedDB（库名 `doubao_history_backup`）。

## 本地开发

```bash
node --check doubao_history_backup.user.js   # 语法
node /tmp/dbb_test2.js                        # mock 服务端仿真（11 项断言）
```

## License

MIT
