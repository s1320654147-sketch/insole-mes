# 轻 MES 原型

这是一个面向打样和小批量生产场景的轻量 MES 原型壳子。

> 新电脑或新 Codex 接手时，请先阅读
> [`docs/PROJECT_HANDOFF_2026-07-02.md`](docs/PROJECT_HANDOFF_2026-07-02.md)。
> 其中包含业务背景、产品决策、部署信息、账号、扫码逻辑、测试流程、已知限制和后续优先级。

当前版本目标：

- 快速搭出可讨论的产品骨架
- 借鉴扫码报工、工单下派、进度看板、库存预警的思路
- 不引入 ERP、财务、销售等重模块

当前包含：

- `docs/v1-scope.md`：V1 范围与建模建议
- `docs/product-direction.md`：产品方向与上线方式说明
- `docs/deployment-roadmap.md`：Web Demo 与 Web Alpha 的部署路线
- `prototype/index.html`：管理端原型，适合电脑查看生产进度、库存和预警
- `prototype/mobile.html`：工人手机端原型，适合手机接任务、看工单、报工和扫码入库
- `prototype/styles.css`：原型样式
- `prototype/app.js`：原型数据与交互
- `alpha/`：Web Alpha 版本，包含后端 API、登录、管理端、手机端和数据库接入预留
- `render.yaml`：Render 部署配置，包含静态 Demo、Web Alpha 和 PostgreSQL

打开方式：

管理端直接在浏览器中打开 `prototype/index.html`。

手机端直接在手机浏览器或桌面浏览器移动设备模式中打开 `prototype/mobile.html`。

Alpha 本地运行：

```bash
cd alpha
npm install
npm run dev
```

自动化自检：

```bash
cd alpha
npm test
```

Alpha 地址：

- 管理端：http://localhost:3000/admin.html
- 工人端：http://localhost:3000/mobile.html

当前 Alpha 已覆盖生产工单筛选、工艺路线进度、二维码/标签、手机扫码报工、
完成/良品/不良记录、工序自动推进和交期风险视图。完整业务背景、历次沟通、
测试账号、部署信息和接手规则统一维护在
[`docs/PROJECT_HANDOFF_2026-07-02.md`](docs/PROJECT_HANDOFF_2026-07-02.md)。
