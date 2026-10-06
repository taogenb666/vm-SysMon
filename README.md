# SysMon · 轻量级 Linux 系统监控面板

一个单机运行的 Web 监控面板：后台每 2 秒采集一次系统指标，写入 SQLite，
通过 WebSocket（SSE 兜底）推送到前端实时展示；历史数据可按时间范围查询并绘图；
并提供进程、TCP 连接、systemd 服务的在线操作。

> 完整使用说明见 [USER_MANUAL.md](USER_MANUAL.md)。

## 目录结构

    sysmon/
    ├── app/
    │   ├── __init__.py        # 包与版本号
    │   ├── config.py          # 环境变量配置（端口、采样间隔、保留天数等）
    │   ├── db.py              # SQLite：样本表、告警规则表、保留策略、历史查询与降采样
    │   ├── collector.py       # psutil 采集：CPU/内存/磁盘/网络/传感器，后台采样循环
    │   ├── gpu.py             # GPU 采集：pynvml / nvidia-smi / rocm-smi / 集显兜底
    │   ├── alerts.py          # 阈值规则求值与 Webhook 通知
    │   └── main.py            # FastAPI 应用：REST + WebSocket + SSE + 静态页面
    ├── static/
    │   ├── index.html         # 仪表盘首页（卡片 + 图表 + 告警）
    │   ├── history.html       # 历史趋势页 + 告警规则管理
    │   ├── css/style.css      # 深色主题样式
    │   └── js/
    │       ├── common.js      # 通用格式化 / 请求 / 图表默认样式
    │       ├── dashboard.js   # 实时渲染与滚动图表
    │       └── history.js     # 历史查询与规则 CRUD
    ├── requirements.txt
    ├── run.sh                 # 一键启动（自动建 venv 并装依赖）
    ├── tools/rollback.sh      # 版本回退助手
    ├── README.md              # 开发与架构速览
    ├── USER_MANUAL.md         # 完整用户手册（安装、界面、操作、API、排障）
    ├── CHANGELOG.md           # 变更日志
    └── data/sysmon.db         # 运行时自动创建

## 快速开始

    cd sysmon
    ./run.sh                  # 首次会创建 .venv 并安装依赖

然后打开 http://<本机IP>:8000/ 。

手动方式：

    python3 -m venv .venv
    . .venv/bin/activate
    pip install -r requirements.txt
    python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

## 架构说明

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

- 采样线程：psutil 调用是阻塞的，放到 asyncio.to_thread 中执行，避免卡住事件循环。
- 速率计算：磁盘/网络的字节与 IOPS 由相邻两次计数差分得到。
- 推送：Hub 把序列化后的快照扇出给所有 WebSocket / SSE 订阅者；慢消费者丢旧帧而不积压。
- 持久化：每次采样写一行宽表记录；后台每小时清理超过保留天数的数据。
- 降采样：历史查询若点数超过阈值，按时间桶聚合（GROUP BY ts/bucket + AVG），保证响应体积可控。
- 告警：规则存于 SQLite，duration_s 表示需连续满足的秒数，触发时写日志并可 POST 到 Webhook。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| SYSMON_HOST | 0.0.0.0 | 监听地址 |
| SYSMON_PORT | 8000 | 监听端口 |
| SYSMON_INTERVAL | 2.0 | 采样间隔（秒） |
| SYSMON_RETENTION_DAYS | 7 | 历史保留天数 |
| SYSMON_CLEANUP_INTERVAL | 3600 | 清理任务间隔（秒） |
| SYSMON_DB | ./data/sysmon.db | SQLite 路径 |
| SYSMON_MAX_POINTS | 1200 | 单次历史查询最大点数 |
| SYSMON_GPU_MODE | auto | auto / nvidia / amd / off |
| SYSMON_WEBHOOK_URL | 空 | 告警触发时 POST 的地址 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/current | 最新完整快照（含每核心、每分区、每网卡） |
| GET | /api/meta | 版本、采样间隔、指标清单、系统信息 |
| GET | /api/history?metric=&start=&end=&limit= | 历史序列，start/end 支持 epoch 毫秒或 ISO-8601 |
| GET | /api/alerts | 当前激活告警与全部规则 |
| POST | /api/alerts | 新增规则 {metric, op, threshold, duration_s, note} |
| PATCH | /api/alerts/{id} | 更新规则（含 enabled 开关） |
| DELETE | /api/alerts/{id} | 删除规则 |
| GET | /api/processes?limit=&sort=cpu | 进程 Top N（cpu / mem 排序） |
| POST | /api/processes/{pid}/signal | 结束进程 {signal: TERM/KILL/INT/HUP} |
| GET | /api/connections?limit= | TCP 连接状态统计与列表 |
| POST | /api/connections/close | 关闭连接 {local_ip, local_port, remote_ip, remote_port, mode: destroy/kill-owner} |
| GET | /api/services?query=&limit= | systemd 服务列表（含 enabled/active 状态） |
| POST | /api/services/{unit}/action | 启停服务 {action: start/stop/restart/reload/enable/disable} |
| GET | /api/stream | SSE 实时流 |
| WS | /ws/live | WebSocket 实时流 |

## 指标名（历史 / 告警通用）

cpu.total, cpu.temp, fan.rpm, load.1, load.5, load.15,
mem.total, mem.used, mem.avail, mem.cached, mem.percent,
swap.total, swap.used, swap.percent,
gpu.util, gpu.mem_used, gpu.mem_total, gpu.temp, gpu.power,
disk.read_bps, disk.write_bps, disk.read_iops, disk.write_iops,
net.up_bps, net.down_bps, net.conns,
sys.proc_count, sys.user_count, sys.uptime

告警专用虚拟指标：disk.max_percent（最满分区使用率）。

## 备注

- 前端通过 CDN 加载 Bootstrap 5 与 ECharts 5；离线环境可把两个文件下载到 static/vendor/ 并修改 HTML 引用。
- 默认按 2 秒采样、保留 7 天，约 30 万行、数十 MB；如磁盘紧张可调小保留天数或加大采样间隔。
- 无 nvidia-smi / rocm-smi 且未安装 pynvml 时，GPU 卡片会显示集显名称或"无可用遥测"，不影响其他功能。
- 温度/风扇依赖内核 hwmon 传感器；容器或虚拟机中通常为空（面板已移除传感器卡片，数据仍随快照保留供告警使用）。
- 连接的直接销毁依赖内核 CONFIG_INET_DIAG_DESTROY（即 ss -K）；未启用时接口返回 destroy_supported=false，面板会自动改为结束占用该连接的进程。
- 控制类接口以 root 权限执行（结束进程/启停服务），默认监听 0.0.0.0，请勿直接暴露到公网；对外访问请置于反向代理与鉴权之后。
