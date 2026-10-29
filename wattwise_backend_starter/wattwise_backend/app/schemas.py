from pydantic import BaseModel, Field
class AnalysisConfigIn(BaseModel):
    electricity_rate: float = Field(8.0, ge=0, le=1000000)
    overnight_start_hour: int = Field(0, ge=0, le=23)
    overnight_end_hour: int = Field(6, ge=0, le=23)
    anomaly_sigma: float = Field(3.0, gt=0, le=100)
    avoidable_percent: float = Field(50.0, ge=0, le=100)
    annualize_daily_savings: bool = True
class WhatIfIn(AnalysisConfigIn):
    pass
