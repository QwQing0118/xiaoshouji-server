# 交接说明（换窗口前看这个）

写于 2026-11-22。

## 一句话

小手机是**完全独立**的一套东西：一个零依赖 Node 服务（`server.js`）+ 一个单文件前端（`public/index.html`）+ 一个 SQLite（`data/sm.db` 运行时自动生成）。全程不经过 Operit。

## 怎么跑

```bash
cd sm_server
node server.js          # 监听 0.0.0.0:8787
```

浏览器打开 `http://127.0.0.1:8787`。

工作副本在手机上：`/sdcard/Download/sm_server/`
发布副本：`/sdcard/Download/sm_release/`（改完要 `cp` 同步）

## 当前状态

已跑通并实际验证过的：
- 12 个原生工具（`mem_search` / `mem_add` / `chat_search` / `stats` / `time` / `file_list` / `file_read` / `file_write` / `calc` / `desire` / `weather` / `web`）＋ `change_avatar` / `send_sticker`
- 工具调用卡片（气泡上方可折叠，含参数与结果）
- 心潮 12 股驱力按百分比换算档位注入系统提示词
- 配置双向映射与空值保护（`apiUrl ↔ base` 等）
- 多模态：图片以 `image_url` 推给模型

已经改完、**还没经青青实测**的：
- 记忆批量导入改成原生底部抽屉（`mSheetMask`），只留【取消】+【从文件导入】
- 表情面板彻底删掉字符颜文字，改纯图片库；发送类型 `stk` 与渲染器 `sticker` 已兼容

## 已知坑

1. **Node 进程会被系统静默杀掉。** 表现是浏览器打开失败。`sh start.sh` 可重新拉起，长期应该加 watchdog。
2. **前端缓存很顽固。** 改完一定要用带时间戳的链接打开：`?v=YYYYMMDDxxx`，并确认 `serveFile` 里 html 是 `no-store`。
3. **改前端后必须做语法自检**，否则整个页面 JS 死掉，底部 Dock 都不能点：
   ```bash
   python3 -c "import re;s=open('public/index.html',encoding='utf-8').read();open('/tmp/a.js','w').write(re.findall(r'<script.*?>([\s\S]*?)</script>',s)[0])"
   node --check /tmp/a.js
   ```
4. **弹窗别用裸 `position:fixed` 手拼。** 记忆页底下是 Galaxy 画布，全局手势会截胡点击事件。统一用 `mSheetMask on` + `mSheetBox`。
5. **千万别再往表情面板塞字符颜文字。** 青青明确要求过多次。

## 接下来该做的

1. 公共头像库 `/public/avatars/` 里现在是 4 张占位 SVG，要换成真正好看的头像，并让模型知道自己有换头像这个能力。
2. 自定义表情目前存在浏览器 `localStorage`，清缓存就没了，应改成上传到后端持久化（参考 `uploads/` 与 `/api/up`）。
3. 定时任务 / 提醒 / 天气推送这类「主动开口」的能力还没有。
4. 启动守护（进程死了自动重启）。

## 接口速查

| 路径 | 用途 |
| --- | --- |
| `GET /api/ping` | 存活检查 |
| `GET/POST /api/cfg` | 模型配置（含空值保护） |
| `POST /api/chat` | 对话（含工具循环、心潮注入、多模态） |
| `GET/POST /api/mem` | 记忆列表 / 批量写入 |
| `GET /api/msgs` `POST /api/msgs` | 聊天记录 |
| `GET /api/xc` `/api/xc/preview` | 心潮状态 / 当前注入文案 |
| `GET /api/avatars` | 公共头像库 |
| `POST /api/avatar/apply` | 同意换头像申请 |
| `POST /api/up` | 上传图片 / 文件 |
