"""
WattWise Multi-Format Bill & Telemetry Ingestion Engine.
Supports:
  - CSV files (.csv, .tsv, .txt) with timestamp, kwh interval data
  - Image energy bills (.png, .jpg, .jpeg, .webp, .bmp) via Nemotron Vision with local fallback
  - PDF bills (.pdf) via PyPDF text extraction and Nemotron NLP/Vision with local fallback
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from datetime import datetime, timedelta
from typing import Any

import httpx
import numpy as np
import pandas as pd
from pypdf import PdfReader

logger = logging.getLogger("wattwise.bill_parser")

BASE_URL = os.getenv("NEBIUS_BASE_URL", "https://integrate.api.nvidia.com/v1/").rstrip("/") + "/"
VISION_MODEL = os.getenv("WATTWISE_VISION_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b")
FALLBACK_VISION_MODEL = "meta/llama-3.2-11b-vision-instruct"
TEXT_MODEL = os.getenv("NEBIUS_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")
API_KEY = os.getenv("NEBIUS_API_KEY", "")


def get_default_bill_metadata(filename: str = "electricity_bill.png") -> dict[str, Any]:
    """Generates a reliable default bill structure when cloud vision is unavailable."""
    now = datetime.now()
    start = now - timedelta(days=30)
    # deterministic seed from filename
    name_hash = abs(hash(filename))
    total_kwh = 350.0 + (name_hash % 300)
    tariff = 8.0
    return {
        "provider": "Utility Electricity Board",
        "consumer_id": f"EB-{name_hash % 900000 + 100000}",
        "bill_date": now.strftime("%Y-%m-%d"),
        "billing_period_start": start.strftime("%Y-%m-%d"),
        "billing_period_end": now.strftime("%Y-%m-%d"),
        "days": 30,
        "total_kwh": float(total_kwh),
        "offpeak_night_kwh": round(total_kwh * 0.28, 1),
        "day_kwh": round(total_kwh * 0.72, 1),
        "tariff_rate": tariff,
        "total_amount": round(total_kwh * tariff, 2),
        "extraction_method": "utility_baseline_fallback"
    }


def synthesize_telemetry_from_bill(
    bill_data: dict[str, Any], default_rate: float = 8.0
) -> pd.DataFrame:
    """
    Synthesize realistic hourly meter interval telemetry (timestamp, kwh)
    from extracted bill parameters, preserving total consumption and off-peak ratios.
    """
    total_kwh = float(bill_data.get("total_kwh") or 350.0)
    days = int(bill_data.get("days") or 30)
    if days <= 0 or days > 365:
        days = 30

    start_str = bill_data.get("billing_period_start")
    start_dt = None
    if start_str:
        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y"):
            try:
                start_dt = datetime.strptime(str(start_str).strip(), fmt)
                break
            except Exception:
                pass

    if not start_dt:
        start_dt = datetime.now() - timedelta(days=days)

    offpeak_kwh = bill_data.get("offpeak_night_kwh")
    day_kwh = bill_data.get("day_kwh")

    if offpeak_kwh is not None and day_kwh is not None:
        try:
            offpeak_kwh = float(offpeak_kwh)
            day_kwh = float(day_kwh)
        except Exception:
            offpeak_kwh = total_kwh * 0.28
            day_kwh = total_kwh * 0.72
    else:
        offpeak_kwh = total_kwh * 0.28
        day_kwh = total_kwh * 0.72

    records: list[dict[str, Any]] = []
    daily_night = max(0.1, offpeak_kwh / days)
    daily_day = max(0.1, day_kwh / days)

    np.random.seed(int(total_kwh) % 1000 + days)
    for d in range(days):
        cur_date = start_dt + timedelta(days=d)
        has_night_anomaly = d in [max(1, days // 3), max(2, (2 * days) // 3)]
        for h in range(24):
            ts = cur_date.replace(hour=h, minute=0, second=0)
            if 0 <= h < 6:
                val = (daily_night / 6.0) * (0.92 + 0.16 * np.random.rand())
                if has_night_anomaly and h in [2, 3]:
                    val += (daily_night / 6.0) * 1.8
            else:
                peak_factor = 1.0 + 0.45 * np.sin(((h - 6) / 18.0) * np.pi)
                val = (daily_day / 18.0) * peak_factor * (0.92 + 0.16 * np.random.rand())

            records.append({"timestamp": ts.isoformat() + "Z", "kwh": max(0.01, float(val))})

    df = pd.DataFrame(records)
    current_sum = df["kwh"].sum()
    if current_sum > 0:
        df["kwh"] = df["kwh"] * (total_kwh / current_sum)
    return df


def extract_json_from_text(raw_text: str) -> dict[str, Any]:
    """Extract valid JSON from LLM markdown response."""
    match = re.search(r"```json\s*(.*?)\s*```", raw_text, re.DOTALL)
    if match:
        raw_json = match.group(1).strip()
    else:
        match_brace = re.search(r"\{.*\}", raw_text, re.DOTALL)
        raw_json = match_brace.group(0).strip() if match_brace else raw_text.strip()

    try:
        return json.loads(raw_json)
    except Exception as exc:
        out = {}
        for key in ["total_kwh", "total_amount", "tariff_rate", "days", "offpeak_night_kwh", "day_kwh"]:
            num_match = re.search(rf'"{key}"\s*:\s*([0-9\.]+)', raw_json)
            if num_match:
                try:
                    out[key] = float(num_match.group(1))
                except Exception:
                    pass
        for str_key in ["provider", "consumer_id", "billing_period_start", "billing_period_end", "bill_date"]:
            str_match = re.search(rf'"{str_key}"\s*:\s*"([^"]+)"', raw_json)
            if str_match:
                out[str_key] = str_match.group(1)
        if out.get("total_kwh"):
            return out
        raise ValueError(f"Could not parse valid bill JSON from response: {raw_text[:200]}") from exc


async def parse_bill_image(
    image_bytes: bytes, mime_type: str = "image/png", filename: str = "bill.png"
) -> dict[str, Any]:
    """Parse electricity bill image with NVIDIA Nemotron Vision, falling back reliably if needed."""
    key = os.getenv("NEBIUS_API_KEY", API_KEY)
    if not key:
        logger.warning("No API key configured. Using baseline bill synthesis.")
        return get_default_bill_metadata(filename)

    b64_img = base64.b64encode(image_bytes).decode("utf-8")
    prompt = (
        "You are an expert energy auditor and OCR bill parser. "
        "Analyze this electricity/utility bill image and extract the numerical and account data into a valid JSON object.\n"
        "Required JSON schema:\n"
        "{\n"
        '  "provider": "Utility provider name or Electricity Board",\n'
        '  "consumer_id": "Consumer account number or meter number",\n'
        '  "bill_date": "YYYY-MM-DD",\n'
        '  "billing_period_start": "YYYY-MM-DD",\n'
        '  "billing_period_end": "YYYY-MM-DD",\n'
        '  "days": integer,\n'
        '  "total_kwh": float,\n'
        '  "offpeak_night_kwh": float or null,\n'
        '  "day_kwh": float or null,\n'
        '  "tariff_rate": float,\n'
        '  "total_amount": float\n'
        "}\n"
        "Output ONLY the JSON object inside ```json ... ``` tags."
    )

    models_to_try = [VISION_MODEL, FALLBACK_VISION_MODEL]

    for model in models_to_try:
        payload = {
            "model": model,
            "max_tokens": 1200,
            "temperature": 0.1,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64_img}"}},
                    ],
                }
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(35.0, connect=8.0)) as client:
                res = await client.post(
                    BASE_URL + "chat/completions",
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json=payload,
                )
                if res.status_code == 200:
                    data = res.json()
                    choice = data["choices"][0]["message"]
                    content = choice.get("content") or choice.get("reasoning_content") or ""
                    parsed = extract_json_from_text(content)
                    parsed["extraction_method"] = "nemotron_vision"
                    return parsed
        except Exception as exc:
            logger.warning(f"Vision model {model} attempt failed: {exc}")
            continue

    # Fallback to smart baseline if cloud vision call timed out or was rate limited
    logger.info("Vision models unavailable or rate limited. Falling back to default bill model.")
    return get_default_bill_metadata(filename)


async def parse_bill_pdf(pdf_bytes: bytes, filename: str = "bill.pdf") -> dict[str, Any]:
    """Extract text or images from PDF bill and parse with Nemotron."""
    key = os.getenv("NEBIUS_API_KEY", API_KEY)
    if not key:
        return get_default_bill_metadata(filename)

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        full_text = ""
        for page in reader.pages:
            txt = page.extract_text()
            if txt:
                full_text += txt + "\n"

        if len(full_text.strip()) > 40:
            prompt = (
                "You are an expert energy auditor. Extract electricity bill fields from this bill text into JSON:\n"
                "{\n"
                '  "provider": "Utility provider name",\n'
                '  "consumer_id": "Consumer account / meter number",\n'
                '  "bill_date": "YYYY-MM-DD",\n'
                '  "billing_period_start": "YYYY-MM-DD",\n'
                '  "billing_period_end": "YYYY-MM-DD",\n'
                '  "days": integer,\n'
                '  "total_kwh": float,\n'
                '  "offpeak_night_kwh": float or null,\n'
                '  "day_kwh": float or null,\n'
                '  "tariff_rate": float,\n'
                '  "total_amount": float\n'
                "}\n"
                f"Bill Text:\n{full_text[:4000]}\n"
                "Output ONLY the JSON object inside ```json ... ``` tags."
            )
            payload = {
                "model": TEXT_MODEL,
                "max_tokens": 1200,
                "temperature": 0.1,
                "chat_template_kwargs": {"enable_thinking": False},
                "messages": [
                    {"role": "system", "content": "You are a precise data extraction specialist."},
                    {"role": "user", "content": prompt},
                ],
            }
            async with httpx.AsyncClient(timeout=httpx.Timeout(35.0, connect=8.0)) as client:
                res = await client.post(
                    BASE_URL + "chat/completions",
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json=payload,
                )
                if res.status_code == 200:
                    content = res.json()["choices"][0]["message"]
                    raw = content.get("content") or content.get("reasoning_content") or ""
                    parsed = extract_json_from_text(raw)
                    parsed["extraction_method"] = "pypdf_nemotron_text"
                    return parsed
    except Exception as exc:
        logger.warning(f"PDF text parse attempt failed: {exc}")

    # Scanned PDF fallback
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        for page in reader.pages:
            for img in page.images:
                return await parse_bill_image(img.data, mime_type="image/png", filename=filename)
    except Exception:
        pass

    return get_default_bill_metadata(filename)


async def process_uploaded_bill_or_csv(
    file_bytes: bytes, filename: str
) -> tuple[pd.DataFrame, str, dict[str, Any] | None, str]:
    """
    Unified dispatcher for CSV, Image, and PDF bill files.
    Returns: (DataFrame, csv_text_representation, bill_metadata_or_none, file_type)
    """
    lower = filename.lower()

    # 1. CSV or TSV files
    if lower.endswith((".csv", ".txt", ".tsv")):
        try:
            csv_text = file_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            csv_text = file_bytes.decode("latin1")
        sep = "\t" if lower.endswith(".tsv") else ","
        df = pd.read_csv(io.StringIO(csv_text), sep=sep)
        return df, csv_text, None, "csv"

    # 2. Image files (PNG, JPG, JPEG, WEBP, BMP)
    if lower.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff")):
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".tiff": "image/tiff",
        }
        ext = os.path.splitext(lower)[1]
        mime = mime_map.get(ext, "image/png")

        bill_data = await parse_bill_image(file_bytes, mime_type=mime, filename=filename)
        df = synthesize_telemetry_from_bill(bill_data)
        csv_text = df.to_csv(index=False)
        return df, csv_text, bill_data, "bill_image"

    # 3. PDF files
    if lower.endswith(".pdf"):
        bill_data = await parse_bill_pdf(file_bytes, filename=filename)
        df = synthesize_telemetry_from_bill(bill_data)
        csv_text = df.to_csv(index=False)
        return df, csv_text, bill_data, "bill_pdf"

    raise ValueError(
        f"Unsupported file format '{filename}'. Please upload a CSV, PNG, JPG, JPEG, WEBP, or PDF electricity bill."
    )
