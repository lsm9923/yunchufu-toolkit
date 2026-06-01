"""
抖音批量下载 - 非交互式入口
从 stdin 读取 JSON 配置，输出 JSON 行进度到 stdout

输入格式 (stdin):
{"url": "https://www.douyin.com/user/xxx", "earliest": "2024/1/1", "latest": "", "save_folder": "D:\\douyin_downloads"}

输出格式 (stdout, 每行一个 JSON):
{"type":"start","account":"xxx","total":95}
{"type":"progress","id":"xxx","title":"xxx","status":"downloaded","size":"29.73 MB"}
{"type":"progress","id":"xxx","title":"xxx","status":"skipped"}
{"type":"done","downloaded":80,"skipped":15,"failed":0}
{"type":"error","message":"xxx"}
"""

import sys
import json
import asyncio
import re
from pathlib import Path
from datetime import date

import requests
from aiohttp import ClientSession, ClientTimeout
from yarl import URL

# 确保项目根目录在 sys.path 中
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.config import Settings, Cookie, Account, HEADERS
from src.download import Acquire, Parse
from src.tool import Cleaner


def emit(obj):
    """输出一行 JSON 到 stdout"""
    line = json.dumps(obj, ensure_ascii=False) + '\n'
    sys.stdout.buffer.write(line.encode('utf-8'))
    sys.stdout.buffer.flush()


def resolve_short_url(url: str) -> str:
    """解析短链接，返回真实的用户主页 URL"""
    # 如果已经是标准格式，直接返回
    if 'www.douyin.com/user/' in url:
        return url
    # 尝试解析短链接
    if 'v.douyin.com' in url or 'iesdouyin.com' in url:
        try:
            resp = requests.get(url, headers={'User-Agent': HEADERS['User-Agent']}, allow_redirects=True, timeout=10, verify=False, proxies={'http': None, 'https': None})
            final_url = resp.url
            # 提取 sec_user_id
            m = re.search(r'sec_uid=([^&]+)', final_url)
            if m:
                return f'https://www.douyin.com/user/{m.group(1)}'
            m = re.search(r'/user/([^?]+)', final_url)
            if m:
                return f'https://www.douyin.com/user/{m.group(1)}'
        except Exception as e:
            emit({"type": "error", "message": f"短链接解析失败: {e}"})
    return url


def build_settings(config: dict) -> Settings:
    """从配置 dict 构建 Settings 对象"""
    url = resolve_short_url(config['url'])
    account = Account(
        mark=config.get('mark', ''),
        url=url,
        earliest=config.get('earliest', ''),
        latest=config.get('latest', ''),
    )
    kwargs = {'accounts': (account,)}
    if save_folder := config.get('save_folder'):
        kwargs['save_folder'] = Path(save_folder)
    if concurrency := config.get('concurrency'):
        kwargs['concurrency'] = concurrency
    return Settings(**kwargs)


def generate_task_name(item: dict, settings: Settings, cleaner: Cleaner) -> str:
    """生成文件名（复用 download.py 的逻辑）"""
    return cleaner.filter_name(
        settings.split.join(item[key] for key in settings.name_format))


async def download_one(url: str, path: Path, sem: asyncio.Semaphore,
                       settings: Settings, cookie: Cookie) -> bool:
    """下载单个文件，返回是否成功"""
    async with sem:
        try:
            async with ClientSession(
                headers=HEADERS | {'Cookie': cookie._generate_str()},
                timeout=ClientTimeout(settings.timeout),
            ) as session:
                async with session.get(URL(url, encoded=True)) as resp:
                    if resp.status not in (200, 206):
                        return False
                    content_length = int(resp.headers.get('content-length', 0))
                    if content_length == 0:
                        return False
                    with open(path, 'wb') as f:
                        async for chunk in resp.content.iter_chunked(settings.chunk_size):
                            f.write(chunk)
                    return True
        except Exception:
            return False


async def download_all(items: list[dict], settings: Settings, cleaner: Cleaner, cookie: Cookie):
    """下载所有作品，输出进度"""
    save_folder = settings.save_folder
    account = settings.accounts[0]
    folder = save_folder / f'UID{account.id}_{account.mark}_发布作品'
    folder.mkdir(parents=True, exist_ok=True)

    sem = asyncio.Semaphore(settings.concurrency)
    downloaded = 0
    skipped = 0
    failed = 0

    for item in items:
        item_id = item['id']
        desc = item.get('desc', '')[:30]
        name = generate_task_name(item, settings, cleaner)
        item_type = item['type']

        if item_type == '图集':
            for idx, (url, w, h) in enumerate(item['downloads'], start=1):
                img_path = folder / f'{name}_{idx}.jpeg'
                if img_path.exists():
                    emit({"type": "progress", "id": item_id, "title": desc, "status": "skipped"})
                    skipped += 1
                    continue
                ok = await download_one(url, img_path, sem, settings, cookie)
                if ok:
                    size_mb = img_path.stat().st_size / (1024 * 1024)
                    emit({"type": "progress", "id": item_id, "title": desc,
                          "status": "downloaded", "size": f"{size_mb:.2f} MB"})
                    downloaded += 1
                else:
                    emit({"type": "progress", "id": item_id, "title": desc, "status": "failed"})
                    failed += 1
        elif item_type == '视频':
            fmt = item.get('format', '.mp4')
            if fmt == '.dash':
                fmt = '.mp4'
            video_path = folder / f'{name}{fmt}'
            if video_path.exists():
                emit({"type": "progress", "id": item_id, "title": desc, "status": "skipped"})
                skipped += 1
                continue
            url = item['downloads']
            ok = await download_one(url, video_path, sem, settings, cookie)
            if ok:
                size_mb = video_path.stat().st_size / (1024 * 1024)
                emit({"type": "progress", "id": item_id, "title": desc,
                      "status": "downloaded", "size": f"{size_mb:.2f} MB"})
                downloaded += 1
            else:
                emit({"type": "progress", "id": item_id, "title": desc, "status": "failed"})
                failed += 1

    emit({"type": "done", "downloaded": downloaded, "skipped": skipped, "failed": failed})


def main():
    # 读取 stdin 配置
    config_raw = sys.stdin.read().strip()
    if not config_raw:
        emit({"type": "error", "message": "未收到配置信息"})
        sys.exit(1)

    try:
        config = json.loads(config_raw)
    except json.JSONDecodeError as e:
        emit({"type": "error", "message": f"配置 JSON 解析失败: {e}"})
        sys.exit(1)

    if not config.get('url'):
        emit({"type": "error", "message": "缺少 url 参数"})
        sys.exit(1)

    # 构建 Settings 和 Cookie
    settings = build_settings(config)
    cookie = Cookie()
    cookie.load_cookies()

    # 获取作品列表
    account = settings.accounts[0]
    items_raw = Acquire().request_items(account.sec_user_id, account.earliest_date, settings, cookie)

    if not items_raw:
        emit({"type": "error", "message": "获取作品列表失败，可能是接口失效或 Cookie 失效"})
        sys.exit(1)

    # 提取账号信息
    cleaner = Cleaner()
    Parse.extract_account(account, items_raw[0], cleaner)

    emit({"type": "start", "account": account.name, "id": account.id})

    # 解析作品
    items = Parse.extract_items(items_raw, account.earliest_date, account.latest_date, settings, cleaner)
    emit({"type": "info", "total": len(items), "message": f"共 {len(items)} 个作品待下载"})

    if not items:
        emit({"type": "done", "downloaded": 0, "skipped": 0, "failed": 0})
        sys.exit(0)

    # 下载
    asyncio.run(download_all(items, settings, cleaner, cookie))


if __name__ == '__main__':
    main()
