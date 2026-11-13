"""按显式模块选择回归；测试通过不代替代码审查或浏览器验收。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
# 名单是常用起点，不是依赖分析器；跨模块时合并范围，新测试可用参数补入。
SCOPES = {
    'docs': ('', ''),
    'tooling': ('', 'tools/qa/tests/test_*.py tools/sz/tests/test_*server.py'),
    'controls': ('controllers vehicle-physics car-wheels vehicle-lights sz-vehicles sz-auto-drive '
                 'sz-controller-surfaces building-collision teleports touch-controls cameras', ''),
    'roads': ('sz-roads sz-ground sz-terrain sz-road-frontage sz-road-markings sz-road-material sz-elevated-roads '
              'sz-traffic sz-auto-drive sz-intersection-control sz-controller-surfaces controllers',
              'tools/sz/tests/test_road*.py tools/sz/tests/test_*terrain*.py '
              'tools/sz/tests/test_copernicus.py tools/sz/tests/test_sea_surface.py'),
    'buildings': ('sz-buildings sz-building-details sz-building-signs sz-roof-equipment '
                  'sz-podium-clearance sz-landmarks sz-chunjian sz-civic-center sz-iec '
                  'sz-convention-center sz-superhq sz-upperhills sz-nonferrous-tower '
                  'sz-bay-bridge building-collision sz-light-show',
                  'tools/sz/tests/test_building*.py tools/sz/tests/test_landmark_sites.py'),
    'street': ('sz-trees sz-tree-crown sz-streetscape sz-street-lamps sz-pedestrians pedestrians '
               'sz-metro-entrances sz-station-sites sz-bay-waterfront sz-talent-park sz-drone-routes sz-air-evidence sz-apec sz-apec-city',
               'tools/sz/tests/test_trees.py tools/sz/tests/test_metro.py'),
    'ui': ('boot sz-geodata-boot sz-main-startup runtime-reachability sz-qa sz-map sz-map-regions '
           'sz-city-config teleports cameras touch-controls sz-observation-session', ''),
    'data': ('sz-data sz-scene-style sz-fastpack sz-geodata-boot sz-ground sz-terrain sz-spatial '
             'sz-city-config sz-buildings sz-elevated-roads sz-auto-drive', 'tools/sz/tests/test_*.py'),
    'full': ('*', 'tools/sz/tests/test_*.py tools/qa/tests/test_*.py'),
}


def select_tests(scopes, extra_node=(), extra_python=(), root=ROOT):
    patterns = {'node': list(extra_node), 'python': list(extra_python)}
    for scope in scopes:
        node, python = SCOPES[scope]
        patterns['node'].extend(f'tests/{name}.test.cjs' for name in node.split())
        patterns['python'].extend(python.split())
    selected = {}
    for kind, entries in patterns.items():
        files = set()
        for pattern in entries:
            if Path(pattern).is_absolute() or '..' in Path(pattern).parts:
                raise ValueError('Test paths must stay inside the repository')
            matches = [p for p in root.glob(pattern) if p.is_file()]
            if not matches:
                raise ValueError(f'Test pattern matched no files: {pattern}')
            files.update(p.relative_to(root).as_posix() for p in matches)
        selected[kind] = sorted(files)
    return selected


def fingerprint(root=ROOT):
    # 同时覆盖已提交、暂存、未暂存和未跟踪的运行时代码；缺失文件也参与摘要。
    paths = subprocess.check_output(['git', 'ls-files', '-cz', '--others', '--exclude-standard',
                                    '--', 'js', 'css', 'index.html', 'tests', 'tools', 'data/source'], cwd=root)
    digest = hashlib.sha256()
    for name in sorted(set(paths.split(b'\0')) - {b''}):
        path = root / os.fsdecode(name)
        digest.update(name + b'\0')
        digest.update(hashlib.sha256(path.read_bytes()).digest() if path.is_file() else b'missing')
    return digest.hexdigest()


def test_summary(kind, output, returncode):
    if kind == 'node':
        count = re.search(r'^# tests (\d+)$', output, re.M)
        skip = re.search(r'^# skipped (\d+)$', output, re.M)
        valid = count is not None and skip is not None and int(count[1]) > 0
        skipped = int(skip[1]) if skip else None
    else:
        count = re.search(r'^Ran (\d+) tests? in ', output, re.M)
        skip = re.search(r'skipped=(\d+)', output)
        valid = count is not None and int(count[1]) > 0
        skipped = int(skip[1]) if skip else 0
    return {'tests': int(count[1]) if count else None, 'skipped': skipped,
            'passed': returncode == 0 and valid and skipped == 0, 'returncode': returncode}


def main():
    parser = argparse.ArgumentParser(description='Run scoped regression checks; use full for release or shared-core changes.')
    parser.add_argument('--scope', choices=SCOPES, action='append', required=True)
    parser.add_argument('--node', action='append', default=[], help='additional repository-relative Node test glob')
    parser.add_argument('--python', action='append', default=[], help='additional repository-relative Python test glob')
    parser.add_argument('--list', action='store_true', help='print the selected files without running tests')
    args = parser.parse_args()
    selected = select_tests(args.scope, args.node, args.python)
    if args.list:
        print(json.dumps(selected, indent=2))
        return 0
    for command in (['git', 'diff', '--check'], ['git', 'diff', '--cached', '--check']):
        subprocess.run(command, cwd=ROOT, check=True)
    env = os.environ.copy()
    commands = {}
    versions = {}
    if selected['node']:
        three = Path(env.get('SZ_THREE_PACKAGE_DIR', ROOT / '.agents/three-0.187.0')).resolve()
        version = json.loads((three / 'package.json').read_text())['version']
        if version != '0.187.0' or not (three / 'build/three.webgpu.js').is_file():
            raise ValueError('SZ_THREE_PACKAGE_DIR must contain Three.js 0.187.0')
        env['SZ_THREE_PACKAGE_DIR'] = str(three)
        versions['three'] = version
        versions['node'] = subprocess.check_output(['node', '--version'], text=True).strip()
        commands['node'] = ['node', '--test', '--test-reporter=tap', *selected['node']]
    if selected['python']:
        python = ROOT / '.venv/bin/python'
        if not python.is_file():
            raise ValueError('Missing .venv/bin/python; install the project Python environment first')
        versions['python'] = subprocess.check_output([str(python), '--version'], text=True).strip()
        commands['python'] = [str(python), '-m', 'unittest', *selected['python']]
    before = fingerprint()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output_dir = ROOT / 'docs/qa/checks' / run_id
    output_dir.mkdir(parents=True)
    report = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'scopes': args.scope, 'sourceHash': before, 'versions': versions, 'selected': selected, 'commands': commands,
              'results': {}, 'review': 'not-recorded', 'browser': 'not-run'}

    def run(kind, command):
        started = time.monotonic()
        result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT)
        (output_dir / f'{kind}.log').write_text(result.stdout)
        summary = test_summary(kind, result.stdout, result.returncode)
        summary['seconds'] = round(time.monotonic() - started, 3)
        return kind, summary

    # Node 和 Python 各跑一次；源码包装测试已移除，不重复调用另一套测试。
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, kind, command) for kind, command in commands.items()]
        for future in futures:
            kind, result = future.result()
            report['results'][kind] = result
            print(f'{kind}: {json.dumps(result)}', flush=True)
    report['sourceUnchanged'] = before == fingerprint()
    report['passed'] = report['sourceUnchanged'] and all(r['passed'] for r in report['results'].values())
    report['testCoverage'] = 'selected-tests' if commands else 'whitespace-only'
    (output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Report: {output_dir.relative_to(ROOT)}/result.json')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Check failed: {error}', file=sys.stderr)
        sys.exit(1)
