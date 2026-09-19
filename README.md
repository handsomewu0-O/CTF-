# 天选杯——网安工作室个人挑战赛

面向 50 人规模、8 小时选拔赛的轻量网络安全竞赛平台。平台采用 Node.js、Express 和 SQLite WAL，按单机单进程设计，不需要动态靶机。

## 已实现功能

- 原创公开赛事门户：赛事概览、赛程节点、计分协议、纪律与隐私规则、实时排名
- 登录页二进制数据流、字符翻转、扫描线、区块入场等动效，并支持低动态模式
- 用户名、班级、姓名、邮箱、密码注册与登录
- 用户名不限制字符种类和长度，支持空格、标点及 Emoji；仍校验非空及登录标识唯一性
- 个人资料支持修改用户名、姓名、班级、邮箱及密码；保存前验证当前密码，改名保留成绩，修改密码后撤销旧会话
- 注册资料持久化到 SQLite `users` 表，密码只保存加盐哈希
- 服务端答案判定，答案仅以 HMAC-SHA-256 摘要保存
- 每道题前三位解题者额外加分，默认 `30 / 20 / 10`
- 公开实时榜单只显示用户名，裁判视图显示用户名、姓名、班级和邮箱
- 赛题 JSON、CSV、ZIP 批量导入，导入前预览和全量校验
- 固定支持 `web`、`PWN`、`misc`、`Crypto`、`Reverse`、`数据安全`、`AI安全` 七类赛题
- 题目详情支持独立靶场入口与鉴权附件下载
- 赛题附件鉴权下载、赛题上下架、公告实时推送
- 解题成功向在线选手实时播报“用户名解出了某题”，多人解题依次展示；总览保留最近 12 条记录，错误答案及重复提交不播报
- 比赛筹备、注册、运行、暂停、结束状态控制
- 管理员、裁判、参赛者三类权限
- 最终成绩 CSV 导出、审计日志、持久化会话
- 响应式赛场和裁判台，适配桌面与移动端

## 本地启动

需要 Node.js 22 或更高版本。

```powershell
Copy-Item .env.example .env
npm install
npm start
```

浏览器访问 `http://localhost:3100`。首次启动会根据 `.env` 创建管理员；若没有配置 `ADMIN_PASSWORD`，终端会输出一次随机密码。首次部署默认处于筹备状态且关闭注册，管理员登录后可在“比赛设置”中进入“开放注册”状态。

### 手机局域网预览

未部署云服务器时，可以让手机和电脑连接同一个 Wi-Fi，在电脑上运行：

```powershell
.\scripts\start-lan.ps1
```

查看电脑的局域网 IPv4 地址（例如 `10.167.14.78`），然后在手机浏览器打开 `http://10.167.14.78:3100`。手机端不要使用 `localhost` 或 `127.0.0.1`。如果 Windows 防火墙拦截连接，请用管理员 PowerShell 放行局域网端口：

```powershell
New-NetFirewallRule -DisplayName "Nexus Arena LAN 3100" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100 -RemoteAddress LocalSubnet -Profile Any
```

该脚本只用于局域网预览，会临时使用开发模式和 HTTP Cookie；云服务器部署仍按下方 Nginx + HTTPS 方案运行，不要把此脚本用于公网。

注册入口始终可以打开并查看所需字段。只有比赛状态为“开放注册”且注册开关已开启时，服务器才接受新账号；本地演示数据库可以由管理员在裁判台切换该状态。

修改管理员密码：

```powershell
npm run admin
```

## 题目导入

后台“导入赛题”支持：

- `.json`：直接上传清单。
- `.csv`：适合无附件题目。
- `.zip`：根目录放置 `challenges.json` 或 `challenges.csv`，附件也放在 ZIP 内，由 `files` 字段引用。

JSON 示例：

```json
{
  "version": 1,
  "challenges": [
    {
      "slug": "packet-alpha",
      "title": "Packet Alpha",
      "category": "数据安全",
      "description": "分析流量包并找到约定答案。",
      "baseScore": 300,
      "flag": "flag{a_high_entropy_random_value}",
      "targetUrl": "https://challenge.example.com/packet-alpha",
      "active": true,
      "sortOrder": 10,
      "files": [
        { "path": "attachments/packet-alpha.pcap", "name": "题目流量.pcap" }
      ]
    }
  ]
}
```

上传限制为 200 道题、100 个文件和 50 MB 解压总量。Slug 必须唯一。`targetUrl` 可填写 HTTP/HTTPS 地址或以 `/` 开头的站内路径。当前导入采用只新增模式，防止赛中覆盖已有答案和分值。

## 计分规则

每个用户每道题只计一次分。总分由解题记录中的基础分与首解奖励快照汇总：

```text
第一位解出：题目基础分 + 30
第二位解出：题目基础分 + 20
第三位解出：题目基础分 + 10
其余解出者：题目基础分
```

管理员可以在比赛设置中修改奖励，修改只影响之后产生的解题记录。排名按总分降序、最后得分时间升序、用户名升序排列。

## 云服务器部署

无动态靶机时，50 人建议使用：

- `4 vCPU / 8 GB RAM`
- `100 GB SSD`
- `10–20 Mbps` 公网带宽
- Ubuntu 24.04 LTS
- Docker Compose、Nginx、HTTPS

部署步骤：

1. 安装 Docker Engine、Compose 插件和 Nginx。
2. 将项目上传到 `/opt/nexus-arena`。
3. 复制 `.env.example` 为 `.env`，设置域名、管理员密码与随机 `FLAG_SECRET`。
4. 执行 `docker compose up -d --build`。
5. 按 `deploy/nginx.conf.example` 配置反向代理和证书。
6. 防火墙只放行 `22`、`80`、`443`，应用端口只监听 `127.0.0.1`。

生成服务端密钥可使用：

```bash
openssl rand -base64 48
```

SQLite 方案只运行一个 Node 进程。不要开启 PM2 cluster，也不要让多台服务器共享 SQLite 文件。50 人规模无需横向扩展。

## 备份和比赛操作

- 赛前关闭应用一次，复制 `data` 和 `uploads` 作为完整基线备份。
- 赛中每小时执行 SQLite 在线备份，或使用云盘快照。
- 开赛前关闭注册，确认比赛时间与前三名奖励。
- 用测试账号逐题验证答案、靶场入口和附件，再清空测试数据或使用正式数据库重新部署。
- 比赛结束后切换为“比赛已结束”，导出成绩 CSV，再备份数据库。

SQLite 在线备份示例：

```bash
sqlite3 data/arena.sqlite ".backup 'data/arena-backup.sqlite'"
```

## 安全说明

参赛答案可能被选手转发，平台只能通过提交时间和审计记录辅助发现异常，不能从技术上完全阻止线下分享。平台应与任何故意存在漏洞的 Web/Pwn 服务分开部署。

生产环境必须启用 HTTPS，并设置正确的 `APP_ORIGIN`。数据库、备份、`.env` 和附件目录不能由 Nginx 直接公开。管理员后台建议再增加 VPN 或固定 IP 白名单。

## 验证

```powershell
npm test
npm audit
node --check server.js
node --check public/app.js
```
