# Nebius Hackathon — Energy Analysis Engine

A standalone, deterministic Python module for the project's second part: data validation,
energy/cost calculations, overnight baseline estimation, anomaly detection, and what-if
savings. It is designed to be integrated into the existing Antigravity backend.

## Files

- `engine/energy_analysis.py` — reusable calculation engine
- `tests/test_energy_analysis.py` — basic tests
- `data/sample_energy_readings.csv` — small demo dataset

## Install

```bash
pip install pandas numpy
```

## Quick use

```python
from engine.energy_analysis import AnalysisConfig, analyze_energy

result = analyze_energy(
    "data/sample_energy_readings.csv",
    AnalysisConfig(
        electricity_rate=8.0,
        overnight_start_hour=0,
        overnight_end_hour=6,
        avoidable_percent=50,
    ),
)

print(result["summary"])
print(result["overnight_analysis"])
print(result["what_if"])
```

For a FastAPI route, call `analyze_energy()` after the uploaded CSV has been safely saved
to a temporary path. Return its dictionary as the JSON response. Do not pass API keys or
untrusted file paths into this module.

## CSV format

Required columns:
- `timestamp`: timestamp parseable by pandas; timezone-aware timestamps are recommended
- `kwh`: non-negative energy in kWh for each measurement interval

Optional:
- `meter_id`: identifies separate meters; duplicate timestamps are deduplicated per meter

## Current assumptions and limitations

1. The configured electricity rate is a flat rate in the currency used by your project.
2. The overnight baseline uses the median of readings in the selected overnight window.
3. Anomalies are readings above baseline + `anomaly_sigma` × robust spread (MAD-based).
4. Potential excess energy sums positive deviations from the baseline across overnight readings.
5. The avoidable percentage is a user-selected what-if assumption, not a measured outcome.
6. Annualized savings are projections. Do not describe them as guaranteed savings.
7. The sample logic assumes each `kwh` value represents interval energy, not instantaneous kW.
   If your source dataset instead reports kW, convert using interval duration first.
8. Timezone handling should be confirmed against the actual industrial dataset before production.

## Run tests

From this directory:

```bash
python -m unittest discover -s tests -v
```

## Suggested integration contract

`analyze_energy(source, config) -> dict`

The returned JSON-compatible object contains:
- `data_quality`
- `summary`
- `overnight_analysis`
- `anomalies`
- `what_if`
- `daily_energy`
- `interpretation_guidance`

Use Nemotron only to explain these returned results and recommend investigation steps.
Keep numeric values grounded in the engine output.
