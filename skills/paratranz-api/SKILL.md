---
name: paratranz-api
description: ParaTranz 平台 API 交互专用技能，覆盖 api-docs.yml 中全部接口（48 个 operationId）与常见调用流程。Use when Codex 需要查询 ParaTranz 项目/文件/词条/术语/成员/讨论/私信/贡献/历史/导出等数据，或需要按 OpenAPI 文档构造、调试、批量执行 API 请求。
---

# ParaTranz API Skill

## 概览

使用这个技能时，始终优先走“文档驱动 + operationId 驱动”流程：

1. 先读取 `references/operation-index.json` 确认目标 `operationId`。  
2. 再读取 `references/endpoints.md` 查看该接口的参数与请求体细节。  
3. 最后通过 `scripts/paratranz-api-client.mjs` 发起请求，避免手写 URL 与方法导致错误。  

该技能已经把 `api-docs.yml` 的接口完整映射到 `operation-index.json`，用于保证“一个不漏”。

## 最小可运行示例

1. 设置 Token（推荐环境变量，避免写进命令历史）：

```powershell
$env:PARATRANZ_TOKEN="<你的ParaTranzToken>"
```

2. 列出全部接口：

```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs list
```

3. 调用项目列表：

```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProjects --query "page=1,pageSize=20"
```

4. 调用带路径参数的接口：

```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProject --path "projectId=123"
```

## 标准工作流

按以下顺序执行，避免漏接口或错接口：

1. 用 `operation-index.json` 搜索关键词（如 `strings`、`terms`、`issues`），锁定目标 `operationId`。  
2. 在 `endpoints.md` 定位该 `operationId`，确认：  
   - 请求方法与路径  
   - path/query 参数  
   - 请求体类型（`application/json` 或 `multipart/form-data`）  
3. 用客户端脚本调用：  
   - 路径参数用 `--path "k=v"`  
   - 查询参数用 `--query "k=v"`  
   - JSON 体用 `--json '{...}'`  
   - 上传文件用 `--form "file=@./a.json,path=dir/"`  
4. 遇到异常时先看 HTTP 状态码，再看响应体中的 `message` / `code` 字段。  

## 参数传递规则

使用脚本时遵循以下映射：

- `--path`: 替换路径中的占位符，例如 `{projectId}`。  
- `--query`: 追加 URL 查询参数。  
- `--header`: 添加额外请求头（会与 `Authorization` 合并）。  
- `--json`: 发送 `application/json`。  
- `--form`: 发送 `multipart/form-data`，值以 `@` 开头表示本地文件。  
- `--raw-body` + `--content-type`: 发送自定义原始请求体。  
- `--dry-run`: 仅打印将要发起的请求，不真正调用。  
- `--output`: 将响应写入文件，适合导出下载场景。  

## 常见任务模板

### 模板 1：项目巡检

1. `getProjects` 拉项目列表。  
2. `getProject` 拉单项目详情。  
3. `getMembers`、`getScores` 查看成员与贡献。  

### 模板 2：词条批处理

1. `getStrings` 筛选待处理词条。  
2. `batchOperateStrings` 做批量更新/删除。  
3. `getHistory` 回溯操作历史。  

### 模板 3：文件翻译更新

1. `getFiles` / `getFile` 确认文件 ID。  
2. `updateFileTranslation` 上传译文。  
3. `getFileTranslation` 回读结果校验。  

## 错误处理与边界策略

按文档约定处理状态码：

- `400`: 参数错误，先检查 `--path/--query/--json/--form`。  
- `401`: Token 无效或过期。  
- `403`: 权限不足（常见于项目管理、导出、删除等接口）。  
- `404`: 资源不存在，优先确认 ID 与路径。  
- `429`: 调用频率过高，加入重试与退避。  
- `5xx`: 服务端异常，记录请求上下文后重试。  

## 资源索引

- `references/api-docs.yml`: 原始 OpenAPI 文档。  
- `references/operation-index.json`: 全量 operation 清单（机器可读）。  
- `references/endpoints.md`: 教学向逐接口用法文档。  
- `scripts/paratranz-api-client.mjs`: 通用 API 调用脚本。  
