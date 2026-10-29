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

from app.bill_parser import synthesize_telemetry_from_bill, process_uploaded_bill_or_csv
from engine.energy_analysis import analyze_energy, AnalysisConfig


class BillIngestionTests(unittest.IsolatedAsyncioTestCase):
    def test_synthesize_telemetry_from_bill(self):
        bill_data = {
            "total_kwh": 600.0,
            "days": 30,
            "billing_period_start": "2026-09-01",
            "offpeak_night_kwh": 180.0,
            "day_kwh": 420.0
        }
        df = synthesize_telemetry_from_bill(bill_data)
        self.assertEqual(len(df), 30 * 24)
        self.assertAlmostEqual(df['kwh'].sum(), 600.0, places=2)

        res = analyze_energy(df, AnalysisConfig(electricity_rate=8.0, avoidable_percent=50))
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(res['summary']['days_covered'], 30)
        self.assertAlmostEqual(res['summary']['total_energy_kwh'], 600.0, places=1)

    async def test_process_csv(self):
        csv_bytes = b"timestamp,kwh\n2026-10-01T00:00:00Z,2\n2026-10-01T01:00:00Z,3\n2026-10-01T02:00:00Z,2\n"
        df, csv_text, meta, ftype = await process_uploaded_bill_or_csv(csv_bytes, "meter.csv")
        self.assertEqual(ftype, "csv")
        self.assertIsNone(meta)
        self.assertEqual(len(df), 3)

    async def test_process_png_bill(self):
        # Create a small valid test PNG
        img = Image.new('RGB', (400, 200), color=(255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw.text((10, 10), "TEST UTILITY BILL", fill=(0, 0, 0))
        draw.text((10, 40), "Total Consumption: 300 kWh", fill=(0, 0, 0))
        draw.text((10, 70), "Tariff: Rs 8.00 / kWh", fill=(0, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        png_bytes = buf.getvalue()

        # Should extract or gracefully synthesize
        df, csv_text, meta, ftype = await process_uploaded_bill_or_csv(png_bytes, "test_bill.png")
        self.assertEqual(ftype, "bill_image")
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 10)


if __name__ == '__main__':
    unittest.main()
