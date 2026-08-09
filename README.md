# Codex Remote Contact (Windows)

在 Windows 上运行的 QQ 远程控制中枢：把 QQ 变成 Codex 的遥控器。
管理员私聊直接获得完整 Codex 通道——开软件、执行命令、读写文件、截图、防休眠，
就像在本地终端里对话；群聊默认只读短回复，安全边界清晰。

项目复刻并扩展了 [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact)
（原版是 macOS + iMessage 的架构），本仓库为 Windows 移植版：
QQ/OneBot（NapCat）通道 + Codex CLI 回复 + Web 服务控制台 + 远程执行 + 本机系统控制。

## 功能

- **管理员 QQ 私聊 = 完整 Codex 通道**：默认 `danger-full-access` 沙箱，带独立记忆，
  能直接操作本机（打开软件、执行命令、读写文件、截图、防休眠等）。
- **群聊 / 非管理员 = 只读短回复**：走 `codex exec -s read-only`，不能执行命令。
- **Web 服务控制台**：`http://127.0.0.1:3789`，总览 AstrBot / NapCat / Hub 状态，
  一键启停、深色主题、链路健康检查（OneBot WS / QQ 登录 / Codex CLI / 远程执行）。
- **远程执行模式**：QQ 私聊里 `/远程执行` 开启，带独立记忆、模型/推理强度/skill 可调。
- **NapCat 多账号登录态隔离**：多个 QQ 机器人各用各的数据目录，重启自动快速登录，
  不再互相覆盖登录态（见 [`modules/napcat/README.md`](modules/napcat/README.md)）。
- **本机系统控制**：防休眠、屏幕截图、软件启动（枚举开始菜单 + 精确匹配）。

## 架构

```text
QQ 手机/桌面端
    │ OneBot 11 协议
    ▼
NapCat（QQ 机器人桥，每个 QQ 一个实例，WS 端口 3001/3002…）
    │ 正向 WebSocket（ONEBOT_WS_URL）
    ▼
Hub（本仓库 node 服务，监听 127.0.0.1:3789）
    │ 管理员私聊 / 群聊 @
    ▼
Codex CLI（codex exec，按角色选择沙箱）
    │
    ├─ 打开软件 / 截图 / 防休眠（PowerShell 模块）
    └─ Computer Use（@oai/sky，可选，需本机 Codex 运行时）
```

可选：AstrBot（`modules` 之外独立部署）可并行接入另一个 NapCat 实例，互不干扰。

## 依赖

- Windows 10/11，Node.js 20+（开发环境 v22）
- Codex CLI：推荐 `npm install -g @openai/codex`；也可用环境变量
  `CODEX_CLI_PATH` 指向任意 `codex.exe`（Codex 桌面版自带的 CLI 在 WindowsApps 内
  有 ACL 保护，直接调用可能被拒，推荐 npm 版）
- NapCat（QQ 端 OneBot 桥）：`NapCat.Shell.Windows.OneKey` 一键包，每个 QQ 一个实例

## 快速开始

```bash
git clone <本仓库>
cd codex-remote-contact-win
npm start
```

1. 复制 `data/settings.example.json` 为 `data/settings.json`，填入你的 QQ 号
   （`ownerUserIds`）和允许的群号（`allowedGroups`）。
2. 在 NapCat 的 OneBot 配置里开启正向 WebSocket server（例如 3001/3002 端口）。
3. 设置 `ONEBOT_WS_URL` 并启动：

   ```bash
   ONEBOT_WS_URL=ws://127.0.0.1:3001 npm start
   ```

   或双击 `start-dashboard.bat`（隐藏启动 + 打开控制台）。
4. 打开服务控制台：<http://127.0.0.1:3789>

可选：设置 `CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH` 指向一个人格卡 md 文件
（例如祥子人格卡），Hub 会把它写进 Codex 工作区的 AGENTS.md，让回复带上风格。

## NapCat 多账号登录态隔离

多个机器人 QQ 共用同一个 `%APPDATA%\QQ` 时，登录态会互相覆盖，表现为“每次启动都
要重新扫码”。本仓库附带一份最小补丁（`modules/napcat/qq-entry.mjs`），让每个实例
通过 `NAPCAT_QQ_DATA_DIR` 环境变量使用独立数据目录，重启自动快速登录。

完整步骤见 [`modules/napcat/README.md`](modules/napcat/README.md)。

## 服务控制台

访问 <http://127.0.0.1:3789>：

- **总览**：AstrBot / 各 NapCat QQ / Hub 的运行状态与端口可达性，每 8 秒刷新。
- **启停**：每张服务卡一键启动（隐藏窗口，无黑框）或停止（带确认）。
- **链路**：底部面板展示 OneBot WS、QQ 登录、Codex CLI、远程执行四条健康检查。
- **主题**：右上角切换浅色 / 深色，选择会记住。

服务定义在 `data/services.json`（不存在时使用 `src/services.js` 里的内置默认值），
参考 `data/services.example.json`。API：

```text
GET  /api/services
POST /api/services/start   { "service": "astrbot" | "napcat-<qq>" }
POST /api/services/stop    { "service": "astrbot" | "napcat-<qq>" }
```

## 手机 / 局域网访问

Hub 默认只监听 `127.0.0.1`。要在同一局域网内的手机上打开控制台和各个 WebUI：

1. 让 Hub 监听所有网卡并设置访问密码（建议同时设置）：

   ```powershell
   $env:CODEX_REMOTE_CONTACT_HOST = "0.0.0.0"
   $env:CODEX_REMOTE_CONTACT_ACCESS_TOKEN = "你的访问密码"
   npm start
   ```

   启动脚本 `start-dashboard.bat` 已内置这两个变量（默认密码可自行修改）。
   注册表自启动项 `HKCU\...\Run\CodexRemoteHub` 也会带上同样的配置。

2. 放行防火墙（以管理员身份执行一次即可）：

   ```powershell
   New-NetFirewallRule -DisplayName "CRC LAN 3789" -Direction Inbound -Protocol TCP -LocalPort 3789 -Action Allow -Profile Public,Private
   # 6099 / 6100（NapCat WebUI）、6185 / 6199（AstrBot）同理
   ```

3. 查电脑的局域网 IP（和手机连同一个路由器/Wi-Fi）：

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
   ```

4. 手机浏览器打开 `http://<电脑IP>:3789`，输入访问密码进入控制台。
   面板里的 WebUI 链接会自动指向电脑的局域网 IP；NapCat WebUI 还需要它自己的
   token（`<NapCat>/config/webui.json` 里的 `token` 字段），AstrBot 用自己的登录密码。

> 安全提示：手机访问意味着控制台暴露在局域网内。访问密码只保护 Hub 本身；
> NapCat / AstrBot 各自的 WebUI 凭据要单独保管，不要用默认密码。

### 手机 App（PWA，可安装到主屏幕）

手机浏览器打开 `http://<电脑IP>:3789/app/`，输入访问密码后：

- **Android Chrome**：菜单 → 「安装应用」/「添加到主屏幕」，生成带图标的独立 App。
- **iPhone Safari**：分享 → 「添加到主屏幕」。

App 功能：

- 服务总览：AstrBot / 各 NapCat / Hub 的运行状态，每 8 秒刷新；
- 一键启动 / 停止服务，一键打开各服务 WebUI（自动使用当前访问的主机地址）；
- 远程开机：发送 Wake-on-LAN 魔术包（配置在 `data/wake.json`，不入库），
  并显示本机 MAC 方便用其它 WOL 工具；
- 网页控制台入口与 QQ 通道状态。

### 开机自动启动

Hub 支持 `AUTO_START_SERVICES` 环境变量（逗号分隔的服务 id），启动后按顺序
自动拉起尚未运行的服务（默认延迟约 6～8 秒一个）：

```powershell
$env:AUTO_START_SERVICES = "napcat-10001,napcat-10002,astrbot"
npm start
```

`start-dashboard.bat` 与注册表自启动项已配置好当前机器的三个服务。配合
Wake-on-LAN，可以实现「手机远程开机 → 自动登录 → Hub 自动拉起 NapCat + AstrBot
+ QQ 通道」的完整无人值守链路。

## QQ 指令（管理员私聊 / 群内 @）

```text
/状态  /维护  /帮助
/开启QQ  /关闭QQ
/白名单  /加群 群号  /删群 群号
/ban @对方  /unban @对方  /banlist
/模型 模型名  /智能等级 low|medium|high|xhigh
/清理记忆  /防休眠  /恢复休眠  /截图
/打开 软件名  /软件列表 关键词
/远程执行  /确认  /取消  /退出远程执行
/沙箱 read-only|workspace-write|danger-full-access
/skill 列表  /skill none
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | NapCat OneBot 正向 WebSocket 地址 |
| `ONEBOT_API_BASE` | `http://127.0.0.1:3000` | OneBot HTTP API 回退地址 |
| `CODEX_CLI_PATH` | `codex`（PATH） | Codex CLI 可执行文件路径 |
| `CODEX_REMOTE_CONTACT_PORT` | `3789` | Hub HTTP 端口 |
| `CODEX_REMOTE_CONTACT_HOST` | `127.0.0.1` | 监听地址（内网访问请自行配鉴权） |
| `CODEX_REMOTE_CONTACT_ACCESS_TOKEN` | 空 | 非本机访问控制台所需的访问密码（设置后生效） |
| `CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH` | 空 | 写入工作区 AGENTS.md 的风格文件 |
| `CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_SANDBOX` | `read-only` | 远程执行默认沙箱 |
| `CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_IDLE_TTL_MS` | `900000` | 远程执行空闲超时 |
| `AUTO_START_SERVICES` | 空 | 开机自动启动的服务 id（逗号分隔，如 `napcat-10001,astrbot`） |
| `DASHSCOPE_API_KEY` | 空 | 视觉描述（截图分析）用的 DashScope/Qwen key |
| `CODEX_SKY_PATH` | 自动探测 | `@oai/sky` 模块目录（Computer Use） |
| `CODEX_VISION_PY` | 自动探测 | vision.py 路径 |
| `CODEX_SKILL_ROOTS` | `~/.codex/skills;~/.agents/skills` | 分号分隔的 skill 根目录 |

## 安全说明

- Hub 默认只监听 `127.0.0.1`，不暴露到局域网。
- 管理指令（改白名单、ban、清记忆、远程执行、切换沙箱）只认 `ownerUserIds`。
- 群聊/非管理员回复一律走 `read-only` 沙箱，不会自动执行命令。
- 管理员私聊默认 `danger-full-access`，拥有本机完整权限，请妥善保管机器人 QQ。
- `data/settings.json`、`data/services.json`、`data/*-memory.json` 均被
  `.gitignore` 排除；API key 等敏感信息请通过环境变量提供，不要写进代码。

## 项目结构

```text
src/                  Hub 核心（HTTP、OneBot 客户端、QQ 事件、Codex 调用、远程执行）
modules/web-console/  Web 服务控制台（纯静态，无前端构建）
modules/system-control/  防休眠 / 截图 / GUI 控制 PowerShell 模块
modules/napcat/       多账号登录态隔离补丁（qq-entry.mjs + 说明）
data/                 运行时数据（settings.json、记忆、服务配置；敏感文件不入库）
tools/                Computer Use CLI 包装
workspaces/codex-cli/ Codex 回复工作区（运行时生成，不入库）
runtime/              截图、回复输出等运行时产物（不入库）
```

## 与原版（macOS）的差异

| 模块 | 原版 macOS | 本 Windows 版 |
| --- | --- | --- |
| 可信控制台 | iMessage 轮询 + AppleScript | 管理员 QQ 私聊 |
| QQ/OneBot | LLBot 桥接，HTTP 上报 | NapCat 正向 WebSocket（WS 事件 + WS API） |
| Codex CLI | codex exec | 相同，支持 npm 全局 / 桌面版 / 自定义路径 |
| 系统控制 | 背光 C helper | 防休眠 + 截图 + GUI 控制（PowerShell） |
| Web 控制台 | 同源静态页 | 扩展为服务控制台（启停/健康检查/主题） |
| 监听 | 所有网卡 | 默认 127.0.0.1 |
