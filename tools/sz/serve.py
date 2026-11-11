import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class LocalCityServer(ThreadingHTTPServer):
    # 冷启动会并发请求模块和城市数据，标准库默认的 5 个待接收连接容易被用完。
    request_queue_size = 64


class DevHandler(SimpleHTTPRequestHandler):
    # 标准库只发 Last-Modified，浏览器对模块按“年龄 10%”做启发式缓存，代码更新后
    # 会出现新 main.js 配旧的 sz-geodata.js，直接报 does not provide an export named。
    # 开发服务器一律不缓存，刷新即拿到与磁盘一致的一整套文件。
    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description='Serve Slop Shenzhen on localhost.')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    handler = partial(DevHandler, directory=Path(__file__).resolve().parents[2])
    with LocalCityServer(('127.0.0.1', args.port), handler) as server:
        print(f'Serving Slop Shenzhen at http://127.0.0.1:{server.server_port}/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
