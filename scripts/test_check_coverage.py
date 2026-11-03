"""Focused tests for scripts.check_coverage."""

import unittest

from scripts.check_coverage import (
    check_coverage,
    expand_feature_references,
)


class CoverageParsingTests(unittest.TestCase):
    def test_rejects_missing_feature_table(self) -> None:
        with self.assertRaises(ValueError):
            check_coverage('# No feature table', '')

    def test_expands_ranges_and_ignores_non_feature_text(self) -> None:
        self.assertEqual(
            expand_feature_references("D4–D6, (I19), plus M7-M8"),
            {"D4", "D5", "D6", "I19", "M7", "M8"},
        )

    def test_only_reports_uncovered_in_scope_features(self) -> None:
        features = """| Mã | Tên | Mức |
|---|---|---|
| A1 | Start | v0.1 |
| A2 | Future | Sau 1.0 |
| B1 | Viewer | v0.10 |"""
        tasks = """| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T1.01 | Start | A1 | 1 | | ✅ |"""
        missing, total, covered = check_coverage(features, tasks)
        self.assertEqual((missing, total, covered), (["B1"], 2, 1))


if __name__ == "__main__":
    unittest.main()
