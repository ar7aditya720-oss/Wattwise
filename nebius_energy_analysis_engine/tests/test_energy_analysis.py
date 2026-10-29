import os
import sys
import unittest
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from engine.energy_analysis import (
    AnalysisConfig, EnergyAnalysisError, analyze_energy, load_readings
)


class EnergyAnalysisTests(unittest.TestCase):
    def test_total_energy_and_cost(self):
        df = pd.DataFrame({
            "timestamp": pd.date_range("2026-10-01", periods=8, freq="h", tz="UTC"),
            "kwh": [1, 2, 1, 1, 1, 1, 1, 2],
        })
        result = analyze_energy(df, AnalysisConfig(electricity_rate=10))
        self.assertEqual(result["summary"]["total_energy_kwh"], 10.0)
        self.assertEqual(result["summary"]["estimated_energy_cost"], 100.0)

    def test_invalid_rows_excluded(self):
        df = pd.DataFrame({
            "timestamp": ["2026-10-01T00:00:00Z", "not-a-date", "2026-10-01T02:00:00Z"],
            "kwh": [2, 5, -1],
        })
        clean, report = load_readings(df)
        self.assertEqual(len(clean), 1)
        self.assertEqual(report["invalid_rows_excluded"], 2)

    def test_missing_required_column(self):
        with self.assertRaises(EnergyAnalysisError):
            analyze_energy(pd.DataFrame({"timestamp": ["2026-10-01"], "power": [3]}))

    def test_avoidable_percent_validation(self):
        with self.assertRaises(EnergyAnalysisError):
            analyze_energy(
                pd.DataFrame({
                    "timestamp": pd.date_range("2026-10-01", periods=4, freq="h", tz="UTC"),
                    "kwh": [1, 2, 3, 4],
                }),
                AnalysisConfig(avoidable_percent=120),
            )

    def test_savings_scenario_changes_with_percentage(self):
        df = pd.DataFrame({
            "timestamp": pd.date_range("2026-10-01", periods=24, freq="h", tz="UTC"),
            "kwh": [1.0] * 24,
        })
        a = analyze_energy(df, AnalysisConfig(avoidable_percent=25))
        b = analyze_energy(df, AnalysisConfig(avoidable_percent=75))
        self.assertLessEqual(
            a["what_if"]["projected_savings_for_uploaded_period"],
            b["what_if"]["projected_savings_for_uploaded_period"],
        )


if __name__ == "__main__":
    unittest.main()
