from ..config import RETRY_ACCOUNT, RETRY_FILE

def retry(function):
    """发生错误时尝试重新执行"""

    def inner(*args, **kwargs):
        try:
            if r := function(*args, **kwargs):
                return r
        except Exception as e:
            pass
        for _ in range(RETRY_ACCOUNT):
            try:
                if r := function(*args, **kwargs):
                    return r
            except Exception as e:
                continue
        return None

    return inner

def retry_async(function):
    """发生错误时尝试重新执行"""

    async def inner(*args, **kwargs):
        try:
            if r := await function(*args, **kwargs):
                return r
        except Exception as e:
            pass
        for _ in range(RETRY_FILE):
            try:
                if r := await function(*args, **kwargs):
                    return r
            except Exception as e:
                continue
        return None

    return inner
