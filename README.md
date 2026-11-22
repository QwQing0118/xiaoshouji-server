# 小手机

一个人的聊天页面 + 自己的后端。一个 Node 服务，零依赖，数据存在本地一个 SQLite 文件里。

## 跑起来

装 Node 20 以上（要自带 `node:sqlite`，Node 22+ 最稳）：

```bash
cd sm_server
node server.js
```

然后浏览器打开：

```
http://127.0.0.1:8787
```

就这样，没有 npm install，没有依赖包。

换端口：

```bash
PORT=9000 node server.js
```

## 目录

```
sm_server/
├── server.js          后端，全在里面
├── public/
│   └── index.html     前端，也全在里面
├── data/              数据库在这（第一次启动自动生成）
│   └── sm.db
└── uploads/           上传的图片存这
```

## 数据在哪

全在 `data/sm.db` 一个文件里。

- 备份：把整个 `data/` 和 `uploads/` 拷走就行
- 换机：拷过去放回原位，接着用
- 也可以进页面「设置 → 数据备份 → 导出全部」，导出一个 json

## 页面上有什么

- 聊天：流式逐字输出，短句分条，支持图片、文件、表情包
- 记忆：按词组命中才带进对话，不是每句都塞
- 设置：接口地址、密钥、模型、人设、数据备份

接口地址和密钥存在后端，页面上拿不到明文，只显示掩码。

## 接口

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/api/ping` | 活着没 |
| GET/POST | `/api/cfg` | 读/写配置 |
| POST | `/api/models` | 拉模型列表 |
| POST | `/api/chat` | 流式对话（SSE） |
| GET/POST/DELETE | `/api/msgs` | 聊天记录 |
| GET/POST/DELETE | `/api/mem` | 记忆 |
| POST | `/api/upload` | 传图片 |
| GET | `/api/backup` | 导出整包 |
| POST | `/api/restore` | 导入整包 |

## 手机上长期跑

Termux 里装 Node：

```bash
pkg install nodejs
node server.js
```

想让它别被系统杀掉，把 Termux 加到电池白名单，或者用 `termux-wake-lock`。

## 需要 node:sqlite

`server.js` 用的是 Node 自带的 `node:sqlite`，不用装 `better-sqlite3`，所以没有编译问题。

Node 版本低于 22 会报错找不到模块，升一下就行。

## 一个注意

前端页面必须从后端打开（`http://...`），不要用 `file://` 直接双击。

因为用 `file://` 打开时跟后端是两个不同的源，浏览器会拦住跨域请求。真要用文件打开，可以进设置页把「接口地址」填上后端地址，但最省事的还是从后端打开。
## 目录结构

```
sm_server/
├── server.js          # 整个后端（零依赖，Node 原生 http + node:sqlite）
├── public/
│   ├── index.html     # 整个前端（单文件：聊天 / 记忆星系 / 主页档案 / 设置）
│   ├── avatars/       # 公共头像库
│   └── stickers/      # 内置贴纸
├── data/              # 运行时自动生成（不提交）：sm.db
└── uploads/           # 运行时自动生成（不提交）：图片 / 文件
```

## 已经做完的

### 1. 自包含原生工具体系（完全不依赖 Operit）
后端内置 12 个工具，模型可自己调用，前端聊天气泡上方会挂一条可折叠的调用卡片（参数 / 结果 / 失败标记）：

| 工具 | 作用 |
| --- | --- |
| `mem_search` | 在记忆库里模糊翻找 |
| `mem_add` | 往记忆库钉一条 |
| `chat_search` | 翻历史聊天记录 |
| `stats` | 数一数说过多少句、聊了多久 |
| `time` | 拿到当前时间 |
| `file_list` / `file_read` / `file_write` | 自己的沙盒目录内列 / 读 / 写（越界会被拦） |
| `calc` | 当场算数 |
| `desire` | 读自己的心潮状态 |
| `weather` | 查真实天气 |
| `web` | 轻量网络检索 |
| `change_avatar` | 换自己的头像；换对方的头像必须先发申请卡片等同意 |
| `send_sticker` | 直接发一张贴纸 |

### 2. 心潮注入
对话前先把 12 股内在驱力按各自上限的百分比换算成“涌 / 满着 / 平 / 静”，翻译成一段隐式提示塞进系统提示词，只影响语气分量，不念数字。`/api/xc/preview` 可直接看当前注入的内容。

### 3. 记忆库
- 星系画布可视化（单指拖拽、双指缩放）
- 批量导入：原生底部抽屉，选本地 `.json` / `.txt` / `.md` 自动解析入库（JSON 数组、或每行 `标题：内容`）
- 单条新增 / 编辑 / 置顶

### 4. 主页二人档案
- 可改青青与林言的名字、头像、个性签名
- 公共头像库 `/api/avatars`
- AI 换自己头像直接生效；换青青头像会推送一张带“同意 / 拒绝”的申请卡片

### 5. 表情包
- 纯图片表情库，彻底没有字符颜文字
- 支持从相册导入、长按删除，点一下以无底贴纸气泡发出

### 6. 多模态
- 拍照 / 相册发图包装成标准 `image_url` 结构推给模型，模型真的能看图
- 发文件带上下文摘要，不再报错

### 7. 接口配置
- 字段双向映射：`apiUrl ↔ base`、`apiKey ↔ key`、`apiModel ↔ model`
- 空值保护：库里已有的地址 / key / 模型不会被刷新页面时的空串冲掉

## 启动脚本

```bash
sh start.sh
```

（后台拉起，日志写到 `run.log`）
