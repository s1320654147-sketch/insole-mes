# 部署路线：Web Demo + Web Alpha

## 当前决策

这个项目沿用 GitHub + Render 的部署方法，但不再只是前端静态页面。

推荐同时保留两条线：

1. `prototype/`：Web Demo，方便分享、讨论、演示界面方向
2. `alpha/`：Web Alpha，开始具备后端 API、登录、数据库和手机端/管理端数据同步

## Web Demo

用途：

- 给同事、工厂现场、供应商或 Demo 访谈时快速看界面
- 不承载真实业务数据
- 不解决多人登录、权限、数据保存问题

部署方式：

- GitHub 仓库
- Render Static Site
- 发布目录：`prototype`

## Web Alpha

用途：

- 作为真正系统的第一版
- 管理端和工人端共用同一个后端
- 手机端提交报工、入库后，电脑端管理看板可以刷新看到

当前 Alpha 包含：

- 登录
- 管理端：工单、物料、报工、预警、操作记录
- 工人端：接任务、工序报工、物料入库
- 后端 API
- 本地文件存储兜底
- Render PostgreSQL 数据库接入预留
- 数据库结构文件：`alpha/db/schema.sql`

部署方式：

- GitHub 仓库
- Render Web Service
- Render PostgreSQL
- 配置文件：`render.yaml`

## 本地运行

进入 Alpha 目录：

```bash
cd alpha
npm install
npm run dev
```

如果本地暂时没有 PostgreSQL，系统会使用 `alpha/data/alpha-store.json` 做开发存储。这个文件已经被 `.gitignore` 忽略，不作为正式数据源。

打开：

- 管理端：http://localhost:3000/admin.html
- 工人端：http://localhost:3000/mobile.html

测试账号：

- 管理端：`admin` / `admin123`
- 工人端：`worker` / `worker123`
- 仓库：`warehouse` / `warehouse123`

Render 部署时会通过 `render.yaml` 创建 PostgreSQL，并把 `DATABASE_URL` 注入 Alpha 服务。服务启动后会自动建表和写入初始演示数据。

## 下一步

1. 接入真实二维码生成和扫码识别
2. 把密码改成加密存储
3. 增加角色权限：管理、仓库、工人
4. 增加新建工单、领料、出库、退料、补料
5. 黑湖 Demo 后校准字段、状态和扫码交互
