#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本脚本用于把外部 CSV 术语表“增量”导入 ParaTranz 项目术语库（Terms）。

设计目标（面向教学与稳妥执行）：
1. 不覆盖已有术语：
   - 先分页拉取远端术语列表；
   - 再在本地做差集；
   - 最后只上传“远端不存在”的术语。
2. 先报告后执行：
   - 默认 dry-run（不导入，只生成报告与差集 JSON）；
   - 传入 --execute 才会真正调用导入接口。
3. 处理脏数据：
   - 支持指定 CSV 编码（本次 5etool.csv 为 gb18030）；
   - 检测 CSV 内部重复与冲突（同一术语多种译法）；
   - 支持冲突策略（skip / first / last）。
4. 便于复盘：
   - 输出 summary、冲突报告、远端术语快照、增量导入 JSON。

注意：
- 本脚本使用 ParaTranz API 的术语接口（GET /terms, PUT /terms）。
- 认证方式使用 Bearer Token（默认读取环境变量 PARATRANZ_TOKEN）。
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib import error, parse, request


DEFAULT_BASE_URL = "https://paratranz.cn/api"
DEFAULT_TOKEN_ENV = "PARATRANZ_TOKEN"
DEFAULT_CSV_ENCODING = "gb18030"
DEFAULT_PAGE_SIZE = 1000
DEFAULT_IMPORT_BATCH_SIZE = 1000
DEFAULT_TIMEOUT_SECONDS = 60


@dataclass
class CsvTermRow:
    """
    表示 CSV 中的一行术语（已经做过基础清洗）。

    字段说明（与 ParaTranz Term schema 对齐）：
    - term: 术语原文
    - translation: 术语译文
    - pos: 词性（本次 CSV 基本都是 noun）
    - note: 注释
    - variants: 术语变体列表（本次 CSV 第 4 列为空时为 []）

    source_line 用来做审计与冲突报告，方便回到原始 CSV 定位问题行。
    """

    source_line: int
    term: str
    translation: str
    pos: str
    note: str
    variants: List[str]

    def to_paratranz_payload(self) -> Dict[str, object]:
        """
        转换为 ParaTranz 批量导入接口接受的 JSON 对象。

        只写必要字段，避免把本地辅助字段（如 source_line）传给服务端。
        """

        payload: Dict[str, object] = {
            "term": self.term,
            "translation": self.translation,
            "pos": self.pos,
        }
        if self.note:
            payload["note"] = self.note
        if self.variants:
            payload["variants"] = self.variants
        return payload


def log_info(*parts: object) -> None:
    """统一信息日志输出，便于和错误日志区分。"""

    print("[INFO]", *parts, flush=True)


def log_warn(*parts: object) -> None:
    """统一警告日志输出。"""

    print("[WARN]", *parts, flush=True)


def log_error(*parts: object) -> None:
    """统一错误日志输出。"""

    print("[ERROR]", *parts, file=sys.stderr, flush=True)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """
    解析命令行参数。

    设计取舍：
    - 默认 dry-run，避免误操作直接导入。
    - projectId 优先级：CLI > 环境变量 PARATRANZ_PROJECT_ID > config 文件。
    - Token 优先级：CLI > 环境变量（默认 PARATRANZ_TOKEN）。
    """

    parser = argparse.ArgumentParser(
        description="将 CSV 术语表增量导入 ParaTranz（先差集，默认 dry-run，不覆盖已有术语）。"
    )
    parser.add_argument("--csv", dest="csv_path", default="5etool.csv", help="CSV 文件路径（默认：5etool.csv）")
    parser.add_argument(
        "--encoding",
        default=DEFAULT_CSV_ENCODING,
        help=f"CSV 编码（默认：{DEFAULT_CSV_ENCODING}，本次 5etool.csv 建议使用该值）",
    )
    parser.add_argument("--project-id", dest="project_id", default="", help="ParaTranz 项目 ID")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"ParaTranz API 基础地址（默认：{DEFAULT_BASE_URL}）",
    )
    parser.add_argument("--token", default="", help="ParaTranz Token（不传则读环境变量）")
    parser.add_argument(
        "--token-env",
        default=DEFAULT_TOKEN_ENV,
        help=f"读取 Token 的环境变量名（默认：{DEFAULT_TOKEN_ENV}）",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=DEFAULT_PAGE_SIZE,
        help=f"拉取远端术语时的分页大小（默认：{DEFAULT_PAGE_SIZE}）",
    )
    parser.add_argument(
        "--import-batch-size",
        type=int,
        default=DEFAULT_IMPORT_BATCH_SIZE,
        help=f"真实导入时每批上传条数（默认：{DEFAULT_IMPORT_BATCH_SIZE}）",
    )
    parser.add_argument(
        "--conflict-policy",
        choices=["skip", "first", "last"],
        default="skip",
        help="CSV 内部同术语不同译法时的处理策略（默认：skip，更稳妥）",
    )
    parser.add_argument(
        "--report-dir",
        default="",
        help="报告输出目录（默认自动生成到 .tmp/paratranz-terms-import/<时间戳>/）",
    )
    parser.add_argument(
        "--config",
        dest="config_path",
        default="config/overlaylex-i18n.config.json",
        help="OverlayLex i18n 配置文件路径（用于兜底读取 projectId）",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"HTTP 请求超时时间（秒，默认：{DEFAULT_TIMEOUT_SECONDS}）",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="执行真实导入（默认不导入，仅 dry-run 生成报告）",
    )
    return parser.parse_args(argv)


def read_overlaylex_config(config_path: Path) -> Dict[str, object]:
    """
    读取仓库配置文件（如果存在）。

    这里是“软依赖”：
    - 配置不存在时返回空字典；
    - 配置损坏时直接报错（避免用错项目 ID）。
    """

    if not config_path.exists():
        return {}
    text = config_path.read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"配置文件不是 JSON 对象：{config_path}")
    return data


def resolve_project_id(args: argparse.Namespace, config: Dict[str, object]) -> str:
    """
    解析最终使用的 projectId。

    优先级（从高到低）：
    1. --project-id
    2. 环境变量 PARATRANZ_PROJECT_ID
    3. config/overlaylex-i18n.config.json 的 paratranz.projectId
    """

    cli_value = str(args.project_id or "").strip()
    if cli_value:
        return cli_value

    env_value = str(os.environ.get("PARATRANZ_PROJECT_ID", "")).strip()
    if env_value:
        return env_value

    paratranz_config = config.get("paratranz", {})
    if isinstance(paratranz_config, dict):
        cfg_value = str(paratranz_config.get("projectId", "") or "").strip()
        if cfg_value:
            return cfg_value

    return ""


def resolve_token(args: argparse.Namespace) -> str:
    """
    解析最终使用的 Token。

    说明：
    - 默认读取 PARATRANZ_TOKEN；
    - 支持通过 --token-env 指定别的环境变量名；
    - --token 显式传入优先级最高（适合临时调试）。
    """

    cli_token = str(args.token or "").strip()
    if cli_token:
        return cli_token

    token_env_name = str(args.token_env or DEFAULT_TOKEN_ENV).strip() or DEFAULT_TOKEN_ENV
    env_token = str(os.environ.get(token_env_name, "") or "").strip()
    return env_token


def ensure_report_dir(report_dir_arg: str) -> Path:
    """
    创建报告目录。

    选择时间戳目录而不是固定目录的原因：
    - 多次运行不会互相覆盖；
    - 用户可以对比不同 run 的统计结果与冲突列表。
    """

    if report_dir_arg.strip():
        report_dir = Path(report_dir_arg)
    else:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        report_dir = Path(".tmp") / "paratranz-terms-import" / ts

    report_dir.mkdir(parents=True, exist_ok=True)
    return report_dir


def split_variants(raw_variants: str) -> List[str]:
    """
    解析 CSV 第 4 列（术语变体）。

    本次 `5etool.csv` 里该列几乎为空，因此采用“宽松且简单”的实现：
    - 支持常见分隔符：`,` `;` `|` `、` `，` `；`
    - 去空白、去空项、去重（保持原顺序）
    """

    text = (raw_variants or "").strip()
    if not text:
        return []

    normalized = text
    for sep in ["；", "，", "、", ";", "|"]:
        normalized = normalized.replace(sep, ",")

    result: List[str] = []
    seen = set()
    for item in normalized.split(","):
        value = item.strip()
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def parse_csv_rows(csv_path: Path, encoding: str) -> Tuple[List[CsvTermRow], Dict[str, object]]:
    """
    读取并解析 CSV 文件。

    CSV 列映射（按本次 5eTool 导出格式）：
    - col1 -> term
    - col2 -> translation
    - col3 -> pos
    - col4 -> variants（本次通常为空）
    - col5 -> note

    返回：
    - rows: 清洗后的行对象列表
    - stats: 基础统计（总行数、空值情况等）
    """

    rows: List[CsvTermRow] = []
    stats = {
        "csv_total_rows": 0,
        "csv_invalid_column_rows": 0,
        "csv_empty_term_rows": 0,
        "csv_empty_translation_rows": 0,
    }

    with csv_path.open("r", encoding=encoding, newline="") as file_obj:
        reader = csv.reader(file_obj)
        for line_no, row in enumerate(reader, 1):
            stats["csv_total_rows"] += 1

            if len(row) != 5:
                stats["csv_invalid_column_rows"] += 1
                continue

            term = (row[0] or "").strip()
            translation = (row[1] or "").strip()
            pos = (row[2] or "").strip() or "noun"
            variants = split_variants(row[3] or "")
            note = (row[4] or "").strip()

            if not term:
                stats["csv_empty_term_rows"] += 1
                continue
            if not translation:
                stats["csv_empty_translation_rows"] += 1
                continue

            rows.append(
                CsvTermRow(
                    source_line=line_no,
                    term=term,
                    translation=translation,
                    pos=pos,
                    note=note,
                    variants=variants,
                )
            )

    return rows, stats


def term_unique_key(row: CsvTermRow) -> str:
    """
    生成“术语唯一键”。

    这里默认只使用 term（而不是 term+pos），原因：
    - ParaTranz 文档对 createTerm 的描述是“相同术语会失败”；
    - 实际重复判定更可能以 term 为主；
    - 这样更保守，能最大化避免重复导入报错。
    """

    return row.term.strip()


def term_signature_for_conflict(row: CsvTermRow) -> Tuple[str, str, str, Tuple[str, ...]]:
    """
    生成“内容签名”，用于区分“完全重复”与“同术语冲突”。

    - 完全重复：同 key 且签名完全一致（可安全去重）
    - 冲突：同 key 但签名不一致（需要策略处理）
    """

    return (row.translation, row.pos, row.note, tuple(row.variants))


def dedupe_csv_rows(
    rows: Sequence[CsvTermRow],
    conflict_policy: str,
) -> Tuple[List[CsvTermRow], Dict[str, object], List[Dict[str, object]]]:
    """
    对 CSV 行做内部去重与冲突处理。

    conflict_policy:
    - skip: 冲突术语整组跳过（最稳妥）
    - first: 保留第一条（最大化导入量，但有语义取舍）
    - last: 保留最后一条

    返回：
    - deduped_rows: 处理后的候选术语列表
    - stats: 去重统计
    - conflict_report: 详细冲突报告（供人工复核）
    """

    grouped: Dict[str, List[CsvTermRow]] = {}
    for row in rows:
        grouped.setdefault(term_unique_key(row), []).append(row)

    deduped_rows: List[CsvTermRow] = []
    conflict_report: List[Dict[str, object]] = []

    stats = {
        "csv_unique_term_keys": 0,
        "csv_exact_duplicate_keys": 0,
        "csv_conflict_keys": 0,
        "csv_conflict_skipped_keys": 0,
        "csv_conflict_selected_keys": 0,
        "csv_exact_duplicate_skipped_rows": 0,
        "csv_rows_after_internal_dedupe": 0,
    }

    for key, items in grouped.items():
        stats["csv_unique_term_keys"] += 1

        if len(items) == 1:
            deduped_rows.append(items[0])
            continue

        signatures = {term_signature_for_conflict(item) for item in items}
        if len(signatures) == 1:
            # 同一个术语重复出现，但内容完全一样：保留一条即可。
            stats["csv_exact_duplicate_keys"] += 1
            stats["csv_exact_duplicate_skipped_rows"] += len(items) - 1
            deduped_rows.append(items[0])
            continue

        # 到这里说明是“同术语不同内容”的冲突，必须记录详细报告。
        stats["csv_conflict_keys"] += 1
        conflict_report.append(
            {
                "term_key": key,
                "candidates": [
                    {
                        "source_line": item.source_line,
                        "term": item.term,
                        "translation": item.translation,
                        "pos": item.pos,
                        "note": item.note,
                        "variants": item.variants,
                    }
                    for item in items
                ],
            }
        )

        if conflict_policy == "skip":
            stats["csv_conflict_skipped_keys"] += 1
            continue

        selected = items[0] if conflict_policy == "first" else items[-1]
        stats["csv_conflict_selected_keys"] += 1
        deduped_rows.append(selected)

    stats["csv_rows_after_internal_dedupe"] = len(deduped_rows)
    return deduped_rows, stats, conflict_report


def json_dumps_pretty(data: object) -> str:
    """
    统一 JSON 输出格式。

    ensure_ascii=False 让中文报告可直接阅读；
    indent=2 方便 diff 和人工检查。
    """

    return json.dumps(data, ensure_ascii=False, indent=2)


def write_json_file(path: Path, data: object) -> None:
    """写 JSON 文件（UTF-8）。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps_pretty(data), encoding="utf-8")


def http_request(
    method: str,
    url: str,
    token: str,
    *,
    timeout: int,
    body: Optional[bytes] = None,
    content_type: Optional[str] = None,
    accept: str = "application/json",
) -> Tuple[int, bytes, Dict[str, str]]:
    """
    发起 HTTP 请求（标准库 urllib 版本）。

    返回：
    - status_code
    - response_body_bytes
    - response_headers（简化为普通 dict，键名统一小写）

    这里不直接吞异常，而是把 HTTPError 也按“正常响应”返回，方便调用方读取服务端报错体。
    """

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": accept,
        "User-Agent": "OverlayLex-Terms-Incremental-Importer/1.0",
    }
    if content_type:
        headers["Content-Type"] = content_type

    req = request.Request(url=url, data=body, headers=headers, method=method.upper())
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            resp_body = resp.read()
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return int(resp.status), resp_body, resp_headers
    except error.HTTPError as http_err:
        resp_body = http_err.read() if http_err.fp else b""
        resp_headers = {k.lower(): v for k, v in http_err.headers.items()} if http_err.headers else {}
        return int(http_err.code), resp_body, resp_headers


def http_get_json(url: str, token: str, *, timeout: int) -> object:
    """
    GET 并解析 JSON。

    若响应不是 2xx，会抛出带响应体摘要的异常，便于定位权限/参数问题。
    """

    status, body, _ = http_request("GET", url, token, timeout=timeout)
    if status < 200 or status >= 300:
        raise RuntimeError(f"GET {url} 失败，HTTP {status}，响应：{safe_text_preview(body)}")
    try:
        return json.loads(body.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"GET {url} 返回非 JSON：{safe_text_preview(body)}") from exc


def safe_text_preview(body: bytes, limit: int = 500) -> str:
    """
    生成响应体预览文本（用于报错信息）。

    优先按 UTF-8 解码，失败时使用替代字符，避免异常吞掉真正错误原因。
    """

    text = body.decode("utf-8", errors="replace")
    if len(text) <= limit:
        return text
    return text[:limit] + "...(truncated)"


def fetch_remote_terms(
    base_url: str,
    project_id: str,
    token: str,
    *,
    page_size: int,
    timeout: int,
) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    """
    分页拉取远端术语列表（getTerms）。

    返回：
    - all_terms: 原样保留服务端术语对象（便于后续调试）
    - stats: 拉取统计信息（页数、总数）
    """

    normalized_base = base_url.rstrip("/")
    page = 1
    all_terms: List[Dict[str, object]] = []
    observed_page_count: Optional[int] = None
    observed_row_count: Optional[int] = None

    while True:
        query = parse.urlencode({"page": page, "pageSize": page_size})
        url = f"{normalized_base}/projects/{parse.quote(str(project_id))}/terms?{query}"
        payload = http_get_json(url, token, timeout=timeout)
        if not isinstance(payload, dict):
            raise RuntimeError(f"getTerms 返回结构异常（非对象）：page={page}")

        results = payload.get("results", [])
        if results is None:
            results = []
        if not isinstance(results, list):
            raise RuntimeError(f"getTerms 返回结构异常（results 非数组）：page={page}")

        page_count = payload.get("pageCount")
        row_count = payload.get("rowCount")
        if isinstance(page_count, int):
            observed_page_count = page_count
        if isinstance(row_count, int):
            observed_row_count = row_count

        all_terms.extend([item for item in results if isinstance(item, dict)])
        log_info(f"已拉取远端术语分页：page={page}, 本页={len(results)}, 累计={len(all_terms)}")

        # 结束条件优先使用 pageCount；如果服务端字段异常，则退化到“本页不足 pageSize”判断。
        if isinstance(page_count, int) and page_count > 0:
            if page >= page_count:
                break
        else:
            if len(results) < page_size:
                break

        page += 1

    stats = {
        "remote_page_count": observed_page_count,
        "remote_row_count_reported": observed_row_count,
        "remote_terms_fetched": len(all_terms),
    }
    return all_terms, stats


def build_remote_term_key_set(remote_terms: Sequence[Dict[str, object]]) -> set:
    """
    构建远端术语 key 集合，用于本地差集判断。

    仍然采用“仅按 term 判重”的保守策略，以降低重复创建失败概率。
    """

    key_set = set()
    for item in remote_terms:
        term = str(item.get("term", "") or "").strip()
        if term:
            key_set.add(term)
    return key_set


def build_incremental_terms(
    deduped_rows: Sequence[CsvTermRow],
    remote_term_keys: set,
) -> Tuple[List[CsvTermRow], Dict[str, object]]:
    """
    计算“仅新增”的术语列表。

    返回：
    - incremental_rows: 远端不存在、可以尝试导入的术语
    - stats: 差集统计（已存在多少、待导入多少）
    """

    incremental_rows: List[CsvTermRow] = []
    already_exists_count = 0

    for row in deduped_rows:
        if term_unique_key(row) in remote_term_keys:
            already_exists_count += 1
            continue
        incremental_rows.append(row)

    stats = {
        "remote_existing_conflict_count": already_exists_count,
        "incremental_candidate_count": len(incremental_rows),
    }
    return incremental_rows, stats


def chunked(seq: Sequence[CsvTermRow], size: int) -> Iterable[List[CsvTermRow]]:
    """按固定大小切分序列，供分批导入使用。"""

    if size <= 0:
        raise ValueError("batch size 必须大于 0")
    for i in range(0, len(seq), size):
        yield list(seq[i : i + size])


def build_multipart_file_body(
    *,
    field_name: str,
    filename: str,
    file_content: bytes,
    file_content_type: str = "application/json",
) -> Tuple[bytes, str]:
    """
    手工构造 multipart/form-data 请求体（标准库实现）。

    这样可以避免依赖第三方库（如 requests），便于在仓库环境直接运行。
    """

    boundary = f"----OverlayLexBoundary{uuid.uuid4().hex}"
    boundary_bytes = boundary.encode("ascii")

    lines: List[bytes] = []
    lines.append(b"--" + boundary_bytes)
    lines.append(
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"'.encode("utf-8")
    )
    lines.append(f"Content-Type: {file_content_type}".encode("ascii"))
    lines.append(b"")
    lines.append(file_content)
    lines.append(b"--" + boundary_bytes + b"--")
    lines.append(b"")

    # 按 CRLF 拼接是 multipart/form-data 的标准写法。
    body = b"\r\n".join(lines)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


def import_terms_batch(
    *,
    base_url: str,
    project_id: str,
    token: str,
    batch_rows: Sequence[CsvTermRow],
    timeout: int,
) -> Tuple[bool, str]:
    """
    调用 ParaTranz importTerms 接口导入一批术语。

    返回：
    - success: 是否成功
    - message: 服务端响应摘要（用于日志/报告）
    """

    payload_list = [row.to_paratranz_payload() for row in batch_rows]
    json_bytes = json.dumps(payload_list, ensure_ascii=False).encode("utf-8")

    multipart_body, multipart_content_type = build_multipart_file_body(
        field_name="file",
        filename="terms-import-batch.json",
        file_content=json_bytes,
    )

    url = f"{base_url.rstrip('/')}/projects/{parse.quote(str(project_id))}/terms"
    status, body, _ = http_request(
        "PUT",
        url,
        token,
        timeout=timeout,
        body=multipart_body,
        content_type=multipart_content_type,
        accept="application/json, text/plain, */*",
    )

    if 200 <= status < 300:
        return True, safe_text_preview(body)
    return False, f"HTTP {status}: {safe_text_preview(body)}"


def run_import_batches(
    *,
    base_url: str,
    project_id: str,
    token: str,
    incremental_rows: Sequence[CsvTermRow],
    import_batch_size: int,
    timeout: int,
    report_dir: Path,
) -> Dict[str, object]:
    """
    分批执行真实导入，并输出每批结果报告。

    策略说明：
    - 批量导入接口更快，但出错时可能整批失败；
    - 因此我们记录 batch 级报告，方便定位失败批次；
    - 这里默认“失败即停止”，避免继续推进导致状态更难审计。
    """

    batch_results: List[Dict[str, object]] = []
    success_batches = 0
    success_rows = 0

    total_batches = math.ceil(len(incremental_rows) / import_batch_size) if incremental_rows else 0
    for index, batch_rows in enumerate(chunked(incremental_rows, import_batch_size), 1):
        log_info(f"开始导入批次 {index}/{total_batches}，条数={len(batch_rows)}")
        ok, message = import_terms_batch(
            base_url=base_url,
            project_id=project_id,
            token=token,
            batch_rows=batch_rows,
            timeout=timeout,
        )

        batch_record = {
            "batch_index": index,
            "batch_size": len(batch_rows),
            "first_term": batch_rows[0].term if batch_rows else "",
            "last_term": batch_rows[-1].term if batch_rows else "",
            "success": ok,
            "message": message,
        }
        batch_results.append(batch_record)

        if not ok:
            write_json_file(report_dir / "import-batch-results.json", batch_results)
            raise RuntimeError(f"批次 {index} 导入失败：{message}")

        success_batches += 1
        success_rows += len(batch_rows)
        log_info(f"批次 {index} 导入成功")

        # 轻微节流，降低触发频率限制的概率。
        time.sleep(0.2)

    write_json_file(report_dir / "import-batch-results.json", batch_results)
    return {
        "import_total_batches": total_batches,
        "import_success_batches": success_batches,
        "import_success_rows": success_rows,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    """
    主流程：
    1) 读取参数与配置
    2) 解析 CSV
    3) CSV 内部去重/冲突处理
    4) 拉取远端术语
    5) 计算差集并输出报告
    6) （可选）执行真实导入
    7) 再次拉取校验（可选）
    """

    args = parse_args(argv)

    csv_path = Path(args.csv_path)
    if not csv_path.exists():
        log_error(f"CSV 文件不存在：{csv_path}")
        return 2

    try:
        config = read_overlaylex_config(Path(args.config_path))
        project_id = resolve_project_id(args, config)
        token = resolve_token(args)
        report_dir = ensure_report_dir(args.report_dir)

        if not project_id:
            raise RuntimeError("缺少项目 ID。请传 --project-id，或设置环境变量 PARATRANZ_PROJECT_ID，或在配置文件中填写 paratranz.projectId。")
        if not token:
            raise RuntimeError(f"缺少 Token。请传 --token，或设置环境变量 {args.token_env}。")

        if args.page_size <= 0:
            raise RuntimeError("--page-size 必须大于 0")
        if args.import_batch_size <= 0:
            raise RuntimeError("--import-batch-size 必须大于 0")
        if args.timeout <= 0:
            raise RuntimeError("--timeout 必须大于 0")

        log_info("报告目录：", report_dir)
        log_info("项目 ID：", project_id)
        log_info("CSV：", csv_path, f"(encoding={args.encoding})")
        log_info("模式：", "真实导入 (--execute)" if args.execute else "dry-run（仅生成报告）")
        log_info("冲突策略：", args.conflict_policy)

        # 第 1 步：读取并解析 CSV。
        csv_rows, csv_parse_stats = parse_csv_rows(csv_path, args.encoding)
        log_info("CSV 解析完成，合法候选行数：", len(csv_rows))

        # 第 2 步：CSV 内部去重与冲突报告。
        deduped_rows, csv_dedupe_stats, conflict_report = dedupe_csv_rows(
            csv_rows, conflict_policy=args.conflict_policy
        )
        log_info(
            "CSV 内部去重完成：",
            f"去重后={len(deduped_rows)}",
            f"冲突键={csv_dedupe_stats['csv_conflict_keys']}",
            f"冲突策略={args.conflict_policy}",
        )

        # 把 CSV 层面的报告先落盘，便于即使后续 API 失败也能保留结果。
        write_json_file(report_dir / "csv-parse-stats.json", csv_parse_stats)
        write_json_file(report_dir / "csv-dedupe-stats.json", csv_dedupe_stats)
        write_json_file(report_dir / "csv-conflicts.json", conflict_report)

        # 第 3 步：拉取远端术语列表。
        remote_terms, remote_stats = fetch_remote_terms(
            args.base_url,
            project_id,
            token,
            page_size=args.page_size,
            timeout=args.timeout,
        )
        remote_term_keys = build_remote_term_key_set(remote_terms)
        log_info("远端术语拉取完成：", f"远端 key 数={len(remote_term_keys)}")

        # 输出远端快照（只保留必要字段，避免报告文件过大）。
        remote_terms_snapshot = [
            {
                "id": item.get("id"),
                "term": item.get("term"),
                "translation": item.get("translation"),
                "pos": item.get("pos"),
                "note": item.get("note"),
            }
            for item in remote_terms
        ]
        write_json_file(report_dir / "remote-terms-snapshot.json", remote_terms_snapshot)

        # 第 4 步：计算差集（只保留远端不存在的术语）。
        incremental_rows, diff_stats = build_incremental_terms(deduped_rows, remote_term_keys)
        incremental_payload = [row.to_paratranz_payload() for row in incremental_rows]
        write_json_file(report_dir / "terms-incremental.json", incremental_payload)

        # 也把“导入前清洗后的全量候选”落盘，方便比对。
        deduped_payload = [row.to_paratranz_payload() for row in deduped_rows]
        write_json_file(report_dir / "terms-deduped-candidates.json", deduped_payload)

        summary: Dict[str, object] = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "csv_path": str(csv_path),
            "csv_encoding": args.encoding,
            "project_id": str(project_id),
            "base_url": args.base_url.rstrip("/"),
            "execute": bool(args.execute),
            "conflict_policy": args.conflict_policy,
            "report_dir": str(report_dir),
            **csv_parse_stats,
            **csv_dedupe_stats,
            **remote_stats,
            "remote_term_keys_count": len(remote_term_keys),
            **diff_stats,
        }

        write_json_file(report_dir / "summary.json", summary)
        log_info("差集计算完成：", f"可导入新增={diff_stats['incremental_candidate_count']}")

        # 第 5 步：按需执行真实导入。
        if not args.execute:
            log_info("dry-run 完成。未执行导入。")
            print(json_dumps_pretty(summary))
            return 0

        if not incremental_rows:
            log_info("没有需要导入的新增术语，跳过导入。")
            print(json_dumps_pretty(summary))
            return 0

        import_stats = run_import_batches(
            base_url=args.base_url,
            project_id=project_id,
            token=token,
            incremental_rows=incremental_rows,
            import_batch_size=args.import_batch_size,
            timeout=args.timeout,
            report_dir=report_dir,
        )
        summary.update(import_stats)

        # 第 6 步：回读校验（重新拉一遍远端术语，确认数量变化）。
        remote_terms_after, remote_stats_after = fetch_remote_terms(
            args.base_url,
            project_id,
            token,
            page_size=args.page_size,
            timeout=args.timeout,
        )
        summary.update(
            {
                "remote_terms_fetched_after_import": len(remote_terms_after),
                "remote_row_count_reported_after_import": remote_stats_after.get("remote_row_count_reported"),
            }
        )
        if isinstance(summary.get("remote_terms_fetched"), int):
            summary["remote_terms_fetched_delta"] = len(remote_terms_after) - int(summary["remote_terms_fetched"])

        write_json_file(report_dir / "summary.json", summary)
        log_info("真实导入完成并已回读校验。")
        print(json_dumps_pretty(summary))
        return 0

    except Exception as exc:
        log_error(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())

