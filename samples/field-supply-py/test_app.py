import os
import unittest

from app import archive


class ArchiveTests(unittest.TestCase):
    def test_normal_input_archives(self):
        self.assertEqual(archive("report"), "done")

    def test_rejects_command_injection(self):
        marker = "/tmp/hex_sample_injected"
        try:
            os.remove(marker)
        except OSError:
            pass
        archive("nothing; touch " + marker)
        self.assertFalse(os.path.exists(marker))
