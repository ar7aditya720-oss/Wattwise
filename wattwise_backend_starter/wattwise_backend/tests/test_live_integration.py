import io
import os
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw

backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv
load_dotenv(backend_dir / '.env')

import httpx
from app import database
from app.main import app


class LiveIntegrationTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        database.init_db()

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_full_pipeline(self):
        # 1. Health
        res_health = await self.client.get("/health")
        self.assertEqual(res_health.status_code, 200)
        self.assertEqual(res_health.json()["status"], "ok")

        # 2. Analyze CSV
        csv_path = backend_dir / "data" / "sample_energy_readings.csv"
        with open(csv_path, "rb") as f:
            csv_bytes = f.read()

        res_csv = await self.client.post(
            "/api/analyze",
            files={"file": ("sample_energy_readings.csv", csv_bytes, "text/csv")},
            data={"electricity_rate": "8.0", "avoidable_percent": "50.0"}
        )
        self.assertEqual(res_csv.status_code, 200, res_csv.text)

        # 3. Analyze PNG Bill
        img = Image.new('RGB', (600, 360), color=(255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw.text((20, 20), 'BANGALORE ELECTRICITY SUPPLY CO (BESCOM)', fill=(0, 0, 0))
        draw.text((20, 50), 'Total Units Consumed: 520 kWh', fill=(0, 0, 0))
        draw.text((20, 80), 'Off-Peak Night Energy: 155 kWh', fill=(0, 0, 0))
        draw.text((20, 110), 'Day Energy: 365 kWh', fill=(0, 0, 0))
        draw.text((20, 140), 'Tariff Rate: Rs 7.80 per kWh', fill=(0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format='PNG')

        res_png = await self.client.post(
            "/api/analyze",
            files={"file": ("bescom_bill.png", buf.getvalue(), "image/png")},
            data={"electricity_rate": "7.8", "avoidable_percent": "45.0"}
        )
        self.assertEqual(res_png.status_code, 200, res_png.text)
        png_json = res_png.json()
        png_id = png_json["id"]
        self.assertEqual(png_json["file_type"], "bill_image")

        # 4. History
        res_list = await self.client.get("/api/analyses?limit=10")
        self.assertEqual(res_list.status_code, 200)
        self.assertGreaterEqual(len(res_list.json()["items"]), 1)

        # 5. What-if
        res_what_if = await self.client.post(
            f"/api/analyses/{png_id}/what-if",
            json={"electricity_rate": 8.0, "avoidable_percent": 50.0, "overnight_start_hour": 0, "overnight_end_hour": 6, "anomaly_sigma": 3.0, "annualize_daily_savings": True}
        )
        self.assertEqual(res_what_if.status_code, 200)

        # 6. Explain
        res_explain = await self.client.post(f"/api/analyses/{png_id}/explain")
        self.assertEqual(res_explain.status_code, 200)
        self.assertGreater(len(res_explain.json()["explanation"]), 20)


if __name__ == "__main__":
    unittest.main()
