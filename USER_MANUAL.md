# SysMon 用户手册

版本 1.0.0 · 适用平台：Linux（已在 Arch Linux ARM / aarch64 实机验证）

SysMon 是一个单机运行的轻量级系统监控面板：后台按固定间隔采集系统指标写入
SQLite，通过 WebSocket 实时推送到浏览器；提供实时仪表盘、历史趋势、阈值告警，
以及进程、TCP 连接、systemd 服务的在线操作能力。

---

## 目录

1. [快速上手](#1-快速上手)
2. [界面说明](#2-界面说明)
3. [操作指南](#3-操作指南)
4. [告警规则](#4-告警规则)
5. [历史趋势](#5-历史趋势)
6. [HTTP API](#6-http-api)
7. [配置项](#7-配置项)
8. [数据与存储](#8-数据与存储)
9. [性能与资源占用](#9-性能与资源占用)
10. [安全须知](#10-安全须知)
11. [故障排查](#11-故障排查)
12. [架构说明](#12-架构说明)
13. [升级与卸载](#13-升级与卸载)

---

## 1. 快速上手

### 1.1 一键启动

~~~bash
cd sysmon
./run.sh
~~~

首次运行会自动创建 .venv 虚拟环境并安装依赖，随后监听 0.0.0.0:8000。

### 1.2 安装为系统服务（推荐）

仓库内已包含可用的 systemd 单元 /etc/systemd/system/sysmon.service：

~~~bash
systemctl enable --now sysmon     # 开机自启并立即启动
systemctl status sysmon           # 查看状态
systemctl restart sysmon          # 重启
journalctl -u sysmon -f           # 跟踪日志
~~~

### 1.3 手动运行（调试用）

~~~bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
~~~

### 1.4 访问地址

| 页面 | 地址 |
| --- | --- |
| 实时仪表盘 | http://<主机IP>:8000/ |
| 历史趋势与告警配置 | http://<主机IP>:8000/history |
| 交互式 API 文档 | http://<主机IP>:8000/docs |

---

## 2. 界面说明

### 2.1 实时仪表盘

顶部导航显示实时连接状态、主机名与页面入口。主体分左右两栏。

**左侧主区**

| 卡片 | 内容 |
| --- | --- |
| CPU | 总占用率、每核心柱状条、1/5/15 分钟负载、温度、当前频率、物理/逻辑核心数 |
| 内存 | 使用率、已用/可用、缓存与 Buffer、Swap 用量与比例 |
| GPU | 使用率、显存、温度、功耗；无独显时显示探测到的显卡名并标注无可用遥测 |
| 磁盘 IO | 实时读写速率、IOPS，以及各挂载点的用量条 |
| CPU / 内存 趋势 | 最近 5 分钟滚动折线（浏览器内维护，不查库） |
| 网络吞吐 | 最近 5 分钟上传/下载滚动折线 |
| 网卡 | 每个接口的地址、实时上下行速率、累计流量 |
| 进程 Top 10 | PID、进程名、用户、CPU%、内存，可按 CPU/内存排序，可切换内存单位 |
| TCP 连接 | 连接状态统计角标 + 连接明细（本地/远端/所属进程） |
| systemd 服务 | 全部服务单元的状态（active/sub、开机自启）、过滤框、启停操作 |

**右侧侧栏**

| 卡片 | 内容 |
| --- | --- |
| 系统 | 主机名、CPU 型号、发行版、内核、架构、运行时间、进程/用户数、采样时间 |
| 告警 | 当前激活的告警列表，未触发时显示暂无告警 |

### 2.2 刷新节奏

| 数据 | 方式 | 间隔 |
| --- | --- | --- |
| 仪表盘指标与图表 | WebSocket /ws/live 推送（失败自动降级 SSE） | 2 秒 |
| 进程 Top 10 | 轮询 /api/processes | 5 秒 |
| TCP 连接 | 轮询 /api/connections | 5 秒 |
| systemd 服务 | 轮询 /api/services | 15 秒 |

标签页切到后台时，三个轮询面板会自动暂停，切回后恢复。

---

## 3. 操作指南

### 3.1 进程操作

在「进程 Top 10」卡片中：

- **排序**：下拉选择「按 CPU」或「按内存」，列表立即重排。
- **内存单位**：下拉切换「内存 %」或「内存 MB」。选择会记在浏览器本地（localStorage），下次打开保持。
- **结束**：发送 SIGTERM，请求进程正常退出，适用于大多数场景。
- **强杀**：发送 SIGKILL，进程无法忽略，仅用于已卡死的进程。

每次操作都有二次确认，结果以右下角提示条反馈。

**内置保护**：拒绝向 PID 1 发信号、拒绝结束监控服务自身、不存在的 PID 返回错误。

### 3.2 TCP 连接操作

「TCP 连接」卡片上方是状态统计（ESTABLISHED / LISTEN / TIME_WAIT / CLOSE_WAIT 等），
下方是明细表，每行显示状态、本地地址、远端地址与所属进程。点击「关闭」按钮：

1. 弹出确认框，确认后请求 **destroy** 模式：由内核销毁该 socket；
2. 若内核不支持（见下），面板会提示占用该连接的进程，并询问是否 **结束该进程**；
3. 确认后以 SIGTERM 结束占用进程，连接随之中断。

> **重要**：直接销毁连接依赖内核编译选项 CONFIG_INET_DIAG_DESTROY（即 ss -K）。
> 本机内核为 # CONFIG_INET_DIAG_DESTROY is not set，因此 destroy 会返回
> destroy_supported=false，面板自动改用「结束所属进程」。界面状态行会明确标注这一点，
> 不会假装成功。

LISTEN 状态的监听套接字不允许从面板关闭，请使用「systemd 服务」卡片停止对应服务。

### 3.3 systemd 服务操作

「systemd 服务」卡片列出主机上的全部服务单元：

- **过滤框**：按单元名或描述实时过滤（输入有 350 毫秒防抖）。
- **启动 / 重启 / 停止**：对应 systemctl start / restart / stop，操作后自动刷新。

**内置保护**：单元名必须匹配 ^[A-Za-z0-9@._:-]+\.service$（防止命令注入）；
拒绝停止 sysmon.service 本身。

---

## 4. 告警规则

在「历史趋势」页底部管理规则。每条规则包含：

| 字段 | 说明 |
| --- | --- |
| 指标 | 被监控的指标名，见下表 |
| 运算符 | >、>=、<、<=、==、!= |
| 阈值 | 数值 |
| 持续(秒) | 需连续满足该时长才判定触发，0 表示下一采样即触发 |
| 启用 | 关闭后规则保留但不评估 |
| 说明 | 备注文本 |

规则保存在 SQLite 中，每次采样评估，持续时间用内存中的计时状态跟踪。

### 4.1 默认规则

| 指标 | 条件 | 持续 |
| --- | --- | --- |
| cpu.total | > 90 | 5 秒 |
| mem.percent | > 90 | 5 秒 |
| swap.percent | > 50 | 10 秒 |
| cpu.temp | > 85 | 10 秒 |
| gpu.temp | > 85 | 10 秒 |
| disk.max_percent | > 90 | 30 秒 |

### 4.2 可用于告警的指标

cpu.total, cpu.temp, fan.rpm, load.1, load.5, load.15,
mem.total, mem.used, mem.percent, swap.used, swap.percent,
gpu.util, gpu.temp, gpu.power,
disk.max_percent（最满分区使用率）,
net.up_bps, net.down_bps, net.conns,
sys.proc_count, sys.user_count

### 4.3 外部通知

设置环境变量 SYSMON_WEBHOOK_URL 后，规则首次触发（由正常转为告警）时会向该地址
POST 一段 JSON：

~~~json
{
  "event": "alert",
  "time": 1791273000.12,
  "source": "sysmon",
  "rule": {"id": 1, "metric": "cpu.total", "op": ">", "threshold": 90.0, "duration_s": 5, "note": ""},
  "value": 93.4
}
~~~

Webhook 在独立线程中发送，超时 5 秒，失败只写日志，不影响采集。

---

## 5. 历史趋势

访问 /history：

1. 选择时间范围：15 分 / 1 小时 / 6 小时 / 24 小时 / 7 天，或手动填写开始与结束时间；
2. 在指标列表中选择（最多 3 个）指标；
3. 点击「查询」，图表以时间为横轴绘制多条曲线。

历史查询会自动降采样：原始点数超过 SYSMON_MAX_POINTS（默认 1200）时，按时间桶
取平均值，保证响应体积可控。页面会显示实际参与统计的原始样本条数。

---

## 6. HTTP API

所有接口返回 JSON，除非另有说明。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查：状态、版本、是否已开始采样 |
| GET | /api/current | 最新完整快照（含每核心、每分区、每网卡、传感器、激活告警） |
| GET | /api/meta | 版本、采样间隔、保留天数、指标清单、系统信息 |
| GET | /api/history | 历史序列，参数 metric、start、end、limit |
| GET | /api/alerts | 当前激活告警与全部规则 |
| POST | /api/alerts | 新增规则 |
| PATCH | /api/alerts/{id} | 更新规则（含 enabled 开关） |
| DELETE | /api/alerts/{id} | 删除规则 |
| GET | /api/processes | 进程 Top N，参数 limit、sort=cpu|mem |
| POST | /api/processes/{pid}/signal | 结束进程，参数 signal=TERM|KILL|INT|HUP |
| GET | /api/connections | TCP 连接统计与列表，参数 limit |
| POST | /api/connections/close | 关闭连接，参数 local_ip/local_port/remote_ip/remote_port/mode |
| GET | /api/services | 服务列表，参数 query、limit |
| POST | /api/services/{unit}/action | 服务操作，参数 action=start|stop|restart|reload|enable|disable |
| GET | /api/stream | SSE 实时流（WebSocket 的兜底） |
| WS | /ws/live | WebSocket 实时流 |

start、end 支持 epoch 毫秒或 ISO-8601 字符串。

### 6.1 示例

~~~bash
# 最近一小时 CPU 曲线，最多 500 个点
curl 'http://127.0.0.1:8000/api/history?metric=cpu.total&start=1791269400000&limit=500'

# 占用内存最高的 5 个进程
curl 'http://127.0.0.1:8000/api/processes?limit=5&sort=mem'

# 结束 PID 4321
curl -X POST http://127.0.0.1:8000/api/processes/4321/signal \
     -H 'Content-Type: application/json' -d '{"signal":"TERM"}'

# 关闭一条已建立的连接
curl -X POST http://127.0.0.1:8000/api/connections/close \
     -H 'Content-Type: application/json' \
     -d '{"local_ip":"10.0.0.5","local_port":41234,"remote_ip":"10.0.0.9","remote_port":22,"status":"ESTABLISHED"}'

# 重启 nginx
curl -X POST http://127.0.0.1:8000/api/services/nginx.service/action \
     -H 'Content-Type: application/json' -d '{"action":"restart"}'
~~~

---

## 7. 配置项

全部通过环境变量配置。systemd 部署时编辑 /etc/systemd/system/sysmon.service 的
Environment= 行，然后 systemctl daemon-reload && systemctl restart sysmon。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| SYSMON_HOST | 0.0.0.0 | 监听地址 |
| SYSMON_PORT | 8000 | 监听端口 |
| SYSMON_INTERVAL | 2.0 | 采样间隔（秒） |
| SYSMON_RETENTION_DAYS | 7 | 历史数据保留天数 |
| SYSMON_CLEANUP_INTERVAL | 3600 | 清理任务间隔（秒） |
| SYSMON_DB | ./data/sysmon.db | SQLite 文件路径 |
| SYSMON_MAX_POINTS | 1200 | 单次历史查询最大点数 |
| SYSMON_GPU_MODE | auto | auto / nvidia / amd / off |
| SYSMON_GPU_IDLE_REFRESH | 300 | 探测不到 GPU 后，多久重新探测一次（秒） |
| SYSMON_CONNECTION_REFRESH | 15 | 采样器重新统计 socket 数量的间隔（秒） |
| SYSMON_PANEL_CACHE_TTL | 3.0 | 进程/连接面板的服务端缓存时长（秒） |
| SYSMON_SERVICE_CACHE_TTL | 5.0 | 服务列表缓存时长（秒） |
| SYSMON_SERVICE_FILE_CACHE_TTL | 300 | systemctl list-unit-files 结果缓存（秒） |
| SYSMON_WEBHOOK_URL | 空 | 告警触发时 POST 的地址 |

---

## 8. 数据与存储

- 数据库：SQLite（WAL 模式），默认位于 sysmon/data/sysmon.db。
- 表结构：
  - samples：每个采样一行宽表，ts 为主键（epoch 毫秒），30 个指标列；
  - alert_rules：告警规则；
  - meta：预留的键值表。
- 写入量：默认 2 秒一次，约 43200 行/天；7 天保留约 30 万行、几十 MB。
- 清理：后台每小时删除超过保留天数的样本（含 WAL 检查点）。
- 备份：直接复制 .db 文件即可；建议先 systemctl stop sysmon 或使用
  sqlite3 data/sysmon.db ".backup backup.db" 做在线备份。

---

## 9. 性能与资源占用

### 9.1 实测数据（本机：8 核 aarch64 虚拟机，179 个进程）

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 空载 CPU（无客户端） | 1.67% 单核 | 约 0.14% 单核 |
| 单次采样耗时 | 约 28 ms | 2.8 ms（min 2.3 / max 3.2） |
| 常驻内存 RSS | 63 MB | 62 MB |
| 线程数 | 8 | 8 |

面板接口在缓存命中的情况下：进程 5.2 ms、连接 3.2 ms、服务 3.9 ms 每次请求
（未缓存时仅 systemctl list-unit-files 一项就要 351 ms）。

### 9.2 已实施的优化

1. **GPU 探测负缓存**：探测不到可用 GPU 遥测时缓存结果（默认 300 秒），
   避免每个采样周期都 fork 一次 lspci（实测 20.5 ms/次）。
2. **socket 计数独立节流**：psutil.net_connections 是采样循环里最贵的调用之一
   （4.4 ms/次），改为默认每 15 秒统计一次并复用。
3. **面板服务端 TTL 缓存**：进程/连接 3 秒、服务 5 秒，多个浏览器标签共享同一次探测。
4. **systemctl 结果分级缓存**：list-unit-files（351 ms）缓存 300 秒，
   list-units（12.3 ms）缓存 5 秒；服务操作后只失效相关缓存。
5. **进程枚举重构**：改为单次 oneshot 批量读取字段并逐字段容错，
   避免一次 AccessDenied 丢掉整条进程记录。
6. **SQLite 调优**：WAL + synchronous=NORMAL、2 MB 页缓存、内存临时表、128 MB mmap。
7. **前端按需轮询**：标签页不可见时暂停三个面板的轮询；实时数据走 WebSocket
   且服务端每条快照只序列化一次。

### 9.3 进一步调优建议

- 想更省资源：把 SYSMON_INTERVAL 调大（如 5），或把 SYSMON_RETENTION_DAYS 调小。
- 不需要 GPU：设置 SYSMON_GPU_MODE=off，可完全跳过 GPU 探测。
- 完全不需要常驻：只在需要时用 ./run.sh 手动启动。
- 采样间隔越大，历史曲线的分辨率越低，但写入量与 CPU 占用同步下降。

---

## 10. 安全须知

- 面板以 **root** 运行：可以结束任意进程、启停任意服务、读取全部连接。
- 默认监听 0.0.0.0 且 **没有身份认证**。请只在可信内网使用。
- 如需对外提供访问，务必置于反向代理之后并启用认证（Basic Auth、OAuth 或
  mTLS），同时用防火墙限制来源。
- 内置的输入防护（PID 上限、自身保护、单元名白名单）只用于防误操作，
  不能替代访问控制。
- 建议为面板单独创建一个受限用户，但注意：非 root 会无法结束其他用户的进程、
  无法启停大部分服务，功能会受限。

---

## 11. 故障排查

**打不开页面**

1. systemctl is-active sysmon 确认服务在运行；
2. ss -ltnp | grep 8000 确认端口已监听；
3. 从本机 curl http://127.0.0.1:8000/api/health 验证服务本身；
4. 检查防火墙与网络可达性；
5. 端口冲突时改 SYSMON_PORT 后重启服务。

**页面样式或按钮没变化**

浏览器缓存所致，强制刷新（Ctrl+Shift+R / Ctrl+F5）。

**没有温度数据**

温度/风扇来自内核 hwmon 传感器，虚拟机和容器里通常为空。
面板已移除传感器卡片；快照中仍保留 sensors 字段供告警使用。

**GPU 卡片显示无可用遥测**

说明主机没有 nvidia-smi / rocm-smi，且未安装 pynvml，面板回退到 lspci 显示显卡型号。
如需 NVIDIA 遥测可安装 pynvml；不需要可设 SYSMON_GPU_MODE=off。

**关闭连接无效**

内核未启用 CONFIG_INET_DIAG_DESTROY（可用 zcat /proc/config.gz | grep DIAG_DESTROY 确认），
ss -K 会静默失效。面板会自动改用「结束所属进程」，或按提示手动操作。

**进程列表或服务列表报 400**

参数不合法：单元名必须形如 name.service；不存在的 PID 会返回 no such process。

**服务列表刷新很慢**

应当是缓存未命中（默认 5 秒）。若持续缓慢，检查 systemctl 是否本身变慢
（systemd 繁忙时会拖慢 list-units）。

**查看日志**

~~~bash
journalctl -u sysmon -n 100 --no-pager
journalctl -u sysmon -f
~~~

---

## 12. 架构说明

~~~text
┌────────────┐  每 2s   ┌───────────────┐   SQLite    ┌──────────────┐
│ Collector  │ ───────► │ 采样 + 告警   │ ──────────► │  samples 表  │
│ (psutil)   │          │ (AlertEngine) │             │ + 保留策略   │
└────┬───────┘          └──────┬────────┘             └──────┬───────┘
     │ 最新快照                 │ Webhook(可选)                │ 按时间范围查询
     ▼                         ▼                              ▼
┌───────────────────────── Hub (asyncio fan-out) ─────────────────────┐
│  WebSocket /ws/live          SSE /api/stream          REST /api/*   │
└──────────────────────────────────┬───────────────────────────────────┘
                                   ▼
                    ECharts + Bootstrap 5 前端（响应式）
~~~

- **采集**：psutil 调用是阻塞的，放在 asyncio.to_thread 中执行，避免卡住事件循环。
- **速率**：磁盘与网络的字节/IOPS 由相邻两次计数差分得出。
- **推送**：Hub 把序列化后的快照扇出给所有 WebSocket / SSE 订阅者；慢消费者丢旧帧而不积压。
- **持久化**：每次采样写一行宽表记录；后台每小时清理过期数据。
- **面板控制**：进程/连接/服务接口带 TTL 缓存，操作后按需失效。

目录结构：

~~~text
sysmon/
├── app/
│   ├── config.py      # 环境变量配置
│   ├── db.py          # SQLite：样本、规则、查询、降采样、清理
│   ├── collector.py   # psutil 采集循环
│   ├── gpu.py         # GPU 遥测（pynvml / nvidia-smi / rocm-smi / lspci）
│   ├── alerts.py      # 阈值评估与 Webhook
│   ├── system.py      # 进程 / 连接 / systemd 服务
│   └── main.py        # FastAPI：REST + WebSocket + SSE + 静态页面
├── static/            # index.html、history.html、css、js
├── requirements.txt
├── run.sh
├── README.md
├── USER_MANUAL.md
└── data/sysmon.db
~~~

---

## 13. 升级与卸载

**升级**：拉取新代码后 pip install -r requirements.txt && systemctl restart sysmon。
前端资源带 ETag，浏览器会自行重新校验。

**卸载**：

~~~bash
systemctl disable --now sysmon
rm /etc/systemd/system/sysmon.service
systemctl daemon-reload
rm -rf /path/to/sysmon          # 数据在 sysmon/data/sysmon.db，按需保留
~~~

---

## 附：指标名对照

| 指标 | 含义 |
| --- | --- |
| cpu.total | CPU 总占用率（%） |
| cpu.temp | CPU 温度（摄氏度） |
| fan.rpm | 最高风扇转速 |
| load.1 / load.5 / load.15 | 1/5/15 分钟平均负载 |
| mem.total / mem.used / mem.avail / mem.cached | 内存总量/已用/可用/缓存（字节） |
| mem.percent | 内存使用率（%） |
| swap.total / swap.used / swap.percent | Swap 用量与比例 |
| gpu.util / gpu.mem_used / gpu.mem_total / gpu.temp / gpu.power | GPU 使用率、显存、温度、功耗 |
| disk.read_bps / disk.write_bps | 全盘读/写速率（字节/秒） |
| disk.read_iops / disk.write_iops | 全盘读/写 IOPS |
| net.up_bps / net.down_bps | 全部网卡上传/下载速率（字节/秒） |
| net.conns | 连接数 |
| sys.proc_count / sys.user_count | 进程数 / 登录用户数 |
| sys.uptime | 运行时间（秒） |

> 注：SysMon 界面使用 1 KiB = 1024 B；进程面板的「MB」列按 1 MB = 1048576 B 换算。
