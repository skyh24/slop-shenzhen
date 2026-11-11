"""检查测试入口不会漏掉已选文件、吞掉失败或把跳过当成通过。"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check import ROOT, SCOPES, select_tests, test_summary


class CheckTest(unittest.TestCase):
    def test_all_scopes_resolve_and_full_covers_every_test_file(self):
        for scope in SCOPES:
            select_tests([scope])
        full = select_tests(['full'])
        self.assertEqual(full['node'], sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests').glob('*.test.cjs')))
        expected = [p.relative_to(ROOT).as_posix() for directory in ('tools/sz/tests', 'tools/qa/tests')
                    for p in (ROOT / directory).glob('test_*.py')]
        self.assertEqual(full['python'], sorted(expected))

    def test_scopes_union_without_duplicate_execution(self):
        single = select_tests(['roads'])
        self.assertEqual(single, select_tests(['roads', 'roads']))
        self.assertIn('tools/sz/tests/test_roadgraph.py', single['python'])
        self.assertEqual(select_tests(['docs']), {'node': [], 'python': []})

    def test_new_tests_can_be_added_and_missing_or_external_paths_fail(self):
        selected = select_tests(['docs'], ['tests/controllers.test.cjs'])
        self.assertEqual(selected['node'], ['tests/controllers.test.cjs'])
        for path in ('tests/no-such-test.cjs', '../test.py', '/test.py'):
            with self.assertRaises(ValueError):
                select_tests(['docs'], [path])

    def test_node_failures_skips_and_empty_runs_do_not_pass(self):
        valid = '# tests 3\n# skipped 0\n'
        self.assertTrue(test_summary('node', valid, 0)['passed'])
        for output, code in ((valid, 1), ('# tests 3\n# skipped 1\n', 0),
                             ('# tests 0\n# skipped 0\n', 0), ('', 0)):
            self.assertFalse(test_summary('node', output, code)['passed'])

    def test_python_failures_skips_and_empty_runs_do_not_pass(self):
        valid = 'Ran 3 tests in 0.01s\n\nOK\n'
        self.assertTrue(test_summary('python', valid, 0)['passed'])
        for output, code in ((valid, 1), (valid + 'OK (skipped=1)', 0),
                             ('Ran 0 tests in 0.00s\nOK', 0), ('', 0)):
            self.assertFalse(test_summary('python', output, code)['passed'])


if __name__ == '__main__':
    unittest.main()
