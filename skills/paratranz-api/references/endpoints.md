# ParaTranz API 全量接口参考（自动生成）

- 数据来源：`references/api-docs.yml`（OpenAPI 3.0.3）
- 生成时间：2026-02-07T18:20:23.503Z
- 接口总数：48
- 基础地址：`https://paratranz.cn/api`

## 使用前置

1. 在请求头添加 `Authorization: Bearer <TOKEN>`。
2. 路径参数必须完整替换，例如 `{projectId}`。
3. JSON 接口用 `--json`，上传接口用 `--form`。
4. 先 `list` 再 `call`，可避免误用接口。

## 接口目录

- Artifacts（3）
- Files（8）
- History（3）
- Issues（6）
- Mails（3）
- Members（4）
- Projects（5）
- Scores（1）
- Strings（6）
- Terms（6）
- Users（3）

## Artifacts

### getArtifact - 导出结果

- 方法与路径：`GET /projects/{projectId}/artifacts`
- 说明：获取最近一次导出的结果
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getArtifact \
  --path "projectId=<projectId>"
```

### generateArtifact - 触发导出

- 方法与路径：`POST /projects/{projectId}/artifacts`
- 说明：手动触发导出操作，仅管理员可使用
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200, 403`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call generateArtifact \
  --path "projectId=<projectId>"
```

### downloadArtifact - 下载

- 方法与路径：`GET /projects/{projectId}/artifacts/download`
- 说明：下载导出的压缩包
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`302`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call downloadArtifact \
  --path "projectId=<projectId>"
```

## Files

### getFiles - 文件列表

- 方法与路径：`GET /projects/{projectId}/files`
- 说明：获取项目文件列表
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getFiles \
  --path "projectId=<projectId>"
```

### createFile - 上传文件

- 方法与路径：`POST /projects/{projectId}/files`
- 说明：上传并创建文件，文件名不能与 path 指定的目录中的文件冲突
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `multipart/form-data`（必填）；常见字段：file, path
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createFile \
  --path "projectId=<projectId>" \
  --form "file=@./<local-file>,path=<path>"
```

### deleteFile - 删除文件

- 方法与路径：`DELETE /projects/{projectId}/files/{fileId}`
- 说明：通过ID删除文件
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteFile \
  --path "projectId=<projectId>,fileId=<fileId>"
```

### getFile - 文件信息

- 方法与路径：`GET /projects/{projectId}/files/{fileId}`
- 说明：通过ID获取文件信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getFile \
  --path "projectId=<projectId>,fileId=<fileId>"
```

### updateFile - 更新文件

- 方法与路径：`POST /projects/{projectId}/files/{fileId}`
- 说明：通过ID上传并更新文件。 注意此接口仅更新原文，不对译文做改动， 更新译文请用下方的**更新文件接口** `POST /projects/{projectId}/files/{fileId}/translation`
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 请求体：
  - `multipart/form-data`（必填）；常见字段：file
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call updateFile \
  --path "projectId=<projectId>,fileId=<fileId>" \
  --form "file=@./<local-file>"
```

### saveFile - 修改文件

- 方法与路径：`PUT /projects/{projectId}/files/{fileId}`
- 说明：通过ID修改文件信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 请求体：
  - `application/json`（必填）；常见字段：name, extra
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveFile \
  --path "projectId=<projectId>,fileId=<fileId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### getFileTranslation - 文件翻译

- 方法与路径：`GET /projects/{projectId}/files/{fileId}/translation`
- 说明：通过ID获取文件翻译数据
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getFileTranslation \
  --path "projectId=<projectId>,fileId=<fileId>"
```

### updateFileTranslation - 更新文件翻译

- 方法与路径：`POST /projects/{projectId}/files/{fileId}/translation`
- 说明：通过ID上传并更新文件中的词条翻译。 注意此接口仅更新译文，不对原文做改动
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `fileId`（integer，必填）：文件ID
- 请求体：
  - `multipart/form-data`（必填）；常见字段：file, force
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call updateFileTranslation \
  --path "projectId=<projectId>,fileId=<fileId>" \
  --form "file=@./<local-file>,force=<force>"
```

## History

### getFileRevisions - 文件历史

- 方法与路径：`GET /projects/{projectId}/files/revisions`
- 说明：查看项目所有文件上传、更新及删除历史
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `file`（number，可选）：指定文件获取历史
  - `type`（string，可选）：指定类型获取历史，同revision中的type定义；可选值：create | update | import
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getFileRevisions \
  --path "projectId=<projectId>" \
  --query "file=<file>,type=<type>,page=<page>,pageSize=<pageSize>"
```

### getHistory - 获取历史记录

- 方法与路径：`GET /projects/{projectId}/history`
- 说明：获取项目历史记录，可以使用 `uid` 或 `tid` 筛选用户或词条
- 路径参数：
  - `project`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
  - `uid`（integer，可选）：用户ID
  - `tid`（integer，可选）：词条ID，当 type 为 text 时指定，用于获取某一词条的全部历史记录，**指定后分页失效**
  - `type`（enum，可选）：历史记录类型 - **text** 词条历史（默认） - **term** 术语修改历史 - **import** 导入历史 - **comment** 评论记录，可以同 uid 一起使用；可选值：text | term | import | comment
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getHistory \
  --path "project=<project>" \
  --query "page=<page>,pageSize=<pageSize>,uid=<uid>,tid=<tid>,type=<type>"
```

### getTermHistory - 术语历史

- 方法与路径：`GET /projects/{projectId}/terms/{termId}/history`
- 说明：通过ID获取项目术语修改历史记录
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `termId`（integer，必填）：术语ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getTermHistory \
  --path "projectId=<projectId>,termId=<termId>"
```

## Issues

### getIssues - 讨论列表

- 方法与路径：`GET /projects/{projectId}/issues`
- 说明：获取讨论列表
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `status`（enum，可选）：按状态筛选讨论（0 - 讨论中，1 - 已关闭）；可选值：0 | 1
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getIssues \
  --path "projectId=<projectId>" \
  --query "status=<status>"
```

### createIssue - 发起讨论

- 方法与路径：`POST /projects/{projectId}/issues`
- 说明：创建一条新的讨论，权限可通过设置页面调整
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）
- 常见响应码：`200, 403`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createIssue \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### deleteIssue - 删除讨论

- 方法与路径：`DELETE /projects/{projectId}/issues/{issueId}`
- 说明：通过ID删除讨论及对话
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `issueId`（integer，必填）：讨论ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteIssue \
  --path "projectId=<projectId>,issueId=<issueId>"
```

### getIssue - 讨论信息

- 方法与路径：`GET /projects/{projectId}/issues/{issueId}`
- 说明：通过ID获取讨论信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `issueId`（integer，必填）：讨论ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getIssue \
  --path "projectId=<projectId>,issueId=<issueId>"
```

### operateIssue - 操作讨论

- 方法与路径：`POST /projects/{projectId}/issues/{issueId}`
- 说明：回复/订阅/取消订阅某个讨论
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `issueId`（integer，必填）：讨论ID
- 请求体：
  - `application/json`（必填）；常见字段：op, content
- 常见响应码：`200, 201`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call operateIssue \
  --path "projectId=<projectId>,issueId=<issueId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### saveIssue - 修改讨论

- 方法与路径：`PUT /projects/{projectId}/issues/{issueId}`
- 说明：修改讨论内容
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `issueId`（integer，必填）：讨论ID
- 请求体：
  - `application/json`（可选）；Schema 引用：#/components/schemas/Issue
- 常见响应码：`200, 403`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveIssue \
  --path "projectId=<projectId>,issueId=<issueId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

## Mails

### getMails - 私信列表

- 方法与路径：`GET /mails`
- 说明：获取私信列表
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getMails \
  --query "page=<page>,pageSize=<pageSize>"
```

### createMail - 发送私信

- 方法与路径：`POST /mails`
- 说明：向其他用户发送私信
- 请求体：
  - `application/json`（必填）
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createMail \
  --json '{"TODO":"按文档填写请求体"}'
```

### getConversation - 用户对话

- 方法与路径：`GET /mails/conversations/{userId}`
- 说明：通过用户ID获取与某用户的对话
- 路径参数：
  - `userId`（integer，必填）：用户ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getConversation \
  --path "userId=<userId>"
```

## Members

### getMembers - 成员列表

- 方法与路径：`GET /projects/{projectId}/members`
- 说明：获取项目成员列表
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getMembers \
  --path "projectId=<projectId>"
```

### createMember - 创建成员

- 方法与路径：`POST /projects/{projectId}/members`
- 说明：加入新成员。需管理员以上权限
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/Member
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createMember \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### deleteMember - 删除成员

- 方法与路径：`DELETE /projects/{projectId}/members/{memberId}`
- 说明：将成员移除出项目
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteMember \
  --path "projectId=<projectId>"
```

### editMember - 修改成员

- 方法与路径：`PUT /projects/{projectId}/members/{memberId}`
- 说明：修改成员信息。需管理员以上权限
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）；常见字段：permission, note
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call editMember \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

## Projects

### getProjects - 项目列表

- 方法与路径：`GET /projects`
- 说明：获取项目列表
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProjects \
  --query "page=<page>,pageSize=<pageSize>"
```

### createProject - 创建项目

- 方法与路径：`POST /projects`
- 说明：创建项目
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/Project
- 常见响应码：`201, 400, 403`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createProject \
  --json '{"TODO":"按文档填写请求体"}'
```

### deleteProject - 删除项目

- 方法与路径：`DELETE /projects/{projectId}`
- 说明：通过ID删除项目
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteProject \
  --path "projectId=<projectId>"
```

### getProject - 项目信息

- 方法与路径：`GET /projects/{projectId}`
- 说明：通过ID获取项目信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProject \
  --path "projectId=<projectId>"
```

### saveProject - 更新项目

- 方法与路径：`PUT /projects/{projectId}`
- 说明：通过ID更新项目信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/Project
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveProject \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

## Scores

### getScores - 成员贡献

- 方法与路径：`GET /projects/{projectId}/scores`
- 说明：查看项目所有的贡献
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
  - `uid`（number，可选）：指定用户ID
  - `operation`（string，可选）：指定类型获取贡献；可选值：translate | edit | review
  - `start`（string，可选）：筛选开始时间
  - `end`（string，可选）：筛选结束时间
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getScores \
  --path "projectId=<projectId>" \
  --query "page=<page>,pageSize=<pageSize>,uid=<uid>,operation=<operation>,start=<start>,end=<end>"
```

## Strings

### getStrings - 词条列表

- 方法与路径：`GET /projects/{projectId}/strings`
- 说明：获取项目词条
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
  - `file`（fileId，可选）：词条所在文件ID
  - `stage`（Stage，可选）：筛选词条状态
  - `detailed`（boolean，可选）：是否返回词条相关的内容（历史记录、注释等），默认不返回；可选值：1 | 
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getStrings \
  --path "projectId=<projectId>" \
  --query "page=<page>,pageSize=<pageSize>,file=<file>,stage=<stage>,detailed=<detailed>"
```

### createString - 创建词条

- 方法与路径：`POST /projects/{projectId}/strings`
- 说明：创建词条
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createString \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### batchOperateStrings - 批量修改/删除词条

- 方法与路径：`PUT /projects/{projectId}/strings`
- 说明：批量修改或删除词条
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 请求体：
  - `application/json`（必填）；常见字段：op, id, stage, translation
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call batchOperateStrings \
  --path "projectId=<projectId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### deleteString - 删除词条

- 方法与路径：`DELETE /projects/{projectId}/strings/{stringId}`
- 说明：通过ID删除词条，仅管理员可用
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `stringId`（integer，必填）：词条ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteString \
  --path "projectId=<projectId>,stringId=<stringId>"
```

### getString - 获取词条

- 方法与路径：`GET /projects/{projectId}/strings/{stringId}`
- 说明：通过ID获取词条信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `stringId`（integer，必填）：词条ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getString \
  --path "projectId=<projectId>,stringId=<stringId>"
```

### saveString - 更新词条

- 方法与路径：`PUT /projects/{projectId}/strings/{stringId}`
- 说明：通过ID更新词条信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `stringId`（integer，必填）：词条ID
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/StringItem
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveString \
  --path "projectId=<projectId>,stringId=<stringId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

## Terms

### getTerms - 术语列表

- 方法与路径：`GET /projects/{projectId}/terms`
- 说明：获取项目术语列表
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getTerms \
  --path "projectId=<projectId>" \
  --query "page=<page>,pageSize=<pageSize>"
```

### createTerm - 创建术语

- 方法与路径：`POST /projects/{projectId}/terms`
- 说明：创建新术语，如果已存在相同术语会失败
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/Term
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call createTerm \
  --path "projectId=<projectId>" \
  --query "page=<page>,pageSize=<pageSize>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### importTerms - 批量导入术语

- 方法与路径：`PUT /projects/{projectId}/terms`
- 说明：上传JSON文件批量导入术语
- 路径参数：
  - `projectId`（integer，必填）：项目ID
- 查询参数：
  - `page`（integer，可选）：页码
  - `pageSize`（integer，可选）：每页数量
- 请求体：
  - `multipart/form-data`（必填）；常见字段：file
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call importTerms \
  --path "projectId=<projectId>" \
  --query "page=<page>,pageSize=<pageSize>" \
  --form "file=@./<local-file>"
```

### deleteTerm - 删除术语

- 方法与路径：`DELETE /projects/{projectId}/terms/{termId}`
- 说明：通过ID删除术语，仅创建者及管理员可以删除
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `termId`（integer，必填）：术语ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call deleteTerm \
  --path "projectId=<projectId>,termId=<termId>"
```

### getTerm - 术语信息

- 方法与路径：`GET /projects/{projectId}/terms/{termId}`
- 说明：通过ID获取项目术语信息
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `termId`（integer，必填）：术语ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getTerm \
  --path "projectId=<projectId>,termId=<termId>"
```

### saveTerm - 修改术语

- 方法与路径：`PUT /projects/{projectId}/terms/{termId}`
- 说明：修改术语
- 路径参数：
  - `projectId`（integer，必填）：项目ID
  - `termId`（integer，必填）：术语ID
- 请求体：
  - `application/json`（必填）；Schema 引用：#/components/schemas/Term
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveTerm \
  --path "projectId=<projectId>,termId=<termId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

## Users

### getUser - 获取用户信息

- 方法与路径：`GET /users/{userId}`
- 路径参数：
  - `userId`（integer，必填）：用户ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getUser \
  --path "userId=<userId>"
```

### saveUser - 更新用户

- 方法与路径：`PUT /users/{userId}`
- 说明：更改用户信息（仅支持修改自己的信息）
- 路径参数：
  - `userId`（integer，必填）：用户ID
- 请求体：
  - `application/json`（必填）；常见字段：nickname, bio, avatar
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call saveUser \
  --path "userId=<userId>" \
  --json '{"TODO":"按文档填写请求体"}'
```

### getUserActivities - 获取用户近期与词条相关的历史记录

- 方法与路径：`GET /usres/{userId}/activities`
- 路径参数：
  - `userId`（integer，必填）：用户ID
- 常见响应码：`200`
- 最小调用示例：
```bash
node skills/paratranz-api/scripts/paratranz-api-client.mjs call getUserActivities \
  --path "userId=<userId>"
```
