"""Harness correctness tests. No native performance conclusions are drawn here."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('worktrees', Path(__file__).with_name('worktrees.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class EvidenceTests(unittest.TestCase):
    def test_archive_reproducible_and_content_validation_detects_mutation(self):
        self.assertEqual(bench.archive('fixture-0', '1.0.0', 4096), bench.archive('fixture-0', '1.0.0', 4096))
        package = bench.archive('fixture-0', '1.0.0', 10)
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            target = project / 'node_modules' / 'fixture-0'
            target.mkdir(parents=True)
            for name, data in package[1].items():
                (target / name).write_bytes(data)
            packages = {'fixture-0': {'1.0.0': package}}
            self.assertEqual(bench.validate(project, packages), [])
            (target / 'index.js').write_text('poisoned')
            self.assertIn('incorrect content', bench.validate(project, packages)[0])
            (target / 'package.json').unlink()
            self.assertEqual(len(bench.validate(project, packages)), 2)
            (project / 'node_modules' / 'unexpected-package').mkdir()
            self.assertIn('package inventory mismatch', bench.validate(project, packages))

    def test_change_updates_manifest_and_lock_together(self):
        packages = {f'fixture-{i}': {v: bench.archive(f'fixture-{i}', v, 10)
            for v in ('1.0.0', '2.0.0')} for i in range(2)}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bench.write_project(root, packages, 'http://127.0.0.1:1', True)
            manifest = json.loads((root / 'package.json').read_text())
            lock = json.loads((root / 'package-lock.json').read_text())
            self.assertEqual(manifest['dependencies'], {'fixture-0': '2.0.0', 'fixture-1': '1.0.0'})
            self.assertEqual(lock['packages']['']['dependencies'], manifest['dependencies'])
            self.assertEqual(lock['packages']['node_modules/fixture-0']['version'], '2.0.0')

    def test_disk_counts_hardlink_inode_once_but_logical_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'a').write_bytes(b'x' * 8192)
            single = bench.disk_usage(root)
            os.link(root / 'a', root / 'b')
            double = bench.disk_usage(root)
            self.assertEqual(double['file_logical_bytes'], single['file_logical_bytes'] * 2)
            self.assertEqual(double['inode_deduplicated_stat_blocks_bytes'], single['inode_deduplicated_stat_blocks_bytes'])

    def test_successful_exit_with_missing_output_fails_and_stops_cohort(self):
        packages = {'fixture-0': {v: bench.archive('fixture-0', v, 1) for v in ('1.0.0', '2.0.0')}}
        registry = SimpleNamespace(server_port=1, reset=lambda: None, stats=lambda: {})
        args = SimpleNamespace(binary=Path('/unused'), jobs=1, timeout=1)
        child = {'exit_code': 0, 'user_cpu_seconds': 0, 'system_cpu_seconds': 0, 'child_max_rss_bytes': 1}
        with tempfile.TemporaryDirectory() as tmp, patch.object(bench, 'install', return_value=child):
            reports = bench.cohort(args, Path(tmp), 1, packages, registry)
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]['scenario'], 'cold')
        self.assertFalse(reports[0]['ok'])
        self.assertTrue(reports[0]['validation_errors'][0])

    def test_child_failure_and_timeout_cannot_be_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            child = root / 'child'
            child.write_text('#!/bin/sh\necho failed >&2\nexit 7\n')
            child.chmod(0o755)
            result = bench.install(child, root, root, os.environ.copy(), 1, 2)
            self.assertEqual(result['exit_code'], 7)
            self.assertFalse(result['timed_out'])
            self.assertIn('failed', result['stderr_tail'])
            child.write_text('#!/bin/sh\nsleep 10\n')
            result = bench.install(child, root, root, os.environ.copy(), 1, 0.05)
            self.assertTrue(result['timed_out'])
            self.assertNotEqual(result['exit_code'], 0)
            self.assertLess(result['wall_ms'], 2000)


if __name__ == '__main__':
    unittest.main()
