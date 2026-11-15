import configparser
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CasePreservingConfig(configparser.ConfigParser):
    def optionxform(self, optionstr: str) -> str:
        return optionstr


class NodeStoragePolicyTests(unittest.TestCase):
    def test_journal_has_bounded_persistent_and_runtime_storage(self):
        config = CasePreservingConfig()
        config.read(ROOT / "bootstrap/journald.conf")
        self.assertEqual(dict(config["Journal"]), {
            "SystemMaxUse": "512M",
            "SystemKeepFree": "25G",
            "SystemMaxFileSize": "64M",
            "RuntimeMaxUse": "128M",
            "MaxRetentionSec": "14day",
        })

    def test_image_gc_is_earlier_than_default_and_hysteretic(self):
        config = (ROOT / "bootstrap/k3s-config.yaml").read_text()
        high_match = re.search(r"image-gc-high-threshold=(\d+)", config)
        low_match = re.search(r"image-gc-low-threshold=(\d+)", config)
        assert high_match is not None
        assert low_match is not None
        high = int(high_match[1])
        low = int(low_match[1])
        self.assertEqual((high, low), (70, 50))
        self.assertLess(low, high)
        self.assertLess(high, 85)

    def test_bootstrap_installs_dropin_without_vacuuming_user_data(self):
        script = (ROOT / "bootstrap/bootstrap.sh").read_text()
        self.assertIn('"$REPO_DIR/bootstrap/journald.conf"', script)
        self.assertIn('/etc/systemd/journald.conf.d/90-homelab-storage.conf', script)
        self.assertIn('sudo systemctl restart systemd-journald', script)
        self.assertNotIn('journalctl --vacuum', script)
        self.assertNotIn('rm -rf /var/log', script)


if __name__ == "__main__":
    unittest.main()
