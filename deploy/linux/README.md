# 部署到 Linux 云服务器

目标：电脑关着也能发 QQ 提醒。整体和 B 站那些「大肥鱼上云」教程是同一套底层——
云服务器 + Docker 里跑 QQ 协议端（NapCat）+ 我们自己的服务。

## 1. 机器

- Ubuntu 22.04 / 24.04，**x86_64**（ARM 上 QQ 生态不全，别选）
- 2 核 2G 是下限，**4G 更稳**：QQ 是 Electron 应用，光它就要 800M–1.5G
- 系统盘 40G（实际用七八个 G）

阿里云个人试用 300 元，按小时抵扣，2核2G 大概能连续跑 50 天。

## 2. 基础环境

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v            # 要是 v22.x

curl -fsSL https://get.docker.com | sh
docker -v
```

## 3. QQ 协议端（NapCat）

```bash
docker run -d --name napcat --restart=always \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest
```

- 打开 `http://服务器IP:6099` 扫码登录**小号**（别用主号）
- 二维码每两分钟换一张，页面上刷新即可；手机 QQ 扫完确认
- 在 NapCat 的「网络配置」里开两样：
  - **HTTP 服务器** 端口 3000（我们调它发消息）
  - **WebSocket 服务器** 端口 3001（我们订阅事件）

> 为什么两个都要开：3000 是「嘴」，3001 是「耳朵」。
> 社区里有人的 HTTP 上报在 Linux 上「显示已启动却收不到事件」，所以事件走 WS 更稳；
> 我们的服务两条通道都支持，同时开也不会重复处理。

## 4. 把项目传上去（一条命令装完）

本地 PowerShell（在 `待办提醒` 目录里）：

```powershell
scp .\待办提醒-云端包.tar.gz root@服务器IP:/root/
```

服务器上：

```bash
cd /root && tar xzf 待办提醒-云端包.tar.gz && cd todo-reminder
sudo bash deploy/linux/一键部署.sh
```

这个脚本会依次做完：装 Node 22（走国内镜像）→ 装 Docker + 配镜像加速 →
预置 NapCat 的 OneBot 配置（HTTP 3000 / WS 3001）→ 拉镜像并起容器 →
装 systemd 服务并把 `data/` 里的配置和待办带过去 → 打印扫码地址。

> 拉镜像失败（国内常见）：去阿里云控制台「容器镜像服务 → 镜像加速器」复制专属地址，然后
> `MIRROR=https://xxxx.mirror.aliyuncs.com sudo -E bash deploy/linux/一键部署.sh`

## 5. 手动装（脚本跑不通时的退路）

```bash
# 依赖
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
curl -fsSL https://get.docker.com | sh

# NapCat
docker run -d --name napcat --restart=always \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest

# 服务
cd /opt/todo-reminder && sudo bash deploy/linux/install.sh
```

然后在 `http://服务器IP:6099` 里手动加两条网络配置：
**HTTP 服务器 3000**、**WebSocket 服务器 3001**（消息格式都选 `array`）。

## 6. 验收（按顺序，前一步不过就别往下走）

1. `systemctl status todo-reminder` 是 active
2. `curl -s 127.0.0.1:3790/api/state | head -c 200` 有正常返回
3. `curl -s 127.0.0.1:3000/get_login_info` 返回小号 QQ 号
4. 主号给小号发一句「查看待办」，能收到回复 —— 收到才算通
5. 日志里出现「WS 已连上 NapCat」
6. 重启服务器，等 3 分钟，再走一遍第 4 步

## 已知的坑

- **同一个 QQ 号不能两处同时在线**：云上登录会把本机踢下线，只能切换不能双活
- **快速登录令牌隔夜失效**：NapCat 支持带账号启动，但重启电脑后通常要重新扫码
- **假在线**：端口通、`get_login_info` 正常，但发消息超时（`NTEvent ... sendMsg timeout`）。
  我们的看门狗是拿 `get_login_info` 探的，遇到这种情况会以为在线——真出现就重启容器
- **风控**：机房 IP 登录比家庭宽带更容易被要求验证，小号被封是这条路公认的成本
- 图片识别不再走系统 OCR（Linux 没有），改成直接给模型看，效果不受影响
