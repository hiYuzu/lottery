# 多人同步抽奖系统 — 优化与新功能设计

**日期**：2026-05-16
**场景**：年会抽奖，几十到几百人
**部署**：灵活（局域网 / 云服务器）

---

## 目标文件结构

```
server.js                ← 单文件后端（扩展 API）
public/
  common.js              ← ES module 公共模块
  index.html             ← 抽奖页
  script.js              ← 抽奖页逻辑（type="module"）
  admin.html             ← 管理页
  admin.js               ← 管理页逻辑（从内联拆出）
  display.html           ← 大屏展示页（新增）
  display.js             ← 大屏页逻辑（新增）
  style.css              ← 扩展新样式
  data/list.json
  uploads/               ← 奖项图片/音效上传目录（新增）
```

新增 npm 依赖：`xlsx`（Excel 导出）、`qrcode`（二维码生成）。

---

## 阶段 1：安全与基础

### 1.1 管理员鉴权

**方案**：环境变量密码 + HMAC-SHA256 无状态 token

- 环境变量 `ADMIN_PASSWORD` 配置密码（默认 `admin123`，启动时控制台警告）
- 新增 `GET /login` 页面（密码输入表单），登录后服务端设置 `HttpOnly` cookie
- Token 为 HMAC-SHA256 签名，有效期 24 小时，服务端无状态验签
- WebSocket 连接通过 URL 参数 `?token=xxx` 传递 token，服务端在 `connection` 事件中验证
- 两级权限：
  - **普通用户**（无 token / 无效 token）：可观看、可触发抽奖
  - **管理员**（有效 token）：可修改奖项、重置、撤销、管理名单、上传文件
- 服务端新增 `HMAC_SECRET`，首次启动自动生成并持久化到 `.secret` 文件

**新增 WebSocket 消息：**

| 方向 | 类型 | 说明 |
|------|------|------|
| Client → Server | `login` | `{ type: 'login', password }` |
| Server → Client | `loginResult` | `{ type: 'loginResult', success, token? }` |

**新增 REST API：**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 密码验证，成功返回 token |
| GET | `/api/verify` | 验证 token 有效性 |

### 1.2 服务端 XSS 防护

- `ws.on('message')` 入口统一过滤：对所有客户端传入的字符串字段做 `stripHtml`（移除 `<>` 标签）
- 作用于奖项名称、密码等所有字符串输入
- 前端 `escapeHtml` 保留作为渲染层双重防护

### 1.3 公共模块 common.js

ES module，导出：

```
escapeHtml(str)              — HTML 转义
showToast(el, msg, type)     — Toast 提示（el 为 toast 容器 DOM）
createWS(options)            — WebSocket 连接管理器
loadNameList()               — 加载并缓存名单
parseNameList(data)          — 统一解析名单数据结构（返回 { names, hqPool }）
exportToText(state)          — TXT 文件导出
```

`createWS` 返回对象：

```
{
  send(msg),                  — 发送消息（断线时自动排队）
  on(type, handler),          — 注册消息处理器
  close(),                    — 关闭连接
  isConnected,                — 当前连接状态
  onConnectStateChange(cb),   — 连接状态变更回调
}
```

- 内置指数退避重连（1s 基础，30s 上限）
- 内置消息队列，断线期间 `send()` 的消息排队，重连后自动发送，队列上限 10 条

### 1.4 admin.js 外置

从 `admin.html` 的 `<script>` 提取全部逻辑到 `admin.js`，改为 `<script type="module">` 引入 `common.js`。

---

## 阶段 2：核心功能增强

### 2.1 撤销上一次抽奖

- 新增 WebSocket 消息：`undo`（仅管理员）
- 服务端逻辑：`state.history` 最后一条出栈，对应 prize 的 `drawn` 中移除中奖者
- 广播 `undoResult`，所有客户端更新状态
- 约束：只能撤销最近一次抽奖；如果撤销目标奖项在抽奖后被删除或修改过总量导致不一致，则拒绝撤销
- `state` 新增 `lastDrawTime` 字段，每次 draw 时更新

### 2.2 大屏展示模式

**新页面**：`display.html` + `display.js`

- 全屏布局：隐藏工具栏，奖项名大字号居中，滚动名字区域占满屏幕
- 自动选择当前可抽奖的奖项（跳过已满的）
- 无操作按钮，仅展示（抽奖由其他客户端触发）
- 抽奖结果全屏弹出 + 增强版烟花效果
- 首页右上角新增"大屏模式"按钮，跳转 `/display.html`

### 2.3 抽奖倒计时

- 点击"开始抽奖"后显示 3→2→1 倒计时动画（每数字 0.8 秒，共 2.4 秒）
- 倒计时结束后进入名字滚动阶段
- 按钮文案变为"⏹ 停止"，点击后发送 draw 请求
- 大屏页面同步显示倒计时

### 2.4 快捷键

- `空格`：开始/停止抽奖（等效点击按钮）
- `Esc`：关闭中奖弹窗
- 仅抽奖页生效，输入框获焦时不触发

### 2.5 断线重连排队

- 已在 `createWS` 中内置（阶段 1.3），队列上限 10 条
- 重连成功后自动清空队列，发送排队消息
- 队列满时丢弃最早的消息并 toast 提示用户

### 2.6 导出 Excel

- 新增 `GET /api/export?format=xlsx`（需管理员 token）
- 使用 `xlsx` 库生成，包含两个 sheet：
  - **中奖汇总**：奖项名、中奖者、中奖时间
  - **抽奖记录**：时间、奖项、中奖者列表
- 前端调用后触发浏览器下载
- 原 TXT 导出保留

### 2.7 实时在线人数

- 服务端在所有广播消息中附带 `onlineCount: wss.clients.size`
- 新增广播事件：客户端连接/断开时发送 `{ type: 'onlineCount', count }`
- 前端在页面右上角显示"在线 X 人"

### 2.8 名单管理后台

- 管理页新增"名单管理"区块：
  - 表格形式查看所有人员（姓名、地区/部门）
  - 添加人员（姓名 + 地区输入框）
  - 删除人员（每行删除按钮）
  - 批量导入（textarea 粘贴，每行格式：姓名,地区）
- REST API 变更：
  - `GET /api/names` — 返回完整数据（含 dept）
  - `PUT /api/names` — 更新名单（需管理员 token，body 为完整名单数组）
- 服务端原子写入 `list.json`

---

## 阶段 3：体验增强

### 3.1 烟花动画改进

- 移除 `ctx.fillStyle = 'rgba(0,0,0,0.15)'` 半透明覆盖
- 改为每帧 `clearRect` 清空画布，仅绘制 `life > 0` 的活跃粒子
- 粒子透明度由 `globalAlpha = life` 控制，自然淡出无残影

### 3.2 移动端响应式优化

- 抽奖按钮：小屏幕 `padding: 12px 32px`，字号 16px
- 滚动名字：小屏幕 `font-size: 28px`，长名字用 `transform: scale()` 自适应
- 奖项选项卡：小屏幕字号缩小，允许横向滚动
- 改动集中在 `@media (max-width: 700px)` 区域

### 3.3 二维码入口

- 新增 `GET /api/qrcode`，返回 SVG 格式二维码
- 使用 `qrcode` 库生成，内容为 `http://<本机IP>:<port>`
- IP 地址服务端启动时自动检测
- 首页和管理页右上角新增二维码按钮，点击弹窗显示

### 3.4 奖项图片

- 奖项数据结构新增 `image` 字段（可选，存储文件名）
- 管理页奖项编辑器新增图片上传
- `POST /api/upload`（需管理员 token），存到 `public/uploads/`
- 抽奖页/大屏页：选项卡旁显示缩略图，中奖弹窗展示奖品图片
- 限制：jpg/png，2MB 以内

### 3.5 音效自定义上传

- 管理页新增"音效管理"区块，上传背景音乐和中奖音效
- 复用 `POST /api/upload`，上传到 `public/music/`
- 前端检测并动态加载 `bg.mp3` / `win.mp3`
- 限制：mp3，5MB 以内

### 3.6 中奖结果分享图

- 中奖弹窗新增"生成海报"按钮
- 纯前端 Canvas 绘制：背景渐变 + 奖项名 + 中奖者 + 时间 + 二维码
- `canvas.toBlob()` 生成图片下载
- 不依赖第三方库

### 3.7 多轮抽奖会话

- `state.json` 结构变更：

```json
{
  "currentSession": "session-2026-05-16",
  "sessions": {
    "session-2026-05-16": { "prizes": [...], "history": [...] }
  }
}
```

- 管理页新增"活动管理"区块：创建新活动、切换活动、查看历史
- 切换活动时广播 `sessionChanged`，所有客户端更新
- 旧版 `state.json` 自动迁移为单会话格式

---

## 新增 WebSocket 消息汇总

| 方向 | 类型 | 阶段 | 权限 |
|------|------|------|------|
| C→S | `login` | 1 | 任意 |
| S→C | `loginResult` | 1 | — |
| C→S | `undo` | 2 | 管理员 |
| S→C | `undoResult` | 2 | — |
| S→C | `onlineCount` | 2 | — |
| S→C | `sessionChanged` | 3 | — |

## 新增 REST API 汇总

| 方法 | 路径 | 阶段 | 权限 |
|------|------|------|------|
| POST | `/api/login` | 1 | 任意 |
| GET | `/api/verify` | 1 | 任意 |
| PUT | `/api/names` | 2 | 管理员 |
| GET | `/api/export?format=xlsx` | 2 | 管理员 |
| GET | `/api/qrcode` | 3 | 任意 |
| POST | `/api/upload` | 3 | 管理员 |
