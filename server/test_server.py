import json
import tempfile
import unittest
from pathlib import Path

from server import atomic_json_write, safe_rel_path, safe_vault_name


class ServerHelpersTest(unittest.TestCase):
    def test_safe_paths(self):
        self.assertEqual(safe_rel_path("notes/%E4%BB%8A%E5%A4%A9.md"), "notes/今天.md")
        with self.assertRaises(ValueError):
            safe_rel_path("../secret.txt")
        with self.assertRaises(ValueError):
            safe_rel_path("/absolute.txt")

    def test_vault_name(self):
        self.assertEqual(safe_vault_name("obsidian-vault"), "obsidian-vault")
        with self.assertRaises(ValueError):
            safe_vault_name("../vault")

    def test_atomic_json_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "latest.json"
            atomic_json_write(target, {"snapshotId": "a"})
            self.assertEqual(json.loads(target.read_text()), {"snapshotId": "a"})


if __name__ == "__main__":
    unittest.main()
