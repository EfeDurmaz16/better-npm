"""Paired evidence harness checks, not native performance measurements."""
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import paired_worktrees as bench


class PairedTests(unittest.TestCase):
    def packages(self):
        return {f'fixture-{i}': {v: bench.common.archive(f'fixture-{i}', v, 64)
                                for v in ('1.0.0', '2.0.0')} for i in range(2)}

    def test_payload_is_unique_across_package_and_version(self):
        payloads = [item[1]['payload.bin'] for versions in self.packages().values() for item in versions.values()]
        self.assertEqual(len(set(payloads)), 4)

    def test_registry_counts_metadata_tarball_and_unknown_routes(self):
        registry = bench.Registry(self.packages(), 0)
        thread = threading.Thread(target=registry.serve_forever, daemon=True)
        thread.start()
        try:
            root = f'http://127.0.0.1:{registry.server_port}'
            with urllib.request.urlopen(root + '/fixture-0') as response:
                metadata = json.load(response)
            self.assertEqual(metadata['time']['1.0.0'], '2020-01-01T00:00:00.000Z')
            with urllib.request.urlopen(root + '/fixture-0-1.0.0.tgz') as response:
                self.assertTrue(response.read())
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(root + '/unknown')
            stats = registry.stats()
            self.assertEqual(stats['requests'], 3)
            self.assertEqual(stats['metadata_requests'], 1)
            self.assertEqual(stats['tarball_requests'], 1)
            self.assertEqual(stats['unknown_routes'], ['/unknown'])
            registry.reset()
            self.assertEqual(registry.stats()['requests'], 0)
        finally:
            registry.shutdown()
            registry.server_close()
            thread.join()

    def test_default_policy_requires_local_metadata_even_with_valid_files(self):
        registry = SimpleNamespace(server_port=1, reset=lambda: None,
            stats=lambda: {'unknown_routes': [], 'routes': {}, 'metadata_requests': 0})
        child = {'exit_code': 0, 'timed_out': False, 'user_cpu_seconds': 0,
                 'system_cpu_seconds': 0, 'child_max_rss_bytes': 1}
        args = SimpleNamespace(jobs=1, timeout=1)
        with tempfile.TemporaryDirectory() as tmp, patch.object(bench.common, 'install', return_value=child), patch.object(bench.common, 'validate', return_value=[]):
            entries = bench.cohort(args, Path('/unused'), Path(tmp), 1, self.packages(), registry, True)
            self.assertFalse((Path(tmp) / 'project-0/.better-firewall.json').exists())
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]['ok'])
        self.assertIn('local metadata', entries[0]['evidence_errors'][0])


if __name__ == '__main__':
    unittest.main()
