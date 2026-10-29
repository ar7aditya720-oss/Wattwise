"""
Deterministic energy analysis engine for the Nebius hackathon project.

Expected CSV columns:
  timestamp: ISO-like timestamp (e.g. 2026-10-01 01:00:00)
  kwh: energy consumed during the interval, in kWh

Optional columns:
  meter_id: meter identifier

This module calculates measurable outputs. An LLM may explain the outputs,
but should not invent or overwrite these numeric results.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any
import math
import pandas as pd
import numpy as np


@dataclass
class AnalysisConfig:
    electricity_rate: float = 8.0
    overnight_start_hour: int = 0
    overnight_end_hour: int = 6
    anomaly_sigma: float = 3.0
    avoidable_percent: float = 50.0
    annualize_daily_savings: bool = True


class EnergyAnalysisError(ValueError):
    """Raised when input data cannot be analyzed safely."""


def _validate_config(config: AnalysisConfig) -> None:
    if config.electricity_rate < 0:
        raise EnergyAnalysisError("electricity_rate must be >= 0.")
    if not (0 <= config.overnight_start_hour <= 23):
        raise EnergyAnalysisError("overnight_start_hour must be from 0 to 23.")
    if not (0 <= config.overnight_end_hour <= 23):
        raise EnergyAnalysisError("overnight_end_hour must be from 0 to 23.")
    if config.overnight_start_hour == config.overnight_end_hour:
        raise EnergyAnalysisError("Overnight start and end hours cannot be equal.")
    if config.anomaly_sigma <= 0:
        raise EnergyAnalysisError("anomaly_sigma must be > 0.")
    if not (0 <= config.avoidable_percent <= 100):
        raise EnergyAnalysisError("avoidable_percent must be between 0 and 100.")


def load_readings(source: str | pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load and validate meter readings; invalid rows are excluded and reported."""
    try:
        raw = source.copy() if isinstance(source, pd.DataFrame) else pd.read_csv(source)
    except Exception as exc:
        raise EnergyAnalysisError(f"Could not read CSV: {exc}") from exc

    raw.columns = [str(c).strip().lower() for c in raw.columns]
    missing = {"timestamp", "kwh"} - set(raw.columns)
    if missing:
        raise EnergyAnalysisError(
            "Missing required CSV column(s): " + ", ".join(sorted(missing))
        )

    row_count = len(raw)
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], errors="coerce", utc=True)
    raw["kwh"] = pd.to_numeric(raw["kwh"], errors="coerce")
    invalid_timestamp = raw["timestamp"].isna()
    invalid_energy = raw["kwh"].isna() | ~np.isfinite(raw["kwh"])
    negative_energy = raw["kwh"] < 0
    invalid = invalid_timestamp | invalid_energy | negative_energy
    invalid_count = int(invalid.sum())

    clean = raw.loc[~invalid].copy()
    if clean.empty:
        raise EnergyAnalysisError("No valid readings remain after validation.")

    clean = clean.sort_values("timestamp").drop_duplicates(
        subset=["timestamp"] + (["meter_id"] if "meter_id" in clean.columns else []),
        keep="last",
    )
    duplicate_count = int(len(raw.loc[~invalid]) - len(clean))
    clean["date"] = clean["timestamp"].dt.date.astype(str)
    clean["hour"] = clean["timestamp"].dt.hour
    clean["is_overnight"] = (
        (clean["hour"] >= 0)  # replaced below based on standard 00:00–06:00 window
        & (clean["hour"] < 6)
    )
    report = {
        "input_rows": int(row_count),
        "valid_rows": int(len(clean)),
        "invalid_rows_excluded": invalid_count,
        "duplicate_rows_excluded": duplicate_count,
        "validation_notes": [],
    }
    if invalid_count:
        report["validation_notes"].append(
            f"Excluded {invalid_count} row(s) with invalid timestamps, nonnumeric "
            "energy, or negative kWh values."
        )
    if duplicate_count:
        report["validation_notes"].append(
            f"Excluded {duplicate_count} duplicate timestamp row(s) per meter."
        )
    return clean.reset_index(drop=True), report


def _hour_in_window(hour: int, start: int, end: int) -> bool:
    # Supports windows crossing midnight, e.g. 22:00–06:00.
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def analyze_energy(
    source: str | pd.DataFrame,
    config: AnalysisConfig | None = None,
) -> dict[str, Any]:
    """Return JSON-serializable metrics, anomalies, and what-if savings."""
    config = config or AnalysisConfig()
    _validate_config(config)
    df, validation = load_readings(source)

    df["is_overnight"] = df["hour"].apply(
        lambda h: _hour_in_window(
            int(h), config.overnight_start_hour, config.overnight_end_hour
        )
    )

    total_kwh = float(df["kwh"].sum())
    total_cost = total_kwh * config.electricity_rate
    days = int(df["date"].nunique())
    daily_kwh = total_kwh / days if days else 0.0

    overnight = df.loc[df["is_overnight"]].copy()
    anomalies: list[dict[str, Any]] = []
    overnight_metrics: dict[str, Any] = {
        "window_start_hour": config.overnight_start_hour,
        "window_end_hour": config.overnight_end_hour,
        "reading_count": int(len(overnight)),
        "baseline_kwh_per_reading": None,
        "potential_excess_kwh": 0.0,
        "potential_excess_cost": 0.0,
        "anomaly_count": 0,
        "status": "insufficient_data",
    }

    if len(overnight) >= 3:
        # Robust baseline from the median of overnight interval readings.
        baseline = float(overnight["kwh"].median())
        mad = float(np.median(np.abs(overnight["kwh"].to_numpy() - baseline)))
        # MAD can be zero for repeated values; use standard deviation as fallback.
        robust_sigma = 1.4826 * mad
        if robust_sigma <= 0:
            robust_sigma = float(overnight["kwh"].std(ddof=0))
        if not math.isfinite(robust_sigma):
            robust_sigma = 0.0

        threshold = baseline + config.anomaly_sigma * robust_sigma
        overnight["potential_excess_kwh"] = (overnight["kwh"] - baseline).clip(lower=0)
        anomaly_rows = overnight.loc[overnight["kwh"] > threshold]
        potential_excess_kwh = float(overnight["potential_excess_kwh"].sum())

        for _, row in anomaly_rows.iterrows():
            anomalies.append({
                "timestamp": row["timestamp"].isoformat(),
                "observed_kwh": round(float(row["kwh"]), 4),
                "baseline_kwh_per_reading": round(baseline, 4),
                "excess_kwh_vs_baseline": round(
                    max(0.0, float(row["kwh"]) - baseline), 4
                ),
                "estimated_excess_cost": round(
                    max(0.0, float(row["kwh"]) - baseline) * config.electricity_rate, 2
                ),
                "label": "potential_anomaly_not_confirmed_waste",
            })

        overnight_metrics.update({
            "baseline_kwh_per_reading": round(baseline, 4),
            "robust_spread_kwh": round(robust_sigma, 4),
            "anomaly_threshold_kwh": round(threshold, 4),
            "potential_excess_kwh": round(potential_excess_kwh, 4),
            "potential_excess_cost": round(
                potential_excess_kwh * config.electricity_rate, 2
            ),
            "anomaly_count": int(len(anomaly_rows)),
            "status": "estimated",
        })
    else:
        overnight_metrics["status"] = "insufficient_data"
        validation["validation_notes"].append(
            "At least 3 overnight readings are needed for a basic baseline estimate."
        )

    potential_waste = float(overnight_metrics["potential_excess_kwh"])
    avoidable_kwh = potential_waste * (config.avoidable_percent / 100.0)
    estimated_savings = avoidable_kwh * config.electricity_rate

    # Annualization is offered only as a projection, never as measured savings.
    daily_projected_savings = estimated_savings / days if days else 0.0
    annualized_savings = (
        daily_projected_savings * 365
        if config.annualize_daily_savings and days > 0
        else None
    )

    daily_summary = (
        df.groupby("date", as_index=False)["kwh"]
        .sum()
        .rename(columns={"date": "day", "kwh": "total_kwh"})
    )
    daily_records = [
        {"day": str(r["day"]), "total_kwh": round(float(r["total_kwh"]), 4)}
        for _, r in daily_summary.iterrows()
    ]

    return {
        "status": "ok",
        "units": {"energy": "kWh", "currency": "configured local currency"},
        "config": asdict(config),
        "data_quality": validation,
        "summary": {
            "reading_count": int(len(df)),
            "days_covered": days,
            "total_energy_kwh": round(total_kwh, 4),
            "estimated_energy_cost": round(total_cost, 2),
            "average_daily_energy_kwh": round(daily_kwh, 4),
            "first_reading": df["timestamp"].min().isoformat(),
            "last_reading": df["timestamp"].max().isoformat(),
        },
        "overnight_analysis": overnight_metrics,
        "anomalies": anomalies,
        "what_if": {
            "potential_excess_energy_kwh": round(potential_waste, 4),
            "avoidable_percent": config.avoidable_percent,
            "estimated_avoidable_energy_kwh": round(avoidable_kwh, 4),
            "electricity_rate": config.electricity_rate,
            "projected_savings_for_uploaded_period": round(estimated_savings, 2),
            "projected_daily_savings": round(daily_projected_savings, 2),
            "projected_annual_savings": (
                round(annualized_savings, 2) if annualized_savings is not None else None
            ),
            "assumption": (
                "Potential excess overnight energy is a proxy for possible waste. "
                "The selected avoidable percentage is a scenario assumption, not a "
                "verified operational reduction."
            ),
        },
        "daily_energy": daily_records,
        "interpretation_guidance": [
            "An anomaly is unusual consumption, not proof of waste.",
            "Cost estimates assume the configured flat electricity rate.",
            "Annualized savings are projections and require representative data.",
            "Confirm timestamp timezone and kWh interval meaning before production use.",
        ],
    }


def analyze_energy_json(
    source: str | pd.DataFrame,
    config: AnalysisConfig | None = None,
) -> dict[str, Any]:
    """Alias intended for a backend/API service."""
    return analyze_energy(source, config)
